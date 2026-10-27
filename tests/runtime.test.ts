import assert from "node:assert/strict";
import test from "node:test";
import { AzureTrigger } from "../src/runtime.js";

test("Azure trigger requests the SRE data-plane audience and returns the accepted thread", async t => {
  const context = { runId: "current-run" };
  let requestedScope: string | string[] | undefined;
  const trigger = new AzureTrigger("https://example.invalid/trigger", {
    async getToken(scopes) {
      requestedScope = scopes;
      return { token: "test-token", expiresOnTimestamp: Date.now() + 60_000 };
    }
  });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://example.invalid/trigger");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), context);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-token");
    return Response.json({ threadId: "thread-123", success: true }, { status: 202 });
  });
  assert.deepEqual(await trigger.invoke(context), { threadId: "thread-123" });
  assert.equal(requestedScope, "https://azuresre.dev/.default");
});

test("Azure trigger does not retry failed or ambiguous invocations", async t => {
  let calls = 0;
  const trigger = new AzureTrigger("https://example.invalid/trigger", {
    async getToken() { return { token: "test-token", expiresOnTimestamp: Date.now() + 60_000 }; }
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ success: true }, { status: 202 });
  });
  await assert.rejects(trigger.invoke({}), /returned no threadId/);
  assert.equal(calls, 1);
});
