import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { createAppAuth } from "@octokit/auth-app";
import { AppError, type GitPort, type Snapshot } from "./domain.js";

const exec = promisify(execFile);
export const manifestPath = "gitops/apps/checkout/booth/patch.yaml";
export type GitHubAuth =
  | { mode: "app"; appId: string; installationId: number; privateKey: string }
  | { mode: "token"; token: string };
export class LocalGit implements GitPort {
  constructor(private path: string) {}
  private async git(...args: string[]) {
    return (await exec("git", ["--git-dir", this.path, ...args], { timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  async init(): Promise<void> {
    await mkdir(this.path, { recursive: true });
    await this.git("init", "--bare", "--initial-branch=booth");
    try { await this.git("rev-parse", "--verify", "--quiet", "refs/heads/booth"); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== 1) throw error;
      const content = await readFile(manifestPath, "utf8");
      await this.write(undefined, content, "Initialize local rehearsal branch");
    }
  }
  private async write(expected: string | undefined, content: string, message: string): Promise<string> {
    // A Git ref compare-and-swap is the final arbiter, even across process restarts.
    const blob = await gitInput(this.path, ["hash-object", "-w", "--stdin"], content);
    return this.treeCommit(expected, blob, message);
  }
  private async treeCommit(expected: string | undefined, blob: string, message: string): Promise<string> {
    const tree = await gitInput(this.path, ["mktree"], `100644 blob ${blob}\tpatch.yaml\n`);
    const sha = await gitInput(this.path, ["-c", "user.name=Booth demo", "-c",
      "user.email=booth@example.invalid", "commit-tree", tree, ...(expected ? ["-p", expected] : [])], message);
    try { await this.git("update-ref", "refs/heads/booth", sha, expected ?? "0".repeat(40)); }
    catch { throw new AppError(409, "Git head changed; inspect the current run before retrying"); }
    return sha;
  }
  async read(): Promise<Snapshot> {
    const sha = await this.git("rev-parse", "refs/heads/booth");
    const content = await this.git("show", `${sha}:patch.yaml`);
    const diff = await this.git("show", "--format=short", sha, "--", "patch.yaml");
    return { sha, content: content + "\n", diff };
  }
  async commit(expected: string, content: string, message: string): Promise<string> {
    return this.write(expected, content, message);
  }
}
async function gitInput(path: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--git-dir", path, ...args], { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout.trim());
    });
    child.stdin!.end(input);
  });
}
export class GitHubGit implements GitPort {
  private token: () => Promise<string>;
  constructor(private owner: string, private repo: string, private branch: string,
    credentials: GitHubAuth) {
    if (credentials.mode === "token") {
      this.token = async () => credentials.token;
    } else {
      const auth = createAppAuth(credentials);
      this.token = async () => (await auth({ type: "installation" })).token;
    }
  }
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const token = await this.token();
    const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new AppError(response.status === 422 ? 409 : 502,
      `GitHub ${method} ${path.split("/")[0]} failed (${response.status}); inspect Git and connector permissions`);
    return response.json();
  }
  async read(): Promise<Snapshot> {
    const ref = await this.request(`git/ref/heads/${encodeURIComponent(this.branch)}`) as { object: { sha: string } };
    const file = await this.request(`contents/${manifestPath}?ref=${ref.object.sha}`) as { content: string };
    const commit = await this.request(`commits/${ref.object.sha}`) as {
      files?: { filename: string; patch?: string }[];
    };
    return { sha: ref.object.sha, content: Buffer.from(file.content, "base64").toString("utf8"),
      diff: commit.files?.find(f => f.filename === manifestPath)?.patch ?? "(No patch in commit response)" };
  }
  async commit(expected: string, content: string, message: string): Promise<string> {
    const parent = await this.request(`git/commits/${expected}`) as { tree: { sha: string } };
    const tree = await this.request("git/trees", "POST", { base_tree: parent.tree.sha,
      tree: [{ path: manifestPath, mode: "100644", type: "blob", content }] }) as { sha: string };
    const commit = await this.request("git/commits", "POST", {
      message, tree: tree.sha, parents: [expected]
    }) as { sha: string };
    await this.request(`git/refs/heads/${encodeURIComponent(this.branch)}`, "PATCH", {
      sha: commit.sha, force: false
    });
    return commit.sha;
  }
}
