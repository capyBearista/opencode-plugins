import { homedir } from "node:os";
import { isServerCommand, readPtyDaemonRuntimeDir } from "./command.js";
import { debugLog, getErrorMessage } from "./debug.js";
import { type ProcessEntry, type ProcessSnapshot, takeProcessSnapshot } from "./snapshot.js";

const SERVER_INFO_TIMEOUT_MS = 2000;

export interface RamBreakdown {
  readonly opencode: number;
  readonly tools: number;
  readonly total: number;
}

export interface ProcessLayout {
  readonly tuiPid: number;
  readonly serverPid: number | null;
  readonly terminalPids: readonly number[];
}

export interface Inspection {
  readonly entries: readonly ProcessEntry[];
  readonly layout: ProcessLayout;
  readonly notice: string | null;
}

export interface ServerInfoClient {
  readonly server: {
    info(options?: { readonly signal?: AbortSignal }): Promise<{ readonly pid: number }>;
  };
}

export interface InspectOptions {
  readonly tuiPid?: number;
  readonly home?: string;
  readonly takeSnapshot?: () => Promise<ProcessSnapshot>;
}

export function findServer(
  entries: readonly ProcessEntry[],
  reportedPid: number | null,
  tuiPid: number,
): number | null {
  if (reportedPid === null || reportedPid === tuiPid) return null;
  const server = entries.find((item) => item.pid === reportedPid);
  return server && isServerCommand(server.command) ? server.pid : null;
}

function isUnder(path: string, directory: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  const parent = normalize(directory);
  const child = normalize(path);
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`);
}

// A server spawns its terminal daemon detached, so after a server restart the
// daemon survives under init and would drop out of the server's subtree.
export function findOrphanPtyDaemons(entries: readonly ProcessEntry[], home: string): number[] {
  const byPid = new Map(entries.map((item) => [item.pid, item]));
  return entries
    .filter((item) => {
      const runtimeDir = readPtyDaemonRuntimeDir(item.command);
      if (runtimeDir === null || !isUnder(runtimeDir, home)) return false;
      const parent = byPid.get(item.ppid);
      return !parent || !isServerCommand(parent.command);
    })
    .map((item) => item.pid);
}

function collectSubtree(entries: readonly ProcessEntry[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const item of entries) {
    const siblings = children.get(item.ppid);
    if (siblings) siblings.push(item.pid);
    else children.set(item.ppid, [item.pid]);
  }

  const seen = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return seen;
}

export function toolPids(entries: readonly ProcessEntry[], layout: ProcessLayout): Set<number> {
  const pids = new Set<number>();
  if (layout.serverPid !== null) {
    for (const pid of collectSubtree(entries, layout.serverPid)) pids.add(pid);
  }
  for (const daemon of layout.terminalPids) {
    for (const pid of collectSubtree(entries, daemon)) pids.add(pid);
  }
  pids.delete(layout.tuiPid);
  if (layout.serverPid !== null) pids.delete(layout.serverPid);
  return pids;
}

export function measureRam(
  entries: readonly ProcessEntry[],
  layout: ProcessLayout,
  fallbackTuiRss: number,
): RamBreakdown {
  const rssByPid = new Map(entries.map((item) => [item.pid, item.rss]));
  const tui = rssByPid.get(layout.tuiPid) ?? fallbackTuiRss;
  const server = layout.serverPid === null ? 0 : (rssByPid.get(layout.serverPid) ?? 0);
  let tools = 0;
  for (const pid of toolPids(entries, layout)) tools += rssByPid.get(pid) ?? 0;
  const opencode = tui + server;
  return { opencode, tools, total: opencode + tools };
}

async function readServerPid(client: ServerInfoClient): Promise<number | null> {
  try {
    const info = await client.server.info({ signal: AbortSignal.timeout(SERVER_INFO_TIMEOUT_MS) });
    return Number.isSafeInteger(info.pid) && info.pid > 0 ? info.pid : null;
  } catch (error) {
    await debugLog("server-info-failed", { error: getErrorMessage(error) });
    return null;
  }
}

export async function inspectProcesses(
  client: ServerInfoClient,
  options: InspectOptions = {},
): Promise<Inspection> {
  const tuiPid = options.tuiPid ?? process.pid;
  const takeSnapshot = options.takeSnapshot ?? takeProcessSnapshot;
  const [snapshot, reportedPid] = await Promise.all([
    takeSnapshot().catch(() => null),
    readServerPid(client),
  ]);

  if (snapshot === null) {
    return {
      entries: [],
      layout: { tuiPid, serverPid: null, terminalPids: [] },
      notice: "process list unavailable",
    };
  }

  const serverPid = findServer(snapshot.entries, reportedPid, tuiPid);
  return {
    entries: snapshot.entries,
    layout: {
      tuiPid,
      serverPid,
      terminalPids: findOrphanPtyDaemons(snapshot.entries, options.home ?? homedir()),
    },
    notice: serverPid === null ? "server not visible" : null,
  };
}
