import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { scenarioSchema } from "./domain.js";

const common = z.object({
  MODE: z.enum(["local", "azure"]).default("local"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
  BOOTH_TOKEN: z.string().min(32), OPERATOR_TOKEN: z.string().min(32),
  MCP_TOKEN: z.string().min(32), SESSION_SECRET: z.string().min(32),
  ENABLED_SCENARIOS: z.string().default("port,configuration,scheduling")
    .transform(value => z.array(scenarioSchema).min(1).parse(value.split(","))),
  LOCAL_DIR: z.string().default(".local"),
  LOCAL_GATEWAY_PORT: z.coerce.number().int().min(1024).max(65535).default(4001),
  LOCAL_WORKER_PORT: z.coerce.number().int().min(1024).max(65535).default(4002)
});
const azure = z.object({
  CHECKOUT_URL: z.string().url(),
  TABLE_ENDPOINT: z.string().url(), TABLE_NAME: z.string().regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/).default("booth"),
  GITHUB_OWNER: z.string().regex(/^[A-Za-z0-9-]+$/), GITHUB_REPO: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  GITHUB_BRANCH: z.string().regex(/^[A-Za-z0-9_/-]+$/).default("booth"),
  GITHUB_APP_ID: z.string().min(1), GITHUB_INSTALLATION_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z.string().min(100),
  AKS_SERVER: z.string().url().startsWith("https://"), AKS_CA: z.string().min(20),
  AKS_RESOURCE_ID: z.string().startsWith("/subscriptions/"),
  KUBE_NAMESPACE: z.string().regex(/^[a-z0-9-]+$/).default("booth"),
  ARGO_APPLICATION: z.string().regex(/^[a-z0-9-]+$/).default("checkout"),
  SRE_TRIGGER_URL: z.string().url().startsWith("https://")
});
export type Config = z.infer<typeof common>;
export type AzureConfig = z.infer<typeof azure>;
export async function configuration(): Promise<{ common: Config; azure?: AzureConfig }> {
  const env = { ...process.env };
  if (env.MODE === "azure") env.ENABLED_SCENARIOS ??= "port";
  if ((env.MODE ?? "local") === "local") {
    const dir = env.LOCAL_DIR ?? ".local";
    await mkdir(dir, { recursive: true });
    let tokens: Record<string, string>;
    try { tokens = JSON.parse(await readFile(`${dir}/access.json`, "utf8")) as Record<string, string>; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      tokens = Object.fromEntries(["BOOTH_TOKEN", "OPERATOR_TOKEN", "MCP_TOKEN", "SESSION_SECRET"]
        .map(key => [key, randomBytes(32).toString("hex")]));
      await writeFile(`${dir}/access.json`, JSON.stringify(tokens, null, 2), { mode: 0o600, flag: "wx" });
      console.log(`Local credentials created in ${dir}/access.json (not logged).`);
    }
    for (const [key, value] of Object.entries(tokens)) env[key] ??= value;
  }
  const parsed = common.parse(env);
  if (new URL(parsed.PUBLIC_ORIGIN).origin !== parsed.PUBLIC_ORIGIN) {
    throw new Error("PUBLIC_ORIGIN must be an origin without a path or trailing slash");
  }
  if (new Set([parsed.BOOTH_TOKEN, parsed.OPERATOR_TOKEN, parsed.MCP_TOKEN, parsed.SESSION_SECRET]).size !== 4) {
    throw new Error("Kiosk, operator, MCP, and signing secrets must be distinct");
  }
  if (parsed.MODE === "azure" && !parsed.PUBLIC_ORIGIN.startsWith("https://")) {
    throw new Error("Azure mode requires an HTTPS PUBLIC_ORIGIN");
  }
  return { common: parsed, ...(parsed.MODE === "azure" ? { azure: azure.parse(env) } : {}) };
}
