import { exec } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const EXEC_OPTS = { timeout: 5000, windowsHide: true };
const execAsync = promisify(exec);

export async function getActiveSessions(): Promise<number[]> {
  const pids: number[] = [process.pid]; // Always include current process
  const stateDirs = [
    join(homedir(), ".opencode", "state"),
    join(homedir(), ".cache", "opencode", "state"), // Fallback
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
            // fallback: maybe the filename has PID or the lockfile is just the PID
            const pid = parseInt(content.trim(), 10);
            if (!Number.isNaN(pid)) {
              pids.push(pid);
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable, ignore
    }
  }

  // Deduplicate PIDs
  return [...new Set(pids)];
}

export async function getLightweightRam(): Promise<number> {
  const pids = await getActiveSessions();
  if (pids.length === 0) return 0;

  const osPlatform = platform();
  let totalRss = 0;

  if (osPlatform === "linux") {
    // Fast path for Linux/WSL - read VmRSS from /proc/<pid>/status (kB)
    for (const pid of pids) {
      try {
        const status = await readFile(`/proc/${pid}/status`, "utf-8");
        const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (match) {
          totalRss += parseInt(match[1], 10) * 1024;
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
        if (!Number.isNaN(rssKb)) totalRss += rssKb * 1024;
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
        );
        const lines = stdout.trim().split("\n").slice(1); // skip header
        for (const line of lines) {
          const rssBytes = parseInt(line.trim(), 10);
          if (!Number.isNaN(rssBytes)) totalRss += rssBytes;
        }
      } catch {
        // Process might have exited
      }
    }
  } else {
    // Fallback: just current process
    totalRss = process.memoryUsage().rss;
  }

  return totalRss;
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
    if (procMap.has(p.ppid)) {
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

  const buildTreeString = (node: ProcessNode, prefix: string, isLast: boolean): string => {
    let result = `${prefix}${isLast ? "└──" : "├──"} [${node.command}] (PID ${node.pid}) - ${formatSize(node.rss)}\n`;

    const childPrefix = prefix + (isLast ? "    " : "│   ");
    for (let i = 0; i < node.children.length; i++) {
      result += buildTreeString(node.children[i], childPrefix, i === node.children.length - 1);
    }
    return result;
  };

  const getTreeSum = (node: ProcessNode): number => {
    return node.rss + node.children.reduce((acc, child) => acc + getTreeSum(child), 0);
  };

  for (const root of targetRoots) {
    const totalMem = getTreeSum(root);
    markdown += `**Session (PID ${root.pid}) - Total: ${formatSize(totalMem)}**\n`;
    markdown += `\`\`\`text\n`;
    markdown += buildTreeString(root, "", true);
    markdown += `\`\`\`\n\n`;
  }

  return markdown.trim();
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 MB";
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}
