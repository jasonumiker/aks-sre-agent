import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { LocalGit } from "../src/git.js";
import { LocalRuntime } from "../src/local.js";
import { FileStore } from "../src/store.js";
import { Engine, probe } from "../src/engine.js";
import { encodeState, decodeState } from "../src/store.js";
import { initialState } from "../src/domain.js";

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
test("local rehearsal: three real Git faults and operator repairs against the checkout subprocess", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aks-booth-local-"));
  const git = new LocalGit(join(dir, "git")); await git.init();
  const gatewayPort = await freePort();
  const workerPort = await freePort();
  const runtime = new LocalRuntime(git, gatewayPort, workerPort);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.init();
  const url = `http://127.0.0.1:${gatewayPort}`;
  const store = new FileStore(join(dir, "state.json"));
  const engine = new Engine(store, git, runtime, { async invoke() { return {}; } }, url, {},
    { deadlineMs: 180_000, healthyMs: 0, healthyCount: 2 });
  async function until(phase: string) {
    for (let i = 0; i < 80; i++) {
      await engine.tick();
      if ((await store.read()).phase === phase) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Did not reach ${phase}; state=${JSON.stringify(await store.read())}`);
  }
  await engine.reset(); await until("READY");
  for (const [scenario, field, value] of [
    ["port", "targetPort", 8080],
    ["configuration", "checkoutMode", "conference"],
    ["scheduling", "nodeSelector", { "kubernetes.io/os": "linux" }]
  ] as const) {
    await engine.start(scenario);
    await until("INVESTIGATING");
    assert.equal((await probe(url)).ok, false);
    const run = (await store.read()).run!;
    const evidence = await engine.evidence(run.id);
    assert.match(JSON.stringify(evidence), /LOCAL SIMULATION/);
    await engine.applyRepair({ runId: run.id, expectedHead: run.expectedHead!, field, value,
      evidence: "Operator inspected the actual Git manifest and local runtime evidence before selecting this field." }, "operator");
    await until("READY");
    assert.equal((await probe(url)).ok, true);
    assert.equal((await store.read()).history.at(-1)?.repairActor, "operator");
  }
});
test("Table encoding chunks long Unicode state below per-property limits and round trips", () => {
  const state = initialState();
  state.events = Array.from({ length: 80 }, () => ({
    at: Date.now(), actor: "agent" as const, message: "Evidence with Unicode \u2603 ".repeat(80)
  }));
  const encoded = encodeState(state);
  assert.ok(Number(encoded.chunks) > 1);
  for (const value of Object.values(encoded)) if (typeof value === "string") assert.ok(Buffer.byteLength(value, "utf16le") <= 64 * 1024);
  assert.deepEqual(decodeState(encoded), state);
  assert.throws(() => decodeState({ chunks: 2, part0: "abc" }), /Missing/);
});
