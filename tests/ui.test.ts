import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const script = await readFile("public/app.js", "utf8");
class Element {
  textContent = "";
  hidden = false;
  className = "";
  children: Element[] = [];
  attributes: Record<string, string> = {};
  classList = { toggle() {} };
  addEventListener() {}
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  replaceChildren() { this.children = []; }
  append(child: Element) { this.children.push(child); }
}
function dashboard() {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    let element = elements.get(id);
    if (!element) { element = new Element(); elements.set(id, element); }
    return element;
  };
  const ui = runInNewContext(`${script}
    ({ renderAvailability, renderState(next) { state = next; render(); } })`, {
    document: { getElementById: get, querySelectorAll: () => [], createElementNS: () => new Element() },
    Date: class extends Date { static now() { return 1_000_000; } },
    setInterval() {},
    fetch: async () => ({ ok: false, json: async () => ({ error: "Sign in to the booth" }) })
  }) as {
    renderAvailability(samples?: { at: number; ok: boolean }[]): void;
    renderState(state: Record<string, unknown>): void;
  };
  return { ...ui, get };
}
test("availability graph handles empty and expired history without inventing success", () => {
  const ui = dashboard();
  ui.renderAvailability();
  assert.equal(ui.get("availability-samples").children.length, 0);
  assert.equal(ui.get("availability-summary").textContent, "Waiting for checkout probes");
  ui.renderAvailability([{ at: 699_999, ok: true }, { at: 1_000_001, ok: true }]);
  assert.equal(ui.get("availability-samples").children.length, 0);
});
test("availability graph shows success, failure and recovery with gaps for missing probes", () => {
  const ui = dashboard();
  ui.renderAvailability([
    { at: 996_000, ok: true }, { at: 997_000, ok: false }, { at: 998_000, ok: true },
    { at: 1_000_000, ok: true }
  ]);
  const paths = ui.get("availability-samples").children;
  assert.equal(paths.length, 2);
  assert.equal(paths[0]!.attributes.class, "availability-up");
  assert.equal(paths[1]!.attributes.class, "availability-down");
  assert.match(paths[1]!.attributes.d!, /V 126/);
  assert.match(paths[0]!.attributes.d!, /V 28/);
  assert.equal(ui.get("availability-summary").textContent, "75.0% successful checks (4 samples)");
  assert.match(ui.get("availability-description").textContent, /Gaps indicate no recorded checks/);
  ui.renderAvailability([{ at: 990_000, ok: true }, { at: 1_000_000, ok: false }]);
  for (const path of ui.get("availability-samples").children) assert.doesNotMatch(path.attributes.d!, /[HV]/);
});
test("dashboard retains live checkout latency alongside availability history", () => {
  const ui = dashboard();
  ui.renderState({
    mode: "local", phase: "READY", role: "kiosk", events: [],
    lastProbe: { ok: true, latencyMs: 42, detail: "Synthetic checkout succeeded" },
    probeHistory: [{ at: 1_000_000, ok: true }]
  });
  assert.equal(ui.get("latency").textContent, "42 ms");
  assert.equal(ui.get("health").textContent, "CHECKOUT ONLINE");
  assert.equal(ui.get("availability-summary").textContent, "100.0% successful checks (1 sample)");
});
