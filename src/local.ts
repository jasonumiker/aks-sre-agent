import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { manifests } from "./manifests.js";
import type { GitPort, RuntimePort } from "./domain.js";

export class LocalRuntime implements RuntimePort {
  private child?: ChildProcess;
  private gateway?: Server;
  private revision = "";
  private targetPort = 8080;
  private scheduled = true;
  private logs: string[] = [];
  private currentMode = "";
  constructor(private git: GitPort, private gatewayPort: number, private workerPort: number) {}
  async init(): Promise<void> {
    this.gateway = createServer(async (req, res) => {
      if (!this.scheduled || this.targetPort !== 8080) {
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"Local simulated Service has no reachable backend"}');
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
          if (chunks.reduce((size, item) => size + item.length, 0) > 4096) throw new Error("Body too large");
        }
        const response = await fetch(`http://127.0.0.1:${this.workerPort}${req.url}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
          signal: AbortSignal.timeout(1500)
        });
        res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
      } catch {
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"Local checkout process unavailable"}');
      }
    });
    this.gateway.listen(this.gatewayPort, "127.0.0.1");
    await once(this.gateway, "listening");
    await this.refresh();
  }
  private async stopChild() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, "exit");
      this.child.kill("SIGTERM");
      await exited;
    }
    this.child = undefined;
  }
  async refresh(): Promise<void> {
    const snapshot = await this.git.read();
    const patch = manifests(snapshot.content);
    const mode = patch.deployment.spec.template.spec.containers[0].env[0].value;
    const scheduled = !patch.deployment.spec.template.spec.nodeSelector["booth.example/scenario"];
    this.targetPort = patch.service.spec.ports[0].targetPort;
    if (mode !== this.currentMode || scheduled !== this.scheduled || !this.revision) {
      await this.stopChild();
      this.currentMode = mode;
      this.scheduled = scheduled;
      this.logs = [];
      if (scheduled) {
        const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
        const entry = fileURLToPath(new URL(`./checkout-main.${extension}`, import.meta.url));
        this.child = spawn(process.execPath, [...(extension === "ts" ? ["--import", "tsx"] : []), entry], {
          env: { ...process.env, PORT: String(this.workerPort), CHECKOUT_MODE: mode },
          stdio: ["ignore", "pipe", "pipe"]
        });
        const append = (data: Buffer) => { this.logs = [...this.logs, data.toString().trim()].slice(-20); };
        this.child.stdout!.on("data", append);
        this.child.stderr!.on("data", append);
        this.child.on("error", error => append(Buffer.from(`Checkout spawn failed: ${error.message}`)));
      }
    }
    this.revision = snapshot.sha;
  }
  async deployment() {
    return { synced: true, healthy: this.scheduled && this.currentMode === "conference",
      revision: this.revision, detail: "LOCAL SIMULATION: Git projected onto a local process; no Kubernetes or Argo CD" };
  }
  async evidence() {
    const current = await this.git.read();
    return { mode: "LOCAL SIMULATION", service: { targetPort: this.targetPort, containerPort: 8080 },
      pod: this.scheduled ? { phase: this.currentMode === "conference" ? "Running" : "CrashLoopBackOff" } :
        { phase: "Pending", warning: "SIMULATED FailedScheduling: node selector matches no nodes" },
      logs: this.logs, manifests: current.content };
  }
  async close() {
    await this.stopChild();
    if (this.gateway) await new Promise<void>((resolve, reject) => {
      this.gateway!.close(error => error ? reject(error) : resolve());
    });
  }
}
