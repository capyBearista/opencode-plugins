import { exec } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { debugLog } from "./debug.js";

const EXEC_OPTS = { timeout: 5000, windowsHide: true };
const execAsync = promisify(exec);
const BULK_SNAPSHOT_MIN_PID_COUNT = 4;

export function shouldUseBulkSnapshot(pidCount: number): boolean {
  return pidCount >= BULK_SNAPSHOT_MIN_PID_COUNT;
}

function splitCommandTokens(commandLine: string): string[] {
  const matches = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) return [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function getTokenBaseName(token: string): string {
  const parts = token
    .toLowerCase()
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function classifyOpencodeBinary(token: string): "core" | "launcher" | null {
  const baseName = getTokenBaseName(token);
  if (baseName === ".opencode" || baseName === ".opencode.exe") return "core";
  if (baseName === "opencode" || baseName === "opencode.exe") return "launcher";
  return null;
}

function nodeOrBunOptionConsumesNextToken(token: string): boolean {
  if (token === "-r" || token === "--require") return true;
  if (token === "--loader" || token === "--import") return true;
  if (token === "-e" || token === "--eval") return true;
  if (token === "-p" || token === "--print") return true;
  if (token === "--env-file") return true;
  return false;
}

export function classifyOpencodeProcess(commandLine: string): "core" | "launcher" | null {
  const tokens = splitCommandTokens(commandLine);
  if (tokens.length === 0) return null;

  const first = getTokenBaseName(tokens[0]);
  const firstClassification = classifyOpencodeBinary(tokens[0]);
  if (firstClassification) return firstClassification;

  if (first === "node" || first === "node.exe" || first === "bun" || first === "bun.exe") {
    let skipNextToken = false;
    for (let index = 1; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token) continue;

      if (skipNextToken) {
        skipNextToken = false;
        continue;
      }

      if (token === "--") {
        if (index + 1 < tokens.length) {
          return classifyOpencodeBinary(tokens[index + 1]);
        }
        return null;
      }

      if (token.startsWith("-")) {
        if (nodeOrBunOptionConsumesNextToken(token)) {
          skipNextToken = !token.includes("=");
        }
        continue;
      }

      return classifyOpencodeBinary(token);
    }
  }

  return null;
}

type OpenCodePidSets = {
  core: Set<number>;
  launcher: Set<number>;
  all: Set<number>;
};

function parseLockfilePid(content: string): number | null {
  try {
    const data = JSON.parse(content);
    if (typeof data?.pid === "number") return data.pid;
  } catch {
    const pid = parseInt(content.trim(), 10);
    if (!Number.isNaN(pid)) return pid;
  }

  return null;
}

async function getLiveOpencodePidSets(): Promise<OpenCodePidSets> {
  const osPlatform = platform();
  const core = new Set<number>();
  const launcher = new Set<number>();

  if (osPlatform === "linux" || osPlatform === "darwin") {
    try {
      const { stdout } = await execAsync("ps -A -o pid= -o command=", EXEC_OPTS);

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const firstSpace = trimmed.indexOf(" ");
        if (firstSpace === -1) continue;

        const pid = parseInt(trimmed.slice(0, firstSpace), 10);
        if (Number.isNaN(pid)) continue;

        const args = trimmed.slice(firstSpace + 1);
        const processKind = classifyOpencodeProcess(args);
        if (processKind === "core") core.add(pid);
        if (processKind === "launcher") launcher.add(pid);
      }
    } catch (error) {
      await debugLog("live-opencode-pids-failed", {
        platform: osPlatform,
        source: "ps",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (osPlatform === "win32") {
    try {
      const { stdout } = await execAsync(
        "wmic process get CommandLine,ProcessId /format:value",
        EXEC_OPTS,
      );

      const normalized = stdout.replace(/\r\n/g, "\n").trim();
      const blocks = normalized.split(/\n\n+/);

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        const entry: Record<string, string> = {};
        for (const line of lines) {
          const separatorIndex = line.indexOf("=");
          if (separatorIndex === -1) continue;
          const key = line.slice(0, separatorIndex).trim();
          const value = line.slice(separatorIndex + 1).trim();
          entry[key] = value;
        }

        const pid = parseInt(entry.ProcessId, 10);
        if (Number.isNaN(pid)) continue;

        const processKind = classifyOpencodeProcess(entry.CommandLine || "");
        if (processKind === "core") core.add(pid);
        if (processKind === "launcher") launcher.add(pid);
      }
    } catch (error) {
      await debugLog("live-opencode-pids-failed", {
        platform: osPlatform,
        source: "wmic",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const all = new Set<number>([...core, ...launcher]);
  return { core, launcher, all };
}

export function selectValidatedSessionPids(
  candidates: number[],
  liveOpencodePids: Set<number>,
  currentPid: number = process.pid,
): number[] {
  const selected = new Set<number>();
  selected.add(currentPid);

  for (const pid of candidates) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === currentPid) {
      selected.add(pid);
      continue;
    }
    if (liveOpencodePids.has(pid)) {
      selected.add(pid);
    }
  }

  return [...selected];
}

export function resolveActiveSessionPids(
  liveSets: OpenCodePidSets,
  lockfileCandidates: number[],
  currentPid: number = process.pid,
): number[] {
  return selectValidatedSessionPids(
    [currentPid, ...lockfileCandidates, ...liveSets.all],
    liveSets.all,
    currentPid,
  );
}

async function readLockfileCandidates(): Promise<number[]> {
  const candidates: number[] = [];
  const stateDirs = [
    join(homedir(), ".opencode", "state"),
    join(homedir(), ".cache", "opencode", "state"),
    join(homedir(), ".local", "state", "opencode"),
    join(homedir(), ".local", "state", "opencode", "locks"),
  ];

  for (const dir of stateDirs) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".lock")) continue;
        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, "utf-8");
          const pid = parseLockfilePid(content);
          if (pid !== null) candidates.push(pid);
        } catch (error) {
          await debugLog("lockfile-read-failed", {
            file: filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      await debugLog("state-dir-read-failed", {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return candidates;
}

export async function getActiveSessions(): Promise<number[]> {
  const [liveSets, lockfileCandidates] = await Promise.all([
    getLiveOpencodePidSets(),
    readLockfileCandidates(),
  ]);

  const runtimeCandidates = [...liveSets.all];
  const validated = resolveActiveSessionPids(liveSets, lockfileCandidates, process.pid);

  await debugLog("active-sessions-resolved", {
    candidates: lockfileCandidates.length + runtimeCandidates.length + 1,
    lockfileCandidates: lockfileCandidates.length,
    runtimeCandidates: runtimeCandidates.length,
    validated: validated.length,
  });

  return validated;
}

export interface LightweightRamResult {
  current: number;
  total: number;
  count: number;
}

function parseStrictPositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export function parsePsRssSnapshot(stdout: string): Map<number, number> {
  const rssByPid = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseStrictPositiveInteger(parts[0]);
    const rssKb = parseStrictPositiveInteger(parts[1]);
    if (pid !== null && rssKb !== null) {
      rssByPid.set(pid, rssKb * 1024);
    }
  }
  return rssByPid;
}

export function parseWmicWorkingSetSnapshot(stdout: string): Map<number, number> {
  const rssByPid = new Map<number, number>();
  const normalized = stdout.replace(/\r\n/g, "\n").trim();
  if (!normalized) return rssByPid;

  let pendingPid: number | null = null;
  let pendingRss: number | null = null;

  const flush = () => {
    if (pendingPid !== null && pendingRss !== null) {
      rssByPid.set(pendingPid, pendingRss);
    }
    pendingPid = null;
    pendingRss = null;
  };

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();

    if (key === "ProcessId") {
      if (pendingPid !== null || pendingRss !== null) flush();
      pendingPid = parseStrictPositiveInteger(value);
      continue;
    }

    if (key === "WorkingSetSize") {
      pendingRss = parseStrictPositiveInteger(value);
      if (pendingPid !== null && pendingRss !== null) flush();
    }
  }

  flush();
  return rssByPid;
}

export async function sampleDarwinRssWithFallback(
  pids: number[],
  execFn: (command: string) => Promise<{ stdout: string }>,
  onPidError?: (pid: number, source: string, error: unknown) => Promise<void> | void,
  onPartialCoverage?: (missingPids: number[], source: string) => Promise<void> | void,
): Promise<Map<number, number>> {
  try {
    const { stdout } = await execFn("ps -A -o pid= -o rss=");
    const snapshot = parsePsRssSnapshot(stdout);
    const matched = new Map<number, number>();
    for (const pid of pids) {
      const rss = snapshot.get(pid);
      if (rss !== undefined) matched.set(pid, rss);
    }
    if (matched.size === pids.length) return matched;
    if (matched.size > 0) {
      const missingPids = pids.filter((pid) => !matched.has(pid));
      if (missingPids.length > 0) {
        await onPartialCoverage?.(missingPids, "ps");
      }
      const merged = new Map(matched);
      for (const pid of missingPids) {
        try {
          const { stdout: pidStdout } = await execFn(`ps -o rss= -p ${pid}`);
          const rssKb = parseStrictPositiveInteger(pidStdout.trim());
          if (rssKb !== null) {
            merged.set(pid, rssKb * 1024);
          } else {
            await onPidError?.(pid, "ps", new Error("per-pid rss parse failed"));
          }
        } catch (error) {
          await onPidError?.(pid, "ps", error);
        }
      }
      return merged;
    }
    throw new Error("darwin bulk snapshot parsed no usable RSS rows");
  } catch {
    const rssByPid = new Map<number, number>();
    for (const pid of pids) {
      try {
        const { stdout } = await execFn(`ps -o rss= -p ${pid}`);
        const rssKb = parseStrictPositiveInteger(stdout.trim());
        if (rssKb !== null) {
          rssByPid.set(pid, rssKb * 1024);
        } else {
          await onPidError?.(pid, "ps", new Error("per-pid rss parse failed"));
        }
      } catch (error) {
        await onPidError?.(pid, "ps", error);
      }
    }
    if (rssByPid.size === 0) {
      throw new Error("darwin rss sampling failed for all candidate PIDs");
    }
    return rssByPid;
  }
}

export async function sampleDarwinRssPerPid(
  pids: number[],
  execFn: (command: string) => Promise<{ stdout: string }>,
  onPidError?: (pid: number, source: string, error: unknown) => Promise<void> | void,
): Promise<Map<number, number>> {
  const rssByPid = new Map<number, number>();
  for (const pid of pids) {
    try {
      const { stdout } = await execFn(`ps -o rss= -p ${pid}`);
      const rssKb = parseStrictPositiveInteger(stdout.trim());
      if (rssKb !== null) {
        rssByPid.set(pid, rssKb * 1024);
      } else {
        await onPidError?.(pid, "ps", new Error("per-pid rss parse failed"));
      }
    } catch (error) {
      await onPidError?.(pid, "ps", error);
    }
  }
  return rssByPid;
}

export async function sampleWindowsRssWithFallback(
  pids: number[],
  execFn: (command: string) => Promise<{ stdout: string }>,
  onPidError?: (pid: number, source: string, error: unknown) => Promise<void> | void,
  onPartialCoverage?: (missingPids: number[], source: string) => Promise<void> | void,
): Promise<Map<number, number>> {
  try {
    const { stdout } = await execFn("wmic process get ProcessId,WorkingSetSize /format:value");
    const snapshot = parseWmicWorkingSetSnapshot(stdout);
    const matched = new Map<number, number>();
    for (const pid of pids) {
      const rss = snapshot.get(pid);
      if (rss !== undefined) matched.set(pid, rss);
    }
    if (matched.size === pids.length) return matched;
    if (matched.size > 0) {
      const missingPids = pids.filter((pid) => !matched.has(pid));
      if (missingPids.length > 0) {
        await onPartialCoverage?.(missingPids, "wmic");
      }
      const merged = new Map(matched);
      for (const pid of missingPids) {
        try {
          const { stdout: pidStdout } = await execFn(
            `wmic process where "ProcessId=${pid}" get WorkingSetSize`,
          );
          const lines = pidStdout.trim().split("\n").slice(1);
          let parsedAny = false;
          for (const line of lines) {
            const rssBytes = parseStrictPositiveInteger(line.trim());
            if (rssBytes !== null) {
              merged.set(pid, rssBytes);
              parsedAny = true;
            }
          }
          if (!parsedAny) {
            await onPidError?.(pid, "wmic", new Error("per-pid rss parse failed"));
          }
        } catch (error) {
          await onPidError?.(pid, "wmic", error);
        }
      }
      return merged;
    }
    throw new Error("windows bulk snapshot parsed no usable RSS rows");
  } catch {
    const rssByPid = new Map<number, number>();
    for (const pid of pids) {
      try {
        const { stdout } = await execFn(`wmic process where "ProcessId=${pid}" get WorkingSetSize`);
        const lines = stdout.trim().split("\n").slice(1);
        let parsedAny = false;
        for (const line of lines) {
          const rssBytes = parseStrictPositiveInteger(line.trim());
          if (rssBytes !== null) {
            rssByPid.set(pid, rssBytes);
            parsedAny = true;
          }
        }
        if (!parsedAny) {
          await onPidError?.(pid, "wmic", new Error("per-pid rss parse failed"));
        }
      } catch (error) {
        await onPidError?.(pid, "wmic", error);
      }
    }
    if (rssByPid.size === 0) {
      throw new Error("windows rss sampling failed for all candidate PIDs");
    }
    return rssByPid;
  }
}

export async function sampleWindowsRssPerPid(
  pids: number[],
  execFn: (command: string) => Promise<{ stdout: string }>,
  onPidError?: (pid: number, source: string, error: unknown) => Promise<void> | void,
): Promise<Map<number, number>> {
  const rssByPid = new Map<number, number>();
  for (const pid of pids) {
    try {
      const { stdout } = await execFn(`wmic process where "ProcessId=${pid}" get WorkingSetSize`);
      const lines = stdout.trim().split("\n").slice(1);
      let parsedAny = false;
      for (const line of lines) {
        const rssBytes = parseStrictPositiveInteger(line.trim());
        if (rssBytes !== null) {
          rssByPid.set(pid, rssBytes);
          parsedAny = true;
        }
      }
      if (!parsedAny) {
        await onPidError?.(pid, "wmic", new Error("per-pid rss parse failed"));
      }
    } catch (error) {
      await onPidError?.(pid, "wmic", error);
    }
  }
  return rssByPid;
}

export async function getLightweightRam(): Promise<LightweightRamResult> {
  const pids = await getActiveSessions();
  if (pids.length === 0) return { current: 0, total: 0, count: 0 };

  const osPlatform = platform();
  let totalRss = 0;
  let currentRss = 0;
  const sampledPids = new Set<number>();

  if (osPlatform === "linux") {
    for (const pid of pids) {
      try {
        const status = await readFile(`/proc/${pid}/status`, "utf-8");
        const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (match) {
          const rss = parseInt(match[1], 10) * 1024;
          totalRss += rss;
          sampledPids.add(pid);
          if (pid === process.pid) currentRss = rss;
        }
      } catch (error) {
        await debugLog("rss-sample-failed", {
          platform: osPlatform,
          pid,
          source: "/proc",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else if (osPlatform === "darwin") {
    try {
      const onPidError = async (pid: number, source: string, error: unknown) => {
        await debugLog("rss-sample-failed", {
          platform: osPlatform,
          pid,
          source,
          error: error instanceof Error ? error.message : String(error),
        });
      };
      const rssByPid = shouldUseBulkSnapshot(pids.length)
        ? await sampleDarwinRssWithFallback(
            pids,
            async (command) => execAsync(command, EXEC_OPTS),
            onPidError,
            async (missingPids, source) => {
              await debugLog("rss-snapshot-partial", {
                platform: osPlatform,
                source,
                missingPidCount: missingPids.length,
                missingPids: missingPids.join(","),
                totalPids: pids.length,
              });
            },
          )
        : await sampleDarwinRssPerPid(
            pids,
            async (command) => execAsync(command, EXEC_OPTS),
            onPidError,
          );
      for (const pid of pids) {
        const rss = rssByPid.get(pid);
        if (rss === undefined) continue;
        totalRss += rss;
        sampledPids.add(pid);
        if (pid === process.pid) currentRss = rss;
      }
    } catch (error) {
      await debugLog("rss-snapshot-failed", {
        platform: osPlatform,
        source: "ps",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (osPlatform === "win32") {
    try {
      const onPidError = async (pid: number, source: string, error: unknown) => {
        await debugLog("rss-sample-failed", {
          platform: osPlatform,
          pid,
          source,
          error: error instanceof Error ? error.message : String(error),
        });
      };
      const rssByPid = shouldUseBulkSnapshot(pids.length)
        ? await sampleWindowsRssWithFallback(
            pids,
            async (command) => execAsync(command, EXEC_OPTS),
            onPidError,
            async (missingPids, source) => {
              await debugLog("rss-snapshot-partial", {
                platform: osPlatform,
                source,
                missingPidCount: missingPids.length,
                missingPids: missingPids.join(","),
                totalPids: pids.length,
              });
            },
          )
        : await sampleWindowsRssPerPid(
            pids,
            async (command) => execAsync(command, EXEC_OPTS),
            onPidError,
          );
      for (const pid of pids) {
        const rss = rssByPid.get(pid);
        if (rss === undefined) continue;
        totalRss += rss;
        sampledPids.add(pid);
        if (pid === process.pid) currentRss = rss;
      }
    } catch (error) {
      await debugLog("rss-snapshot-failed", {
        platform: osPlatform,
        source: "wmic",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    currentRss = process.memoryUsage().rss;
    totalRss = currentRss;
    sampledPids.add(process.pid);
  }

  if (currentRss === 0) {
    const fallbackCurrentRss = process.memoryUsage().rss;
    currentRss = fallbackCurrentRss;
    if (!sampledPids.has(process.pid)) {
      totalRss += fallbackCurrentRss;
      sampledPids.add(process.pid);
    }
    await debugLog("current-rss-fallback-used", {
      fallbackCurrentRss,
      sampledCount: sampledPids.size,
    });
  }

  return {
    current: currentRss,
    total: totalRss,
    count: sampledPids.size,
  };
}

export interface ProcessNode {
  pid: number;
  ppid: number;
  rss: number;
  command: string;
  children: ProcessNode[];
}

export function selectTargetRoots(processes: ProcessNode[], rootPids: Set<number>): ProcessNode[] {
  const procMap = new Map<number, ProcessNode>();
  for (const processNode of processes) {
    procMap.set(processNode.pid, processNode);
  }

  return processes.filter((processNode) => {
    if (!rootPids.has(processNode.pid)) return false;

    const visited = new Set<number>([processNode.pid]);
    let parentPid = processNode.ppid;

    while (parentPid !== processNode.pid && procMap.has(parentPid) && !visited.has(parentPid)) {
      if (rootPids.has(parentPid)) return false;
      visited.add(parentPid);
      parentPid = procMap.get(parentPid)?.ppid ?? parentPid;
    }

    return true;
  });
}

export async function getHeavyProcessTree(): Promise<string> {
  const pids = await getActiveSessions();
  const osPlatform = platform();

  let processes: ProcessNode[] = [];

  if (osPlatform === "linux" || osPlatform === "darwin") {
    try {
      const { stdout } = await execAsync("ps -A -o pid= -o ppid= -o rss= -o comm=", EXEC_OPTS);
      const lines = stdout.trim().split("\n");
      processes = lines
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          const rss = parseInt(parts[2], 10) * 1024;
          const command = parts.slice(3).join(" ");
          return { pid, ppid, rss, command, children: [] };
        })
        .filter((p) => !Number.isNaN(p.pid));
    } catch (error) {
      await debugLog("heavy-tree-process-snapshot-failed", {
        platform: osPlatform,
        source: "ps",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (osPlatform === "win32") {
    try {
      const { stdout } = await execAsync(
        `wmic process get Name,ParentProcessId,ProcessId,WorkingSetSize /format:value`,
        EXEC_OPTS,
      );
      const normalized = stdout.replace(/\r\n/g, "\n").trim();
      const blocks = normalized.split(/\n\n/);

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        const entry: Record<string, string> = {};
        for (const line of lines) {
          const eq = line.indexOf("=");
          if (eq === -1) continue;
          const key = line.slice(0, eq).trim();
          const value = line.slice(eq + 1).trim();
          entry[key] = value;
        }
        const pid = parseInt(entry.ProcessId, 10);
        const ppid = parseInt(entry.ParentProcessId, 10);
        const rss = parseInt(entry.WorkingSetSize, 10);
        const command = entry.Name || "";
        if (!Number.isNaN(pid)) {
          processes.push({ pid, ppid, rss, command, children: [] });
        }
      }
    } catch (error) {
      await debugLog("heavy-tree-process-snapshot-failed", {
        platform: osPlatform,
        source: "wmic",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const procMap = new Map<number, ProcessNode>();
  for (const processNode of processes) {
    procMap.set(processNode.pid, processNode);
  }

  for (const processNode of processes) {
    if (processNode.ppid !== processNode.pid && procMap.has(processNode.ppid)) {
      procMap.get(processNode.ppid)?.children.push(processNode);
    }
  }

  const rootPids = new Set(pids);
  const targetRoots = selectTargetRoots(processes, rootPids);

  if (targetRoots.length === 0) {
    await debugLog("heavy-tree-no-target-roots", {
      discoveredProcesses: processes.length,
      requestedRoots: pids.length,
      currentPid: process.pid,
    });
    return `### OpenCode RAM Usage Tree\n\nNo detailed process tree could be generated. Current process PID is ${process.pid}.`;
  }

  let markdown = "### OpenCode RAM Usage Tree\n\n";
  const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

  const buildTreeString = (
    node: ProcessNode,
    prefix: string,
    isLast: boolean,
    visited: Set<number>,
  ): string => {
    if (visited.has(node.pid)) {
      return `${prefix}${isLast ? "└──" : "├──"} [${node.command}] (PID ${node.pid}) - cycle detected\n`;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(node.pid);
    let result = `${prefix}${isLast ? "└──" : "├──"} [${node.command}] (PID ${node.pid}) - ${formatSize(node.rss)}\n`;

    const childPrefix = prefix + (isLast ? "    " : "│   ");
    for (let i = 0; i < node.children.length; i++) {
      result += buildTreeString(
        node.children[i],
        childPrefix,
        i === node.children.length - 1,
        nextVisited,
      );
    }
    return result;
  };

  const getTreeSum = (node: ProcessNode, visited: Set<number>): number => {
    if (visited.has(node.pid)) return 0;
    const nextVisited = new Set(visited);
    nextVisited.add(node.pid);
    return node.rss + node.children.reduce((acc, child) => acc + getTreeSum(child, nextVisited), 0);
  };

  for (const root of targetRoots) {
    const totalMem = getTreeSum(root, new Set<number>());
    markdown += `**Session (PID ${root.pid}) - Total: ${formatSize(totalMem)}**\n`;
    markdown += "```text\n";
    markdown += buildTreeString(root, "", true, new Set<number>());
    markdown += "```\n\n";
  }

  return markdown.trim();
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 MB";
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}
