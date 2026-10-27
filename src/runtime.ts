import { request } from "node:https";
import type { TokenCredential } from "@azure/identity";
import { z } from "zod";
import { AppError, type Deployment, type RuntimePort, type TriggerPort } from "./domain.js";

export class AzureTrigger implements TriggerPort {
  constructor(private url: string, private credential: TokenCredential) {}
  async invoke(context: Record<string, unknown>) {
    const token = await this.credential.getToken("https://azuresre.dev/.default");
    if (!token) throw new Error("Managed identity returned no SRE Agent token");
    const response = await fetch(this.url, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify(context)
    });
    if (response.status !== 202) throw new Error(`SRE Agent trigger returned HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("threadId" in result) || typeof result.threadId !== "string") {
      throw new Error("SRE Agent accepted request but returned no threadId; inspect execution history");
    }
    return { threadId: result.threadId };
  }
}
interface ArgoApplication {
  status?: { sync?: { status?: string; revision?: string }; health?: { status?: string } };
}
export class KubernetesRuntime implements RuntimePort {
  constructor(private server: string, private ca: string, private namespace: string,
    private application: string, private credential: TokenCredential) {}
  private async api(path: string, method = "GET", body?: unknown, plainText = false): Promise<unknown> {
    const token = await this.credential.getToken("6dae42f8-4368-4678-94ff-3960e28e3630/.default");
    if (!token) throw new Error("Managed identity returned no AKS token");
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, this.server), {
        method, ca: Buffer.from(this.ca, "base64"), signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${token.token}`,
          "content-type": method === "PATCH" ? "application/merge-patch+json" : "application/json" }
      }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 1024 * 1024) response.destroy(new Error("Kubernetes response exceeds 1 MiB"));
        });
        response.on("error", reject);
        response.on("end", () => {
          if (!response.statusCode || response.statusCode >= 300) {
            reject(new AppError(502, `Kubernetes ${method} failed (HTTP ${response.statusCode}); check network and namespace RBAC`));
            return;
          }
          try { resolve(plainText ? text : JSON.parse(text)); } catch (error) { reject(error); }
        });
      });
      req.setTimeout(8000, () => req.destroy(new Error("Kubernetes request timed out")));
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  private appPath() {
    return `/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${encodeURIComponent(this.application)}`;
  }
  async refresh(): Promise<void> {
    await this.api(this.appPath(), "PATCH", { metadata: { annotations: { "argocd.argoproj.io/refresh": "normal" } } });
  }
  async deployment(): Promise<Deployment> {
    const application = await this.api(this.appPath()) as ArgoApplication;
    return { synced: application.status?.sync?.status === "Synced",
      healthy: application.status?.health?.status === "Healthy",
      revision: application.status?.sync?.revision ?? "",
      detail: `${application.status?.sync?.status ?? "Unknown"} / ${application.status?.health?.status ?? "Unknown"}` };
  }
  async evidence(): Promise<unknown> {
    const ns = encodeURIComponent(this.namespace);
    const paths = {
      pods: `/api/v1/namespaces/${ns}/pods?labelSelector=app%3Dcheckout`,
      events: `/api/v1/namespaces/${ns}/events?fieldSelector=type%3DWarning&limit=30`,
      service: `/api/v1/namespaces/${ns}/services/checkout`,
      deployment: `/apis/apps/v1/namespaces/${ns}/deployments/checkout`
    };
    const result = Object.fromEntries(await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await this.api(path)])
    ));
    const pods = z.object({ items: z.array(z.object({
      metadata: z.object({ name: z.string() }),
      status: z.object({ containerStatuses: z.array(z.object({
        state: z.object({ waiting: z.object({ reason: z.string() }).optional() }).passthrough()
      })).optional() }).optional()
    })) }).parse(result.pods);
    result.logs = await Promise.all(pods.items.slice(0, 3).map(async pod => {
      const waiting = pod.status?.containerStatuses?.[0]?.state.waiting?.reason;
      if (waiting === "ContainerCreating" || waiting === "PodInitializing") {
        return { pod: pod.metadata.name, unavailable: waiting };
      }
      if (!pod.status?.containerStatuses?.length) return { pod: pod.metadata.name, unavailable: "No container has started" };
      return { pod: pod.metadata.name,
        log: await this.api(`/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod.metadata.name)}/log?container=checkout&tailLines=30`, "GET", undefined, true) };
    }));
    return result;
  }
}
