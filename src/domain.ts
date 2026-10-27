import { z } from "zod";

export const scenarioSchema = z.enum(["port", "configuration", "scheduling"]);
export type Scenario = z.infer<typeof scenarioSchema>;
export const repairSchema = z.object({
  runId: z.string().uuid(),
  expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
  field: z.enum(["targetPort", "checkoutMode", "nodeSelector"]),
  value: z.union([z.number(), z.string(), z.record(z.string(), z.string())]),
  evidence: z.string().min(20).max(2000)
}).strict();
export type Repair = z.infer<typeof repairSchema>;
export type Phase = "READY" | "INJECTING" | "FAULT_OBSERVED" | "INVESTIGATING" |
  "REPAIRING" | "VERIFYING" | "RECOVERED" | "RESETTING" | "OPERATOR_REQUIRED";
export type Actor = "agent" | "operator" | "controller" | "watchdog";
export interface Event {
  at: number;
  actor: Actor;
  message: string;
  sha?: string;
}
export interface Run {
  id: string;
  scenario: Scenario;
  startedAt: number;
  deadline: number;
  faultAt?: number;
  invokedAt?: number;
  triggerAttempted?: boolean;
  threadId?: string;
  repairedAt?: number;
  recoveredAt?: number;
  repairActor?: Actor;
  expectedHead?: string;
  authorized: boolean;
}
export interface State {
  phase: Phase;
  run?: Run;
  events: Event[];
  history: Run[];
  operation?: string;
  targetHead?: string;
  healthyCount: number;
  healthySince?: number;
  lastProbe?: Probe;
  change?: { sha: string; diff: string; actor: Actor };
  resetAt?: number;
}
export interface Probe { ok: boolean; at: number; latencyMs: number; detail: string }
export interface Snapshot { sha: string; content: string; diff: string }
export interface Deployment {
  synced: boolean;
  healthy: boolean;
  revision: string;
  detail: string;
}
export interface GitPort {
  read(): Promise<Snapshot>;
  commit(expectedHead: string, content: string, message: string): Promise<string>;
}
export interface RuntimePort {
  refresh(): Promise<void>;
  deployment(): Promise<Deployment>;
  evidence(): Promise<unknown>;
  close?(): Promise<void>;
}
export interface TriggerPort {
  invoke(context: Record<string, unknown>): Promise<{ threadId?: string }>;
}
export interface Store {
  read(): Promise<State>;
  change(fn: (state: State) => void): Promise<State>;
}
export function initialState(): State {
  return { phase: "OPERATOR_REQUIRED", events: [], history: [], healthyCount: 0 };
}
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function event(state: State, actor: Actor, message: string, sha?: string): void {
  state.events.push({ at: Date.now(), actor, message, ...(sha ? { sha } : {}) });
  state.events = state.events.slice(-80);
}
