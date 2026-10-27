import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Run, State } from "../src/domain.js";

const config = z.object({
  BOOTH_URL: z.string().url(),
  OPERATOR_TOKEN: z.string().min(32),
  RUNS_PER_SCENARIO: z.coerce.number().int().min(1).max(100).default(30),
  REPORT_PATH: z.string().default("rehearsal-report.json")
}).parse(process.env);
const origin = new URL(config.BOOTH_URL).origin;
let cookie = "";
async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, origin), {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
    headers: { origin, cookie, "content-type": "application/json" }
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  if (!response.ok) throw new Error(`Rehearsal request ${path} failed with HTTP ${response.status}`);
  return response.json();
}
const runs: Run[] = [];
try {
  await request("/api/login", { token: config.OPERATOR_TOKEN });
  const initial = await request("/api/state") as State & { mode: string };
  if (initial.mode !== "azure") throw new Error("Timing rehearsal requires a real Azure agent, not local/manual simulation");
  if (initial.phase !== "READY") throw new Error("Operator must verify baseline readiness before rehearsal");
  for (const scenario of ["port", "configuration", "scheduling"]) {
    for (let i = 0; i < config.RUNS_PER_SCENARIO; i++) {
      const started = await request("/api/runs", { scenario }) as State;
      const id = started.run!.id;
      const deadline = Date.now() + 210_000;
      let completed: Run | undefined;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const state = await request("/api/state") as State;
        completed = state.history.find(run => run.id === id);
        if (completed) break;
        if (state.phase === "OPERATOR_REQUIRED") throw new Error(`Run ${id} requires intervention; rehearsal stopped without an automatic reset`);
      }
      if (!completed?.recoveredAt || completed.repairActor !== "agent") throw new Error(`Run ${id} did not achieve agent-attributed recovery`);
      runs.push(completed);
      console.log(`${scenario} ${i + 1}/${config.RUNS_PER_SCENARIO}: ${completed.recoveredAt - completed.startedAt}ms`);
    }
  }
} finally {
  const summary = ["port", "configuration", "scheduling"].map(scenario => {
    const durations = runs.filter(run => run.scenario === scenario)
      .map(run => run.recoveredAt! - run.startedAt).sort((a, b) => a - b);
    const percentile = (p: number) => durations.length ? durations[Math.ceil(durations.length * p) - 1] : null;
    return { scenario, successfulRuns: durations.length, requestedRuns: config.RUNS_PER_SCENARIO,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95),
      passesLaunchGate: durations.length >= 30 && durations.length === config.RUNS_PER_SCENARIO && (percentile(0.95) ?? Infinity) <= 180_000 };
  });
  await writeFile(config.REPORT_PATH, JSON.stringify({ at: new Date().toISOString(), origin, summary, runs }, null, 2), { mode: 0o600 });
  console.log(`Report saved to ${config.REPORT_PATH}`);
}
