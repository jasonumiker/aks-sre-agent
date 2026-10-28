import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { checkoutApp } from "../src/checkout.js";
import { Engine, probe } from "../src/engine.js";
import { baseline, fault, isBaseline, manifests, repair } from "../src/manifests.js";
import { AppError, initialState, type GitPort, type State, type Store, type TriggerPort, type Scenario } from "../src/domain.js";
import { LocalGit } from "../src/git.js";
import { FileStore } from "../src/store.js";
import { boothApp } from "../src/http.js";
import type { Config } from "../src/config.js";

const source = await readFile("gitops/apps/checkout/booth/patch.yaml", "utf8");
class MemoryStore implements Store {
  state = initialState();
  async read() { return structuredClone(this.state); }
  async change(fn: (state: State) => void) {
    const next = structuredClone(this.state);
    fn(next);
    this.state = next;
    return this.read();
  }
}
class MemoryGit implements GitPort {
  content = baseline(source);
  sha = "a".repeat(40);
  commits = 0;
  async read() { return { sha: this.sha, content: this.content, diff: "actual fixture diff" }; }
  async commit(expected: string, content: string, _message: string) {
    if (expected !== this.sha) throw new AppError(409, "Git head changed");
    this.content = content;
    this.sha = createHash("sha1").update(`${++this.commits}:${content}`).digest("hex");
    return this.sha;
  }
}
async function fixture(options: { trigger?: TriggerPort; timing?: { deadlineMs: number; healthyMs: number; healthyCount: number } } = {}) {
  const git = new MemoryGit();
  const store = new MemoryStore();
  let triggerCalls = 0;
  let context: Record<string, unknown> = {};
  const app = checkoutApp("conference");
  const server = createServer((req, res) => {
    if (!isBaseline(git.content)) { res.writeHead(503, { "content-type": "application/json" }).end("{}"); return; }
    app(req, res);
  }).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = {
    async refresh() {},
    async deployment() { return { synced: true, healthy: isBaseline(git.content), revision: git.sha, detail: "fixture" }; },
    async evidence() { return { service: manifests(git.content).service }; }
  };
  const trigger = options.trigger ?? { async invoke(value: Record<string, unknown>) {
    triggerCalls++; context = value; return { threadId: "test-thread" };
  } };
  const engine = new Engine(store, git, runtime, trigger, url, {},
    options.timing ?? { deadlineMs: 180_000, healthyMs: 0, healthyCount: 2 });
  return { engine, git, store, url, runtime, get triggerCalls() { return triggerCalls; },
    get context() { return context; },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function ready(engine: Engine) {
  await engine.reset(); await engine.tick(); await engine.tick();
  assert.equal((await engine.store.read()).phase, "READY");
}
const corrections = {
  port: { field: "targetPort" as const, value: 8080 },
  configuration: { field: "checkoutMode" as const, value: "conference" },
  scheduling: { field: "nodeSelector" as const, value: { "kubernetes.io/os": "linux" } }
};
for (const scenario of ["port", "configuration", "scheduling"] as const) {
  test(`${scenario}: real probe failure, trigger, Git correction, recovery and next run`, async t => {
    const f = await fixture(); t.after(() => f.close());
    await ready(f.engine);
    await f.engine.start(scenario);
    assert.equal((await probe(f.url)).ok, false);
    await f.engine.tick();
    const run = (await f.store.read()).run!;
    assert.equal(f.triggerCalls, 1);
    assert.equal(f.context.runId, run.id);
    assert.equal("scenario" in f.context, false);
    assert.equal("fix" in f.context, false);
    await f.engine.tick();
    assert.equal(f.triggerCalls, 1);
    await f.engine.applyRepair({ runId: run.id, expectedHead: run.expectedHead!, ...corrections[scenario],
      evidence: "Observed the manifest and live state mismatch in the affected component." });
    assert.equal((await f.store.read()).phase, "VERIFYING");
    await f.engine.tick();
    assert.equal((await f.store.read()).phase, "VERIFYING");
    await f.engine.tick();
    assert.equal((await f.store.read()).phase, "RECOVERED");
    await f.engine.tick();
    const state = await f.store.read();
    assert.equal(state.phase, "READY");
    assert.equal(state.history[0]?.repairActor, "agent");
    assert.ok(state.history[0]?.recoveredAt);
    assert.equal(isBaseline(f.git.content), true);
    const outcomes = state.probeHistory!.map(sample => sample.ok);
    assert.equal(outcomes[0], true);
    assert.ok(outcomes.includes(false));
    assert.equal(outcomes.at(-1), true);
  });
}
test("probe history supports old state, bounds retention, and survives reset and persistence", async t => {
  const f = await fixture(); t.after(() => f.close());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  delete f.store.state.probeHistory;
  await f.engine.tick();
  assert.deepEqual((await f.store.read()).probeHistory, [{ at: 1_000_000, ok: true }]);
  await f.store.change(s => {
    s.probeHistory = [
      { at: 699_999, ok: false },
      ...Array.from({ length: 301 }, (_, i) => ({ at: 700_000 + i * 1000, ok: true }))
    ];
  });
  await f.engine.tick();
  let samples = (await f.store.read()).probeHistory!;
  assert.equal(samples.length, 301);
  assert.ok(samples.every(sample => sample.at >= 700_000));
  t.mock.timers.setTime(1_301_000);
  await f.engine.tick();
  samples = (await f.store.read()).probeHistory!;
  assert.deepEqual(samples, [{ at: 1_301_000, ok: true }]);
  await f.engine.reset();
  assert.deepEqual((await f.store.read()).probeHistory, samples);
  const dir = await mkdtemp(join(tmpdir(), "booth-probe-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json");
  await new FileStore(file).change(s => { s.probeHistory = samples; });
  assert.deepEqual((await new FileStore(file).read()).probeHistory, samples);
});
test("verification requires both ten probes and ten seconds", async t => {
  const f = await fixture({ timing: { deadlineMs: 180_000, healthyMs: 10_000, healthyCount: 10 } });
  t.after(() => f.close());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  await f.engine.reset();
  for (let i = 0; i < 10; i++) await f.engine.tick();
  assert.equal((await f.store.read()).phase, "RESETTING", "probe count alone is insufficient");
  t.mock.timers.setTime(1_010_000);
  await f.engine.tick();
  assert.equal((await f.store.read()).phase, "READY");
});
test("concurrent visitors cannot inject two faults", async t => {
  const f = await fixture(); t.after(() => f.close()); await ready(f.engine);
  const results = await Promise.allSettled([f.engine.start("port"), f.engine.start("scheduling")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
});
test("stale run, head and out-of-scope repair values are rejected", async t => {
  const f = await fixture(); t.after(() => f.close()); await ready(f.engine);
  await f.engine.start("port"); await f.engine.tick();
  const run = (await f.store.read()).run!;
  const input = { runId: run.id, expectedHead: run.expectedHead!, ...corrections.port,
    evidence: "Observed wrong Service targetPort relative to the application port." };
  await assert.rejects(() => f.engine.applyRepair({ ...input, runId: randomUUID() }), /not authorized/);
  await assert.rejects(() => f.engine.applyRepair({ ...input, expectedHead: "b".repeat(40) }), /not authorized/);
  const before = f.git.sha;
  await assert.rejects(() => f.engine.applyRepair({ ...input, value: 22 }), /allowlist/);
  assert.equal(f.git.sha, before);
  assert.equal((await f.store.read()).phase, "OPERATOR_REQUIRED");
});
test("operator reset fences a late external Git write even with unchanged baseline", async t => {
  const f = await fixture(); t.after(() => f.close()); await ready(f.engine);
  const before = await f.git.read();
  await f.engine.reset();
  assert.notEqual(f.git.sha, before.sha);
  await assert.rejects(() => f.git.commit(before.sha, fault(source, "port"), "late write"), /head changed/);
});
test("operator reset revokes the active agent and never claims agent recovery", async t => {
  const f = await fixture(); t.after(() => f.close()); await ready(f.engine);
  await f.engine.start("configuration"); await f.engine.tick();
  const run = (await f.store.read()).run!;
  await f.engine.reset(); await f.engine.tick(); await f.engine.tick();
  await assert.rejects(() => f.engine.applyRepair({ runId: run.id, expectedHead: run.expectedHead!,
    ...corrections.configuration, evidence: "Old agent tries to repair a revoked run after the operator reset." }), /not authorized/);
  assert.equal((await f.store.read()).history[0]?.recoveredAt, undefined);
});
test("ambiguous trigger is attempted once and requires operator intervention", async t => {
  let calls = 0;
  const f = await fixture({ trigger: { async invoke() { calls++; throw new Error("socket timed out after dispatch"); } } });
  t.after(() => f.close()); await ready(f.engine);
  await f.engine.start("port"); await f.engine.tick(); await f.engine.tick();
  assert.equal(calls, 1);
  assert.equal((await f.store.read()).phase, "OPERATOR_REQUIRED");
  assert.equal((await f.store.read()).run?.authorized, false);
});
test("expired run revokes repairs and retains the exclusive lock", async t => {
  const f = await fixture(); t.after(() => f.close()); await ready(f.engine);
  await f.engine.start("port"); await f.engine.tick();
  await f.store.change(s => { s.run!.deadline = Date.now() - 1; });
  await f.engine.tick();
  assert.equal((await f.store.read()).phase, "OPERATOR_REQUIRED");
  await assert.rejects(() => f.engine.start("port"), /active/);
});
test("probe rejects success-shaped but invalid checkout responses", async t => {
  const server = createServer((_req, res) => res.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}'))
    .listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  assert.equal((await probe(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)).ok, false);
});
test("Argo revision and health must match, even when checkout succeeds", async t => {
  const f = await fixture(); t.after(() => f.close());
  f.runtime.deployment = async () => ({ synced: true, healthy: true, revision: "wrong", detail: "stale revision" });
  await f.engine.reset(); await f.engine.tick(); await f.engine.tick();
  assert.equal((await f.store.read()).phase, "RESETTING");
});
test("manifest changes preserve non-fault fields and reject other resources", () => {
  for (const scenario of ["port", "configuration", "scheduling"] as Scenario[]) {
    const broken = fault(source, scenario);
    const corrected = repair(broken, { runId: randomUUID(), expectedHead: "a".repeat(40),
      ...corrections[scenario], evidence: "Evidence gathered from actual manifest fields and runtime state." });
    assert.equal(corrected, baseline(source));
  }
  assert.throws(() => manifests(source.replace("name: checkout", "name: unrelated")));
  assert.throws(() => manifests(source + "\n---\nkind: Secret\n"));
});
test("checkout fails startup validation and validates order payloads", async t => {
  assert.throws(() => checkoutApp("broken"), /Startup validation failed/);
  const server = checkoutApp("conference").listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/checkout`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"sku":"conference-pass","quantity":100}'
  });
  assert.equal(response.status, 400);
  const compressed = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/checkout`, {
    method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: "bad gzip"
  });
  assert.equal(compressed.status, 415);
});
test("persistent local Git uses real commit SHAs and rejects old heads", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aks-booth-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = new LocalGit(dir); await git.init();
  const current = await git.read();
  const next = await git.commit(current.sha, fault(current.content, "port"), "test fault");
  assert.match(next, /^[a-f0-9]{40}$/);
  assert.notEqual(next, current.sha);
  await assert.rejects(() => git.commit(current.sha, current.content, "stale test"), /head changed/);
  await git.init();
  assert.equal((await git.read()).sha, next);
});
test("file store serializes writes and survives a new instance", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aks-booth-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, "state.json"));
  await Promise.all(Array.from({ length: 10 }, () => store.change(s => { s.healthyCount++; })));
  assert.equal((await new FileStore(join(dir, "state.json")).read()).healthyCount, 10);
});
test("HTTP auth, CSRF, role separation, compressed-body rejection, static UI and MCP", async t => {
  const f = await fixture(); t.after(() => f.close());
  const config: Config = { MODE: "local", PORT: 3000, PUBLIC_ORIGIN: "http://localhost:3000",
    BOOTH_TOKEN: "k".repeat(32), OPERATOR_TOKEN: "o".repeat(32), MCP_TOKEN: "m".repeat(32),
    SESSION_SECRET: "s".repeat(32), ENABLED_SCENARIOS: ["port"], LOCAL_DIR: ".local", LOCAL_GATEWAY_PORT: 4001, LOCAL_WORKER_PORT: 4002 };
  const server = boothApp(f.engine, config).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${url}/`)).status, 200);
  assert.equal((await fetch(`${url}/api/state`)).status, 401);
  const login = async (token: string) => fetch(`${url}/api/login`, { method: "POST",
    headers: { "content-type": "application/json", origin: config.PUBLIC_ORIGIN }, body: JSON.stringify({ token }) });
  assert.equal((await login("wrong")).status, 401);
  const signedIn = await login(config.BOOTH_TOKEN);
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(signedIn.headers.get("set-cookie")!, /HttpOnly/);
  assert.equal((await fetch(`${url}/api/state`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${url}/api/reset`, { method: "POST", headers: { cookie } })).status, 403);
  assert.equal((await fetch(`${url}/api/reset`, { method: "POST", headers: { cookie, origin: config.PUBLIC_ORIGIN } })).status, 403);
  assert.equal((await fetch(`${url}/api/runs`, { method: "POST",
    headers: { cookie, origin: config.PUBLIC_ORIGIN, "content-type": "application/json" },
    body: '{"scenario":"scheduling"}' })).status, 403);
  const compressed = await fetch(`${url}/api/login`, { method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip", origin: config.PUBLIC_ORIGIN }, body: "bad gzip" });
  assert.equal(compressed.status, 415);
  assert.equal((await fetch(`${url}/mcp`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const mcp = await fetch(`${url}/mcp`, { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    authorization: `Bearer ${config.MCP_TOKEN}`
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
  assert.equal(mcp.status, 200);
  const result = await mcp.json() as { result: { serverInfo: { name: string } } };
  assert.equal(result.result.serverInfo.name, "aks-booth-repairs");
  await ready(f.engine);
  await f.engine.start("port"); await f.engine.tick();
  const run = (await f.store.read()).run!;
  const callTool = async (name: string, args: unknown) => {
    const response = await fetch(`${url}/mcp`, { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      authorization: `Bearer ${config.MCP_TOKEN}`
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result: { isError?: boolean; content: { text: string }[] } }>;
  };
  const inspected = await callTool("inspect_checkout", { runId: run.id });
  assert.equal(inspected.result.isError, undefined);
  assert.match(inspected.result.content[0]!.text, /9999/);
  const repaired = await callTool("repair_checkout", {
    runId: run.id, expectedHead: run.expectedHead!, ...corrections.port,
    evidence: "MCP inspection showed the Service targetPort mismatched the listening application."
  });
  assert.equal(repaired.result.isError, undefined);
  assert.match(repaired.result.content[0]!.text, /"sha":/);
  assert.equal((await f.store.read()).phase, "VERIFYING");
});
test("operator reset wins over a repair already waiting to write Git", async t => {
  const f = await fixture(); t.after(() => f.close()); await ready(f.engine);
  await f.engine.start("port"); await f.engine.tick();
  const run = (await f.store.read()).run!;
  const commit = f.git.commit.bind(f.git);
  let release!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.git.commit = async (head, content, message) => {
    if (message.includes("corrective")) { entered(); await blocked; }
    return commit(head, content, message);
  };
  const repairPromise = f.engine.applyRepair({ runId: run.id, expectedHead: run.expectedHead!,
    ...corrections.port, evidence: "Service targetPort differs from the actual application listening port." });
  // Attach rejection handling before releasing the competing write.
  const refused = assert.rejects(repairPromise, /head changed/);
  await writing;
  await f.engine.reset();
  release();
  await refused;
  await f.engine.tick(); await f.engine.tick();
  assert.equal((await f.store.read()).phase, "READY");
  assert.equal(isBaseline(f.git.content), true);
  assert.equal((await f.store.read()).history[0]?.recoveredAt, undefined);
});
test("a stale preflight probe cannot authorize a visitor fault", async t => {
  const f = await fixture(); t.after(() => f.close()); await ready(f.engine);
  await f.store.change(s => { s.lastProbe!.at = Date.now() - 6000; });
  await assert.rejects(() => f.engine.start("port"), /fresh successful/);
});
test("baseline reset verification has a finite deadline", async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.engine.reset();
  await f.store.change(s => { s.resetAt = Date.now() - 180_001; });
  await f.engine.tick();
  assert.equal((await f.store.read()).phase, "OPERATOR_REQUIRED");
});
