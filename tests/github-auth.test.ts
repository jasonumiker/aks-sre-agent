import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GitHubGit, manifestPath } from "../src/git.js";
import { githubAuthSchema } from "../src/config.js";

test("token auth requires no App credentials; App auth still requires all credentials", () => {
  assert.deepEqual(githubAuthSchema.parse({ GITHUB_AUTH_MODE: "token", GITHUB_TOKEN: " test-token " }),
    { GITHUB_AUTH_MODE: "token", GITHUB_TOKEN: "test-token" });
  assert.equal(githubAuthSchema.safeParse({ GITHUB_AUTH_MODE: "token", GITHUB_TOKEN: " " }).success, false);
  assert.equal(githubAuthSchema.safeParse({ GITHUB_AUTH_MODE: "token" }).success, false);
  assert.equal(githubAuthSchema.safeParse({ GITHUB_AUTH_MODE: "app", GITHUB_TOKEN: "test-token" }).success, false);
  assert.equal(githubAuthSchema.safeParse({ GITHUB_AUTH_MODE: "unknown", GITHUB_TOKEN: "test-token" }).success, false);
  assert.equal(githubAuthSchema.safeParse({ GITHUB_AUTH_MODE: "app", GITHUB_APP_ID: "1",
    GITHUB_INSTALLATION_ID: "2", GITHUB_PRIVATE_KEY: "k".repeat(100) }).success, true);
});

test("fine-grained token is used for read and constrained non-force commit requests", async t => {
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-fine-grained-token");
    const url = new URL(input);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url: url.pathname, method: init.method!, body });
    const path = url.pathname;
    const data = path.includes("/git/ref/") ? { object: { sha: "a".repeat(40) } } :
      path.includes("/contents/") ? { content: Buffer.from("manifest").toString("base64") } :
      path.endsWith(`/commits/${"a".repeat(40)}`) && !path.includes("/git/") ?
        { files: [{ filename: manifestPath, patch: "fixture diff" }] } :
      path.includes("/git/commits/") ? { tree: { sha: "b".repeat(40) } } :
      path.endsWith("/git/trees") ? { sha: "c".repeat(40) } :
      path.endsWith("/git/commits") ? { sha: "d".repeat(40) } : {};
    return Response.json(data);
  });
  const git = new GitHubGit("owner", "repo", "booth", { mode: "token", token: "fixture-fine-grained-token" });
  assert.deepEqual(await git.read(), { sha: "a".repeat(40), content: "manifest", diff: "fixture diff" });
  assert.equal(await git.commit("a".repeat(40), "corrected manifest", "repair"), "d".repeat(40));
  assert.ok(requests.every(req => req.url.startsWith("/repos/owner/repo/")));
  const tree = requests.find(req => req.url.endsWith("/git/trees"))!;
  assert.deepEqual(tree.body.tree, [{ path: manifestPath, mode: "100644", type: "blob", content: "corrected manifest" }]);
  assert.deepEqual(requests.at(-1)?.body, { sha: "d".repeat(40), force: false });
});

test("expired or unauthorized token fails explicitly without leaking it", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "Bad credentials" }, { status: 401 }));
  const git = new GitHubGit("owner", "repo", "booth", { mode: "token", token: "never-expose-this-token" });
  await assert.rejects(() => git.read(), error =>
    error instanceof Error && error.message.includes("401") && !error.message.includes("never-expose"));
});

test("GitHub App client still accepts valid RSA credentials", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const git = new GitHubGit("owner", "repo", "booth",
    { mode: "app", appId: "123", installationId: 456, privateKey });
  assert.ok(git);
});
