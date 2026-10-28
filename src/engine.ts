import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, event, type Actor, type GitPort, type Probe, type Repair,
  type RuntimePort, type Scenario, type State, type Store, type TriggerPort } from "./domain.js";
import { baseline, fault, isBaseline, repair } from "./manifests.js";

const orderSchema = z.object({
  orderId: z.string().uuid(), sku: z.literal("conference-pass"), quantity: z.literal(1),
  total: z.literal(49), currency: z.literal("USD"), synthetic: z.literal(true)
});
export async function probe(url: string): Promise<Probe> {
  const at = Date.now();
  try {
    const response = await fetch(new URL("/api/checkout", url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "conference-pass", quantity: 1 }),
      signal: AbortSignal.timeout(2000)
    });
    const valid = response.status === 201 && orderSchema.safeParse(await response.json()).success;
    return { at, latencyMs: Date.now() - at, ok: valid,
      detail: valid ? "Synthetic checkout succeeded" : `Checkout failed validation (HTTP ${response.status})` };
  } catch (error) {
    return { at, latencyMs: Date.now() - at, ok: false,
      detail: `Checkout unavailable: ${error instanceof Error ? error.name : "request error"}` };
  }
}
export class Engine {
  private ticking = false;
  constructor(
    readonly store: Store,
    readonly git: GitPort,
    readonly runtime: RuntimePort,
    readonly trigger: TriggerPort,
    private checkoutUrl: string,
    private context: Record<string, unknown> = {},
    private timing = { deadlineMs: 180_000, healthyMs: 10_000, healthyCount: 10 }
  ) {}
  async start(scenario: Scenario): Promise<State> {
    const id = randomUUID();
    await this.store.change(state => {
      if (state.phase !== "READY" || state.operation) throw new AppError(409, "A run is active or the baseline needs an operator reset");
      if (!state.lastProbe?.ok || Date.now() - state.lastProbe.at > 5000) {
        throw new AppError(409, "A fresh successful checkout probe is required before starting");
      }
      state.run = { id, scenario, startedAt: Date.now(), deadline: Date.now() + this.timing.deadlineMs, authorized: false };
      state.phase = "INJECTING";
      state.operation = id;
      state.events = [];
      state.healthyCount = 0;
      delete state.healthySince;
      event(state, "controller", "Visitor requested a fault; committing the booth change");
    });
    try {
      const current = await this.git.read();
      if (!isBaseline(current.content)) throw new AppError(409, "Git is not at the known-good booth configuration");
      const sha = await this.git.commit(current.sha, fault(current.content, scenario),
        `booth: inject scenario [run ${id}]`);
      const change = await this.git.read();
      await this.store.change(state => {
        if (state.run?.id !== id || state.operation !== id) throw new AppError(409, "Run superseded");
        state.run.expectedHead = sha;
        state.targetHead = sha;
        if (change.sha === sha) state.change = { sha, diff: change.diff, actor: "controller" };
        delete state.operation;
        event(state, "controller", "Fault committed to Git; waiting for a real failed checkout", sha);
      });
      await this.runtime.refresh();
      return this.store.read();
    } catch (error) {
      await this.fail(id, error);
      throw error;
    }
  }
  async applyRepair(input: Repair, actor: Actor = "agent"): Promise<{ sha: string }> {
    const operation = randomUUID();
    await this.store.change(state => {
      if (!state.run || state.run.id !== input.runId || !state.run.authorized ||
        state.run.expectedHead !== input.expectedHead || state.operation ||
        state.phase !== "INVESTIGATING" || Date.now() >= state.run.deadline) {
        throw new AppError(409, "Repair not authorized: stale run, head, deadline, or phase");
      }
      state.operation = operation;
      state.phase = "REPAIRING";
      // Revoke before any external write; an ambiguous outcome requires an operator.
      state.run.authorized = false;
      event(state, actor, input.evidence);
    });
    try {
      const current = await this.git.read();
      if (current.sha !== input.expectedHead) throw new AppError(409, "Git head changed; repair refused");
      const sha = await this.git.commit(input.expectedHead, repair(current.content, input),
        `booth: corrective manifest change [run ${input.runId}]`);
      const change = await this.git.read();
      await this.store.change(state => {
        if (state.run?.id !== input.runId || state.operation !== operation) return;
        state.run.repairedAt = Date.now();
        state.run.repairActor = actor;
        state.targetHead = sha;
        if (change.sha === sha) state.change = { sha, diff: change.diff, actor };
        state.run.expectedHead = sha;
        state.phase = "VERIFYING";
        state.healthyCount = 0;
        delete state.healthySince;
        delete state.operation;
        event(state, actor, "Corrective Git commit created; awaiting reconciliation and functional verification", sha);
      });
      await this.runtime.refresh();
      return { sha };
    } catch (error) {
      await this.fail(input.runId, error);
      throw error;
    }
  }
  async reset(): Promise<State> {
    const operation = randomUUID();
    await this.store.change(state => {
      if (state.phase === "RESETTING") throw new AppError(409, "Reset is already in progress");
      if (state.run) state.run.authorized = false;
      state.operation = operation;
      state.phase = "RESETTING";
      state.resetAt = Date.now();
      state.healthyCount = 0;
      delete state.healthySince;
      event(state, "operator", "Repair authorization revoked; restoring the baseline through Git");
    });
    try {
      const current = await this.git.read();
      // Always create a new commit, even if the content is unchanged. This fences old Git writes.
      const sha = await this.git.commit(current.sha, baseline(current.content), `booth: operator baseline reset [${operation}]`);
      await this.store.change(state => {
        if (state.operation !== operation) throw new AppError(409, "Reset superseded");
        state.targetHead = sha;
        delete state.operation;
        event(state, "operator", "Baseline committed; verifying deployed revision and sustained checkout health", sha);
      });
      await this.runtime.refresh();
      return this.store.read();
    } catch (error) {
      await this.store.change(state => {
        if (state.operation !== operation && state.phase !== "RESETTING") return;
        state.phase = "OPERATOR_REQUIRED";
        delete state.operation;
        event(state, "operator", `Reset failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      throw error;
    }
  }
  private async fail(runId: string, error: unknown): Promise<void> {
    await this.store.change(state => {
      if (state.run?.id !== runId || state.phase === "RESETTING") return;
      state.phase = "OPERATOR_REQUIRED";
      state.run.authorized = false;
      delete state.operation;
      event(state, "controller", `Run stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  async evidence(runId: string) {
    const state = await this.store.read();
    if (state.run?.id !== runId) throw new AppError(409, "Run is no longer current");
    const [git, deployment, runtime] = await Promise.all([
      this.git.read(), this.runtime.deployment(), this.runtime.evidence()
    ]);
    return { runId, phase: state.phase, expectedHead: state.run.expectedHead,
      probe: state.lastProbe, git, deployment, runtime };
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await probe(this.checkoutUrl);
      let state = await this.store.change(s => {
        s.lastProbe = result;
        s.probeHistory = [...(s.probeHistory ?? []), { at: result.at, ok: result.ok }]
          .filter(sample => sample.at >= result.at - 300_000).slice(-301);
      });
      if (state.phase === "READY" && !result.ok) {
        await this.store.change(s => {
          if (s.phase !== "READY") return;
          s.phase = "OPERATOR_REQUIRED";
          event(s, "controller", "Baseline checkout became unhealthy; operator verification required before accepting visitors");
        });
        return;
      }
      if (state.phase === "RESETTING" && state.resetAt && Date.now() - state.resetAt >= this.timing.deadlineMs) {
        await this.store.change(s => {
          if (s.phase !== "RESETTING") return;
          s.phase = "OPERATOR_REQUIRED";
          delete s.operation;
          event(s, "operator", "Baseline reset verification timed out; inspect deployment and request reset again");
        });
        return;
      }
      if (state.run && !["READY", "RESETTING", "OPERATOR_REQUIRED", "RECOVERED"].includes(state.phase) &&
        Date.now() >= state.run.deadline) {
        await this.fail(state.run.id, new Error("180-second run deadline exceeded; operator reset required"));
        return;
      }
      if (state.phase === "INJECTING" && state.run && !state.operation && !result.ok) {
        const runId = state.run.id;
        const deployment = await this.runtime.deployment();
        if (!deployment.synced || deployment.revision !== state.targetHead) return;
        state = await this.store.change(s => {
          if (s.run?.id !== runId || s.phase !== "INJECTING") return;
          s.phase = "FAULT_OBSERVED";
          s.run.faultAt = Date.now();
          event(s, "controller", `Real checkout failure observed: ${result.detail}`);
        });
      }
      if (state.phase === "FAULT_OBSERVED" && state.run) {
        const runId = state.run.id;
        await this.store.change(s => {
          if (s.run?.id !== runId || s.phase !== "FAULT_OBSERVED" || s.run.triggerAttempted) {
            throw new AppError(409, "Trigger already attempted or run superseded");
          }
          s.phase = "INVESTIGATING";
          s.run.triggerAttempted = true;
          s.run.invokedAt = Date.now();
          s.run.authorized = true;
          event(s, "controller", "Invoking investigation; no scenario or prescribed fix is supplied to the agent");
        });
        try {
          const execution = await this.trigger.invoke({
            ...this.context, runId, checkoutUrl: this.checkoutUrl, observedAt: result.at, symptom: result.detail
          });
          await this.store.change(s => {
            if (s.run?.id !== runId || s.phase !== "INVESTIGATING") return;
            s.run.threadId = execution.threadId;
            event(s, "controller", execution.threadId ?
              `Agent accepted investigation (thread ${execution.threadId})` :
              "LOCAL REHEARSAL: no agent invoked. Operator must diagnose and submit a repair.");
          });
        } catch (error) {
          await this.fail(runId, new Error(`Trigger outcome may be ambiguous; do not retry automatically. ${String(error)}`));
        }
        return;
      }
      state = await this.store.read();
      if ((state.phase === "RESETTING" || state.phase === "VERIFYING") && !state.operation) {
        const phase = state.phase;
        const head = state.targetHead;
        const [deployment, git] = await Promise.all([this.runtime.deployment(), this.git.read()]);
        const healthy = result.ok && deployment.synced && deployment.healthy &&
          deployment.revision === head && git.sha === head && isBaseline(git.content);
        await this.store.change(s => {
          if (s.phase !== phase || s.targetHead !== head || s.operation) return;
          if (!healthy) {
            s.healthyCount = 0;
            delete s.healthySince;
            return;
          }
          s.healthySince ??= result.at;
          s.healthyCount++;
          if (s.healthyCount < this.timing.healthyCount || result.at - s.healthySince < this.timing.healthyMs) return;
          if (phase === "VERIFYING" && s.run) {
            s.run.recoveredAt = Date.now();
            s.run.authorized = false;
            s.phase = "RECOVERED";
            event(s, s.run.repairActor ?? "controller", "Ten seconds of successful checkout; Git and deployment agree. Recovery verified.");
          } else {
            if (s.run) {
              s.history = [...s.history, s.run].slice(-100);
              delete s.run;
            }
            s.phase = "READY";
            event(s, "operator", "Baseline verified; ready for the next visitor");
          }
        });
      } else if (state.phase === "RECOVERED") {
        await this.store.change(s => {
          if (s.phase !== "RECOVERED") return;
          if (s.run) {
            s.history = [...s.history, s.run].slice(-100);
            delete s.run;
          }
          s.phase = "READY";
          event(s, "controller", "Corrected baseline retained; ready for the next visitor");
        });
      }
    } catch (error) {
      await this.store.change(state => {
        if (state.phase === "READY" || state.phase === "OPERATOR_REQUIRED") return;
        if (state.run) state.run.authorized = false;
        state.phase = "OPERATOR_REQUIRED";
        delete state.operation;
        event(state, "controller", `Verification/control error: ${error instanceof Error ? error.message : String(error)}`);
      });
      throw error;
    } finally { this.ticking = false; }
  }
}
