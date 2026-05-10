import { exec } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { debugLog } from "./debug.js";

const EXEC_OPTS = { timeout: 5000, windowsHide: true };
const execAsync = promisify(exec);

export interface ProcessEntry {
  pid: number;
  ppid: number;
  rss: number;
  command: string;
}

export interface ProcessSnapshot {
  entries: ProcessEntry[];
  parentByPid: Map<number, number>;
  takenAt: number;
}

function parseStrictPositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export function parsePsProcessSnapshot(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;

    const pid = parseStrictPositiveInteger(match[1]);
    const ppid = parseStrictPositiveInteger(match[2]);
    const rssKb = parseStrictPositiveInteger(match[3]);
    if (pid === null || ppid === null || rssKb === null) continue;

    entries.push({
      pid,
      ppid,
      rss: rssKb * 1024,
      command: match[4].trim(),
    });
  }

  return entries;
}

export function parseWmicProcessSnapshot(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  const normalized = stdout.replace(/\r\n/g, "\n").trim();
  if (!normalized) return entries;

  for (const block of normalized.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const entry: Record<string, string> = {};

    for (const line of lines) {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      entry[key] = value;
    }

    const pid = parseStrictPositiveInteger(entry.ProcessId || "");
    const ppid = parseStrictPositiveInteger(entry.ParentProcessId || "");
    const rss = parseStrictPositiveInteger(entry.WorkingSetSize || "");
    const command = (entry.CommandLine || entry.Name || "").trim();
    if (pid === null || ppid === null || rss === null || !command) continue;

    entries.push({
      pid,
      ppid,
      rss,
      command,
    });
  }

  return entries;
}

export async function takeProcessSnapshot(): Promise<ProcessSnapshot> {
  const osPlatform = platform();
  const takenAt = Date.now();

  try {
    if (osPlatform === "linux" || osPlatform === "darwin") {
      const { stdout } = await execAsync("ps -A -o pid= -o ppid= -o rss= -o command=", EXEC_OPTS);
      const entries = parsePsProcessSnapshot(stdout);
      return {
        entries,
        parentByPid: new Map(entries.map((entry) => [entry.pid, entry.ppid])),
        takenAt,
      };
    }

    if (osPlatform === "win32") {
      const { stdout } = await execAsync(
        "wmic process get CommandLine,ParentProcessId,ProcessId,WorkingSetSize /format:value",
        EXEC_OPTS,
      );
      const entries = parseWmicProcessSnapshot(stdout);
      return {
        entries,
        parentByPid: new Map(entries.map((entry) => [entry.pid, entry.ppid])),
        takenAt,
      };
    }

    return {
      entries: [],
      parentByPid: new Map(),
      takenAt,
    };
  } catch (error) {
    await debugLog("process-snapshot-failed", {
      platform: osPlatform,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export type SnapshotFetcher = () => Promise<ProcessSnapshot>;

export class ProcessSnapshotCache {
  private snapshot: ProcessSnapshot | null = null;
  private pending: Promise<ProcessSnapshot> | null = null;
  private ttlMs = 5000;

  constructor(private readonly fetcher: SnapshotFetcher = takeProcessSnapshot) {}

  invalidate(): void {
    this.snapshot = null;
  }

  setTtlMs(ttlMs: number): void {
    if (!Number.isFinite(ttlMs)) return;
    const normalized = Math.max(1000, Math.min(60_000, Math.floor(ttlMs)));
    this.ttlMs = normalized;
  }

  async get(forceRefresh = false): Promise<ProcessSnapshot> {
    const cached = this.snapshot;
    if (!forceRefresh && cached && Date.now() - cached.takenAt < this.ttlMs) {
      return cached;
    }

    if (this.pending) {
      return this.pending;
    }

    this.pending = this.fetcher()
      .then((snapshot) => {
        this.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }
}

export const processSnapshotCache = new ProcessSnapshotCache();
