import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppError, repairSchema, scenarioSchema } from "./domain.js";
import type { Engine } from "./engine.js";
import type { Config } from "./config.js";

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
function sessionRole(req: Request, config: Config): "kiosk" | "operator" | undefined {
  const cookie = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("booth="))?.slice(6);
  if (!cookie) return;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig || !equalSecret(signature(payload, config.SESSION_SECRET), sig)) return;
  const [role, expiry] = Buffer.from(payload, "base64url").toString("utf8").split(":");
  if ((role !== "kiosk" && role !== "operator") || !Number.isFinite(Number(expiry)) || Number(expiry) <= Date.now()) return;
  return role;
}
export function boothApp(engine: Engine, config: Config) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.MODE === "azure" ? 1 : false);
  app.use((_req, res, next) => {
    res.set({
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "cache-control": "no-store"
    });
    next();
  });
  app.use((req, _res, next) => {
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
      next(new AppError(415, "Compressed requests are not supported")); return;
    }
    next();
  });
  app.use(express.json({ limit: "8kb", inflate: false }));
  app.get("/health/live", (_req, res) => res.json({ status: "live" }));
  app.use((req, _res, next) => {
    if (req.path === "/mcp") { next(); return; }
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== config.PUBLIC_ORIGIN) {
      next(new AppError(403, "Same-origin request required")); return;
    }
    next();
  });
  const attempts = new Map<string, { count: number; until: number }>();
  app.use((req, _res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = `${req.ip}:${req.path === "/api/login" ? "login" : "other"}`;
    let value = attempts.get(key);
    if (!value) {
      if (attempts.size >= 1000) { next(new AppError(429, "Request capacity reached")); return; }
      value = { count: 0, until: now + 60_000 };
      attempts.set(key, value);
    }
    value.count++;
    const limit = req.path === "/api/login" ? 10 : 240;
    if (value.count > limit) { next(new AppError(429, "Too many requests; wait one minute")); return; }
    next();
  });
  app.post("/api/login", (req, res) => {
    const { token } = z.object({ token: z.string().max(512) }).strict().parse(req.body);
    const role = equalSecret(token, config.OPERATOR_TOKEN) ? "operator" :
      equalSecret(token, config.BOOTH_TOKEN) ? "kiosk" : undefined;
    if (!role) throw new AppError(401, "Invalid access token");
    const payload = Buffer.from(`${role}:${Date.now() + 12 * 60 * 60_000}`).toString("base64url");
    res.cookie("booth", `${payload}.${signature(payload, config.SESSION_SECRET)}`, {
      httpOnly: true, secure: config.MODE === "azure", sameSite: "strict", maxAge: 12 * 60 * 60_000, path: "/"
    });
    res.json({ role });
  });
  app.post("/api/logout", (_req, res) => { res.clearCookie("booth", { path: "/" }).json({ ok: true }); });
  app.use("/api", (req, res, next) => {
    const role = sessionRole(req, config);
    if (!role) { next(new AppError(401, "Sign in to the booth")); return; }
    res.locals.role = role;
    next();
  });
  const operator = (_req: Request, res: Response, next: express.NextFunction) => {
    if (res.locals.role !== "operator") { next(new AppError(403, "Operator access required")); return; }
    next();
  };
  app.get("/api/state", async (_req, res) => res.json({
    ...await engine.store.read(), mode: config.MODE, role: res.locals.role,
    enabledScenarios: config.ENABLED_SCENARIOS
  }));
  app.post("/api/runs", async (req, res) => {
    const { scenario } = z.object({ scenario: scenarioSchema }).strict().parse(req.body);
    if (!config.ENABLED_SCENARIOS.includes(scenario)) throw new AppError(403, "This scenario is not enabled for public use");
    res.status(202).json(await engine.start(scenario));
  });
  app.post("/api/reset", operator, async (_req, res) => res.status(202).json(await engine.reset()));
  app.get("/api/evidence", operator, async (req, res) => {
    const runId = z.string().uuid().parse(req.query.runId);
    res.json(await engine.evidence(runId));
  });
  app.get("/api/export", operator, async (_req, res) => {
    res.attachment("booth-runs.json").json(await engine.store.read());
  });
  if (config.MODE === "local") {
    app.post("/api/local-repair", operator, async (req, res) => {
      res.json(await engine.applyRepair(repairSchema.parse(req.body), "operator"));
    });
  }
  app.post("/mcp", async (req, res) => {
    if (!equalSecret(req.headers.authorization ?? "", `Bearer ${config.MCP_TOKEN}`)) {
      throw new AppError(401, "MCP bearer authentication required");
    }
    if (req.headers.origin && req.headers.origin !== config.PUBLIC_ORIGIN) throw new AppError(403, "Untrusted MCP origin");
    const server = new McpServer({ name: "aks-booth-repairs", version: "0.1.0" });
    const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    server.registerTool("inspect_checkout", {
      description: "Read live checkout evidence and the current Git manifest/diff for the supplied run. Does not select a repair.",
      inputSchema: { runId: z.string().uuid() }
    }, async ({ runId }) => {
      try { return text(await engine.evidence(runId)); }
      catch (error) {
        console.error(JSON.stringify({ event: "mcp.inspect_failed", error: String(error) }));
        return { ...text({ error: error instanceof AppError ? error.message : "Inspection failed; operator should check controller logs" }), isError: true };
      }
    });
    server.registerTool("repair_checkout", {
      description: "Commit one evidence-based correction to the authorized booth Git manifest. Requires current runId and expectedHead. Allowed values: targetPort=8080, checkoutMode=conference, nodeSelector={kubernetes.io/os:linux}. No diagnosis is performed by this tool.",
      inputSchema: repairSchema.shape
    }, async input => {
      try { return text(await engine.applyRepair(repairSchema.parse(input))); }
      catch (error) {
        console.error(JSON.stringify({ event: "mcp.repair_failed", error: String(error) }));
        return { ...text({ error: error instanceof AppError ? error.message : "Repair outcome needs operator inspection; do not retry automatically" }), isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "Use stateless Streamable HTTP POST" }));
  app.use(express.static(resolve("public")));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    console.error(JSON.stringify({ event: "http.request_failed", error: String(error) }));
    if (res.headersSent) { res.end(); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid request", details: error.issues }); return; }
    if (error instanceof AppError) { res.status(error.status).json({ error: error.message }); return; }
    if (error && typeof error === "object" && "status" in error && (error.status === 400 || error.status === 413)) {
      res.status(error.status).json({ error: error.status === 413 ? "Request body is too large" : "Malformed JSON request" });
      return;
    }
    res.status(500).json({ error: "Request failed; operator should inspect the controller logs" });
  };
  app.use(errors);
  return app;
}
