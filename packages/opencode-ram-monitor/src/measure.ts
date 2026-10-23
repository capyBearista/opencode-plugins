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

function isUnder(path: string, directory: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const trimmed = value.replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const parent = normalize(directory);
  const child = normalize(path);
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`);
}

// A server spawns its terminal daemon detached, so after a server restart the
// daemon survives under init and would drop out of the server's subtree.
export function findOrphanPtyDaemons(
  entries: readonly ProcessEntry[],
  home: string,
  platform: NodeJS.Platform = process.platform,
): number[] {
  const byPid = new Map(entries.map((item) => [item.pid, item]));
  return entries
    .filter((item) => {
      const runtimeDir = readPtyDaemonRuntimeDir(item.command);
      if (runtimeDir === null || !isUnder(runtimeDir, home, platform)) return false;
      const parent = byPid.get(item.ppid);
      return !parent || !isServerCommand(parent.command);
    })
    .map((item) => item.pid);
}

export type ChildrenByParent = ReadonlyMap<number, readonly ProcessEntry[]>;

export function childrenByParent(entries: readonly ProcessEntry[]): ChildrenByParent {
  const children = new Map<number, ProcessEntry[]>();
  for (const item of entries) {
    if (item.ppid === item.pid) continue;
    const siblings = children.get(item.ppid);
    if (siblings) siblings.push(item);
    else children.set(item.ppid, [item]);
  }
  return children;
}

function collectSubtree(
  children: ChildrenByParent,
  rootPid: number,
  skip: ReadonlySet<number> = new Set(),
): Set<number> {
  const seen = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    if (seen.has(pid) || (pid !== rootPid && skip.has(pid))) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) pending.push(child.pid);
  }
  return seen;
}

function separateRoots(layout: ProcessLayout): Set<number> {
  const roots = new Set<number>(layout.terminalPids);
  if (layout.serverPid !== null) roots.add(layout.serverPid);
  return roots;
}

// The TUI's share stops at any server process, verified or not, so a server
// that could not be verified never lands in "OpenCode" with its tools.
export function tuiBoundary(entries: readonly ProcessEntry[], layout: ProcessLayout): Set<number> {
  const boundary = separateRoots(layout);
  for (const item of entries) {
    if (isServerCommand(item.command)) boundary.add(item.pid);
  }
  return boundary;
}

export function measureRam(
  entries: readonly ProcessEntry[],
  layout: ProcessLayout,
  fallbackTuiRss: number,
): RamBreakdown {
  const rssByPid = new Map(entries.map((item) => [item.pid, item.rss]));
  const children = childrenByParent(entries);
  const roots = separateRoots(layout);
  const sum = (pids: Iterable<number>) => {
    let total = 0;
    for (const pid of pids) total += rssByPid.get(pid) ?? 0;
    return total;
  };

  const tui = rssByPid.has(layout.tuiPid)
    ? sum(collectSubtree(children, layout.tuiPid, tuiBoundary(entries, layout)))
    : fallbackTuiRss;
  const server = layout.serverPid === null ? 0 : (rssByPid.get(layout.serverPid) ?? 0);

  const tools = new Set<number>();
  for (const root of roots) {
    for (const pid of collectSubtree(children, root)) tools.add(pid);
  }
  tools.delete(layout.tuiPid);
  if (layout.serverPid !== null) tools.delete(layout.serverPid);

  const opencode = tui + server;
  const toolsRss = sum(tools);
  return { opencode, tools: toolsRss, total: opencode + toolsRss };
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
