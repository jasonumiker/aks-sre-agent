import { ManagedIdentityCredential } from "@azure/identity";
import { configuration } from "./config.js";
import { LocalGit, GitHubGit, manifestPath } from "./git.js";
import { FileStore, TableStore } from "./store.js";
import { AzureTrigger, KubernetesRuntime } from "./runtime.js";
import { LocalRuntime } from "./local.js";
import { Engine } from "./engine.js";
import { boothApp } from "./http.js";
import type { GitPort, RuntimePort, Store, TriggerPort } from "./domain.js";

const config = await configuration();
let git: GitPort;
let store: Store;
let runtime: RuntimePort;
let trigger: TriggerPort;
let checkoutUrl: string;
let context: Record<string, unknown> = {};
if (config.azure) {
  const env = config.azure;
  const credential = new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID });
  git = new GitHubGit(env.GITHUB_OWNER, env.GITHUB_REPO, env.GITHUB_BRANCH,
    env.GITHUB_AUTH_MODE === "token" ? { mode: "token", token: env.GITHUB_TOKEN } :
      { mode: "app", appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID,
        privateKey: env.GITHUB_PRIVATE_KEY });
  store = new TableStore(env.TABLE_ENDPOINT, env.TABLE_NAME, credential);
  runtime = new KubernetesRuntime(env.AKS_SERVER, env.AKS_CA, env.KUBE_NAMESPACE, env.ARGO_APPLICATION, credential);
  trigger = new AzureTrigger(env.SRE_TRIGGER_URL, credential);
  checkoutUrl = env.CHECKOUT_URL;
  context = { aksResourceId: env.AKS_RESOURCE_ID, namespace: env.KUBE_NAMESPACE,
    repository: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, branch: env.GITHUB_BRANCH, manifestPath };
} else {
  const localGit = new LocalGit(`${config.common.LOCAL_DIR}/git`);
  await localGit.init();
  git = localGit;
  store = new FileStore(`${config.common.LOCAL_DIR}/state.json`);
  const local = new LocalRuntime(git, config.common.LOCAL_GATEWAY_PORT, config.common.LOCAL_WORKER_PORT);
  await local.init();
  runtime = local;
  trigger = { async invoke() { return {}; } };
  checkoutUrl = `http://127.0.0.1:${config.common.LOCAL_GATEWAY_PORT}`;
}
const engine = new Engine(store, git, runtime, trigger, checkoutUrl, context);
// On restart never resume an uncertain mutation or admit a new run automatically.
await store.change(state => {
  if (state.run) state.run.authorized = false;
  state.phase = "OPERATOR_REQUIRED";
  delete state.operation;
  state.events.push({ at: Date.now(), actor: "controller",
    message: "Controller started; operator baseline reset required before accepting visitors" });
  state.events = state.events.slice(-80);
});
const server = boothApp(engine, config.common).listen(config.common.PORT,
  config.common.MODE === "local" ? "127.0.0.1" : "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "booth.listening", port: config.common.PORT, mode: config.common.MODE }));
  });
const timer = setInterval(() => {
  void engine.tick().catch(error => console.error(JSON.stringify({ event: "controller.tick_failed", error: String(error) })));
}, 1000);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => {
      void (runtime.close?.() ?? Promise.resolve()).then(() => process.exit(0)).catch(error => {
        console.error(JSON.stringify({ event: "shutdown.failed", error: String(error) }));
        process.exit(1);
      });
    });
  });
}
