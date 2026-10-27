import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const config = z.object({
  AGENT_RESOURCE_ID: z.string().regex(/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.App\/agents\/[^/]+$/i),
  AGENT_ENDPOINT: z.string().url(),
  BOOTH_URL: z.string().url(),
  MCP_TOKEN_FILE: z.string().min(1),
  AGENT_MODE: z.enum(["Review", "Autonomous"]).default("Review")
}).parse(process.env);
const endpoint = new URL(config.AGENT_ENDPOINT);
const booth = new URL(config.BOOTH_URL);
if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".azuresre.ai") ||
  endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
  throw new Error("AGENT_ENDPOINT must be an Azure SRE Agent HTTPS origin");
}
if (booth.protocol !== "https:" || booth.pathname !== "/" || booth.search || booth.hash ||
  booth.username || booth.password) throw new Error("BOOTH_URL must be an HTTPS origin");
const mcpToken = z.string().min(32).parse((await readFile(config.MCP_TOKEN_FILE, "utf8")).trim());
function accessToken(resource: string): string {
  return z.string().min(1).parse(execFileSync("az", [
    "account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"
  ], { encoding: "utf8" }).trim());
}
const armToken = accessToken("https://management.azure.com/");
const dataToken = accessToken("https://azuresre.dev");
async function request(url: string, method: string, token: string, body?: unknown): Promise<Response> {
  const response = await fetch(url, {
    method, signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname} failed (HTTP ${response.status})`);
  return response;
}
const tools = ["checkout-booth_inspect_checkout", "checkout-booth_repair_checkout"];
await request(`https://management.azure.com${config.AGENT_RESOURCE_ID}/connectors/checkout-booth?api-version=2025-05-01-preview`,
  "PUT", armToken, {
    properties: {
      dataConnectorType: "Mcp", dataSource: "placeholder", identity: "system",
      extendedProperties: {
        type: "http", endpoint: `${booth.origin}/mcp`, authType: "BearerToken",
        bearerToken: mcpToken, selectedTools: tools, toolsVisibleToMetaAgent: []
      }
    }
  });
await request(`${endpoint.origin}/api/v2/extendedAgent/agents/checkout-repair`, "PUT", dataToken, {
  name: "checkout-repair", type: "ExtendedAgent", tags: [],
  properties: {
    instructions: await readFile(new URL("../agent/handler.txt", import.meta.url), "utf8"),
    handoffDescription: "Diagnose and repair the isolated conference checkout application using only the scoped MCP broker.",
    handoffs: [], tools: [], mcpTools: tools, commonTools: [], allowedSkills: [],
    allowParallelToolCalls: false, maxReflectionCount: 0, customReflectionNote: "",
    commonPrompts: [], enableVanillaMode: false
  }
});
const triggers = z.array(z.object({ id: z.string().uuid(), name: z.string() })).parse(
  await (await request(`${endpoint.origin}/api/v1/httptriggers`, "GET", dataToken)).json());
const matches = triggers.filter(trigger => trigger.name === "checkout-booth");
if (matches.length > 1) throw new Error("Duplicate checkout-booth triggers; operator must resolve them");
const payload = {
  name: "checkout-booth", description: "Bounded conference checkout fault investigation",
  agentPrompt: "Investigate the checkout incident in the attached HTTP payload. Use only inspect_checkout and repair_checkout, follow checkout-repair instructions, and let the controller independently verify recovery.",
  agent: "checkout-repair", agentMode: config.AGENT_MODE
};
let triggerUrl: string;
if (matches[0]) {
  await request(`${endpoint.origin}/api/v1/httptriggers/${matches[0].id}`, "PUT", dataToken, payload);
  triggerUrl = `${endpoint.origin}/api/v1/httptriggers/trigger/${matches[0].id}`;
} else {
  const response = await request(`${endpoint.origin}/api/v1/httptriggers/create`, "POST", dataToken, payload);
  triggerUrl = z.object({ triggerUrl: z.string().url() }).parse(await response.json()).triggerUrl;
}
console.log(JSON.stringify({ agent: "checkout-repair", mode: config.AGENT_MODE, tools, triggerUrl }));
