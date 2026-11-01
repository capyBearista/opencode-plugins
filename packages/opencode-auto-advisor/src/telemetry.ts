import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Attempt } from "./fallback.js";

export const MAX_BYTES = 5 * 1024 * 1024;
/** Requests can be uncapped; their full text stays in the session. */
export const LOGGED_INPUT_CHARS = 32_000;

/**
 * One line per routing opportunity. Keeps the Decision input (its end) so a verdict can be
 * judged later; never the Advisor transcript or advice text.
 */
export interface TelemetryRecord {
  readonly ts: string;
  readonly session: string;
  readonly turn: string;
  readonly step: number;
  /** Id of the newest non-system message in the request, to find this step in the session. */
  readonly message?: string;
  /** The Decision input's last `LOGGED_INPUT_CHARS` characters: the steps and counts. */
  readonly input: string;
  readonly inputChars: number;
  readonly mode: "observe" | "active";
  readonly attempts: readonly Attempt[];
  readonly model?: string;
  readonly cost?: number;
  readonly moment?: Record<string, number>;
  readonly consequence?: number;
  readonly verdict: string;
  /** Set when the per-turn budget or the cooldown kept an automatic consult from starting. */
  readonly blocked?: "budget" | "cooldown";
  readonly advisor?: {
    readonly model: string;
    readonly ms: number;
    readonly outcome: "ok" | "error" | "timeout" | "stale";
    readonly chars?: number;
    /** One per Advisor model tried, in chain order. */
    readonly attempts?: readonly Attempt[];
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
    // Size check, rotation and append all go through one handle, so they always see the same file.
    const file = await open(path, "a+", 0o600);
    try {
      // Owner only, also for a file created before the log held Decision inputs.
      // A file owned by someone else can't be changed; still append to it.
      await file.chmod(0o600).catch(() => {});
      const { size } = await file.stat();
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        await writeFile(`${path}.1`, await file.readFile(), { mode: 0o600 });
        await chmod(`${path}.1`, 0o600);
        await file.truncate(0);
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
