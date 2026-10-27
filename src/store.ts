import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TableClient } from "@azure/data-tables";
import type { TokenCredential } from "@azure/identity";
import { initialState, type State, type Store } from "./domain.js";

function isStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === status;
}
export class FileStore implements Store {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private path: string) {}
  async read(): Promise<State> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as State; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return initialState();
      throw error;
    }
  }
  change(fn: (state: State) => void): Promise<State> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      fn(state);
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path + ".tmp", JSON.stringify(state), { mode: 0o600 });
      await rename(this.path + ".tmp", this.path);
      return state;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
export class TableStore implements Store {
  private client: TableClient;
  constructor(endpoint: string, table: string, credential: TokenCredential) {
    this.client = new TableClient(endpoint, table, credential);
  }
  private async entity() {
    try {
      return await this.client.getEntity<Record<string, string | number>>("booth", "state");
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
      try {
        await this.client.createEntity({ partitionKey: "booth", rowKey: "state",
          ...encodeState(initialState()) });
      } catch (createError) { if (!isStatus(createError, 409)) throw createError; }
      return this.client.getEntity<Record<string, string | number>>("booth", "state");
    }
  }
  async read(): Promise<State> { return decodeState(await this.entity()); }
  async change(fn: (state: State) => void): Promise<State> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entity = await this.entity();
      if (!entity.etag) throw new Error("Table state response is missing an ETag; refusing an unconditional write");
      const state = decodeState(entity);
      fn(state);
      try {
        await this.client.updateEntity({
          partitionKey: "booth", rowKey: "state", ...encodeState(state)
        }, "Replace", { etag: entity.etag });
        return state;
      } catch (error) { if (!isStatus(error, 412)) throw error; }
    }
    throw new Error("Run state contention exceeded retry limit");
  }
}
export function encodeState(state: State): Record<string, string | number> {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64");
  if (payload.length > 500_000) throw new Error("Run state exceeds the Table entity size budget; export and archive history");
  const chunks = Math.ceil(payload.length / 30_000);
  return Object.fromEntries([["chunks", chunks],
    ...Array.from({ length: chunks }, (_, i) => [`part${i}`, payload.slice(i * 30_000, (i + 1) * 30_000)])]);
}
export function decodeState(entity: Record<string, unknown>): State {
  if (typeof entity.chunks !== "number" || !Number.isInteger(entity.chunks) || entity.chunks < 1 || entity.chunks > 17) {
    throw new Error("Invalid persisted Table run state");
  }
  const parts = Array.from({ length: entity.chunks }, (_, i) => {
    const part = entity[`part${i}`];
    if (typeof part !== "string") throw new Error("Missing persisted Table run-state chunk");
    return part;
  });
  return JSON.parse(Buffer.from(parts.join(""), "base64").toString("utf8")) as State;
}
