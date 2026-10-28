import { mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Attempt } from "./decisions.js";

export const MAX_BYTES = 5 * 1024 * 1024;

/** One line per routing opportunity. Never transcript or advice text. */
export interface TelemetryRecord {
  readonly ts: string;
  readonly session: string;
  readonly turn: string;
  readonly step: number;
  readonly mode: "observe" | "active";
  readonly attempts: readonly Attempt[];
  readonly model?: string;
  readonly cost?: number;
  readonly moment?: Record<string, number>;
  readonly consequence?: number;
  readonly verdict: string;
  readonly advisor?: {
    readonly model: string;
    readonly ms: number;
    readonly outcome: "ok" | "error" | "timeout" | "stale";
    readonly chars?: number;
  };
  readonly delivered: boolean;
}

export function resolveTelemetryPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return join(data, "opencode", "auto-advisor", "telemetry.jsonl");
}

/** Appends in order, rotating to `<file>.1` past `maxBytes`. Failures are swallowed. */
export function createTelemetry(path: string = resolveTelemetryPath(), maxBytes = MAX_BYTES) {
  let queue: Promise<void> = Promise.resolve();
  const write = async (line: string) => {
    await mkdir(dirname(path), { recursive: true });
    // Size check and append go through one handle, so they always see the same file.
    let file = await open(path, "a");
    try {
      const { size } = await file.stat();
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        await file.close();
        await rename(path, `${path}.1`);
        file = await open(path, "a");
      }
      await file.appendFile(line);
    } finally {
      await file.close();
    }
  };
  return {
    record(entry: TelemetryRecord): void {
      const line = `${JSON.stringify(entry)}\n`;
      queue = queue.then(() => write(line)).catch(() => {});
    },
    /** For tests and disposal. */
    flush: () => queue,
  };
}
