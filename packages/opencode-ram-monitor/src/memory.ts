import { exec } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const EXEC_OPTS = { timeout: 5000, windowsHide: true };
const execAsync = promisify(exec);

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

async function getRuntimeSessionPids(): Promise<number[]> {
  const osPlatform = platform();

  if (osPlatform === "linux" || osPlatform === "darwin") {
    try {
      const { stdout } = await execAsync("ps -eo pid=,args=", EXEC_OPTS);
      const corePids: number[] = [];
      const launcherPids: number[] = [];

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const firstSpace = trimmed.indexOf(" ");
        if (firstSpace === -1) continue;

        const pid = parseInt(trimmed.slice(0, firstSpace), 10);
        if (Number.isNaN(pid)) continue;

        const args = trimmed.slice(firstSpace + 1);
        const processKind = classifyOpencodeProcess(args);
        if (processKind === "core") corePids.push(pid);
        if (processKind === "launcher") launcherPids.push(pid);
      }

      return corePids.length > 0 ? corePids : launcherPids;
    } catch {
      return [];
    }
  }

  if (osPlatform === "win32") {
    try {
      const { stdout } = await execAsync(
        "wmic process get CommandLine,ProcessId /format:value",
        EXEC_OPTS,
      );
      const corePids: number[] = [];
      const launcherPids: number[] = [];

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
        if (processKind === "core") corePids.push(pid);
        if (processKind === "launcher") launcherPids.push(pid);
      }

      return corePids.length > 0 ? corePids : launcherPids;
    } catch {
      return [];
    }
  }

  return [];
}

export async function getActiveSessions(): Promise<number[]> {
  const pids: number[] = [process.pid];
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
        if (file.endsWith(".lock")) {
          const content = await readFile(join(dir, file), "utf-8");
          try {
            const data = JSON.parse(content);
            if (data.pid && typeof data.pid === "number") {
              pids.push(data.pid);
            }
          } catch {
            const pid = parseInt(content.trim(), 10);
            if (!Number.isNaN(pid)) {
              pids.push(pid);
            }
          }
        }
      }
    } catch {}
  }

  const runtimePids = await getRuntimeSessionPids();
  pids.push(...runtimePids);

  return [...new Set(pids)];
}

export interface LightweightRamResult {
  current: number;
  total: number;
  count: number;
}

export async function getLightweightRam(): Promise<LightweightRamResult> {
  const pids = await getActiveSessions();
  if (pids.length === 0) return { current: 0, total: 0, count: 0 };

  const osPlatform = platform();
  let totalRss = 0;
  let currentRss = 0;
  const sampledPids = new Set<number>();

  if (osPlatform === "linux") {
    // Fast path for Linux/WSL - read VmRSS from /proc/<pid>/status (kB)
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
      } catch {
        // Process might have exited or permission denied
      }
    }
  } else if (osPlatform === "darwin") {
    // macOS: query each PID individually to avoid total failure if one PID is stale
    for (const pid of pids) {
      try {
        const { stdout } = await execAsync(`ps -o rss= -p ${pid}`, EXEC_OPTS);
        const rssKb = parseInt(stdout.trim(), 10);
        if (!Number.isNaN(rssKb)) {
          const rss = rssKb * 1024;
          totalRss += rss;
          sampledPids.add(pid);
          if (pid === process.pid) currentRss = rss;
        }
      } catch {
        // Process might have exited
      }
    }
  } else if (osPlatform === "win32") {
    // Windows: query each PID individually for reliability
    for (const pid of pids) {
      try {
        const { stdout } = await execAsync(
          `wmic process where "ProcessId=${pid}" get WorkingSetSize`,
          EXEC_OPTS,
        );
        const lines = stdout.trim().split("\n").slice(1); // skip header
        for (const line of lines) {
          const rssBytes = parseInt(line.trim(), 10);
          if (!Number.isNaN(rssBytes)) {
            totalRss += rssBytes;
            sampledPids.add(pid);
            if (pid === process.pid) currentRss = rssBytes;
          }
        }
      } catch {
        // Process might have exited
      }
    }
  } else {
    // Fallback: just current process
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
  rss: number; // bytes
  command: string;
  children: ProcessNode[];
}

export async function getHeavyProcessTree(): Promise<string> {
  const pids = await getActiveSessions();
  const osPlatform = platform();

  let processes: ProcessNode[] = [];

  if (osPlatform === "linux" || osPlatform === "darwin") {
    try {
      // Get all processes to build tree
      const { stdout } = await execAsync(`ps -e -o pid=,ppid=,rss=,comm=`, EXEC_OPTS);
      const lines = stdout.trim().split("\n");
      processes = lines
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          const rss = parseInt(parts[2], 10) * 1024; // KB to Bytes
          const command = parts.slice(3).join(" ");
          return { pid, ppid, rss, command, children: [] };
        })
        .filter((p) => !Number.isNaN(p.pid));
    } catch {
      // Error running ps
    }
  } else if (osPlatform === "win32") {
    try {
      // Use VALUE format (Key=Value pairs) to avoid CSV comma issues
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
          if (eq !== -1) {
            const key = line.slice(0, eq).trim();
            const value = line.slice(eq + 1).trim();
            entry[key] = value;
          }
        }
        const pid = parseInt(entry.ProcessId, 10);
        const ppid = parseInt(entry.ParentProcessId, 10);
        const rss = parseInt(entry.WorkingSetSize, 10);
        const command = entry.Name || "";
        if (!Number.isNaN(pid)) {
          processes.push({ pid, ppid, rss, command, children: [] });
        }
      }
    } catch {
      // Error
    }
  }

  // Build tree
  const procMap = new Map<number, ProcessNode>();
  for (const p of processes) {
    procMap.set(p.pid, p);
  }

  for (const p of processes) {
    if (p.ppid !== p.pid && procMap.has(p.ppid)) {
      procMap.get(p.ppid)?.children.push(p);
    }
  }

  const rootPids = new Set(pids);
  const targetRoots = processes.filter((p) => rootPids.has(p.pid));

  if (targetRoots.length === 0) {
    // Fallback if ps parsing failed or OS is unsupported
    return `### OpenCode RAM Usage Tree\n\nNo detailed process tree could be generated. Current process PID is ${process.pid}.`;
  }

  let markdown = "### OpenCode RAM Usage Tree\n\n";

  const formatSize = (bytes: number) => {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

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
    markdown += `\`\`\`text\n`;
    markdown += buildTreeString(root, "", true, new Set<number>());
    markdown += `\`\`\`\n\n`;
  }

  return markdown.trim();
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 MB";
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}
