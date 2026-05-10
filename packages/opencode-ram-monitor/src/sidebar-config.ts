import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_REFRESH_INTERVAL_MS = 5000;
const MIN_REFRESH_INTERVAL_MS = 1000;
const MAX_REFRESH_INTERVAL_MS = 60_000;

const CONFIG_PATH_SEGMENTS = [
  ["opencode.json"],
  ["opencode.jsonc"],
  [".opencode", "opencode.json"],
  [".opencode", "opencode.jsonc"],
  ["tui.json"],
  ["tui.jsonc"],
  [".opencode", "tui.json"],
  [".opencode", "tui.jsonc"],
] as const;

export interface RamMonitorWidgetConfig {
  intervalMs: number;
  sourcePath: string | null;
  warning: string | null;
  warningPath: string | null;
}

export function getDefaultRefreshIntervalMs(): number {
  return DEFAULT_REFRESH_INTERVAL_MS;
}

export function normalizeRefreshIntervalMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_INTERVAL_MS;
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(parsed)));
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "RAM error";
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
        continue;
      }
      output += " ";
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        output += "  ";
        index++;
        continue;
      }
      output += char === "\n" || char === "\r" ? char : " ";
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      output += "  ";
      index++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      output += "  ";
      index++;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let nextIndex = index + 1;
      while (nextIndex < input.length && /\s/.test(input[nextIndex])) {
        nextIndex++;
      }
      if (input[nextIndex] === "}" || input[nextIndex] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function getConfigValue(config: unknown): unknown {
  if (!config || typeof config !== "object") return undefined;
  const experimental = (config as Record<string, unknown>).experimental;
  if (!experimental || typeof experimental !== "object") return undefined;
  const ramMonitor = (experimental as Record<string, unknown>).ramMonitor;
  if (!ramMonitor || typeof ramMonitor !== "object") return undefined;
  return (ramMonitor as Record<string, unknown>).refreshIntervalMs;
}

function isMissingConfigError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function getRamMonitorConfigPaths(worktree: string): string[] {
  return CONFIG_PATH_SEGMENTS.map((segments) => join(worktree, ...segments));
}

export async function loadRamMonitorWidgetConfig(
  worktree: string,
): Promise<RamMonitorWidgetConfig> {
  let intervalMs = getDefaultRefreshIntervalMs();
  let sourcePath: string | null = null;
  let warning: string | null = null;
  let warningPath: string | null = null;

  for (const configPath of getRamMonitorConfigPaths(worktree)) {
    try {
      const parsed = JSON.parse(
        stripTrailingCommas(stripJsonComments(await readFile(configPath, "utf8"))),
      );
      const refreshIntervalMs = getConfigValue(parsed);
      if (refreshIntervalMs === undefined) continue;
      intervalMs = normalizeRefreshIntervalMs(refreshIntervalMs);
      sourcePath = configPath;
      warning = null;
      warningPath = null;
    } catch (error) {
      if (isMissingConfigError(error)) continue;
      warning = `Failed to load ${configPath}: ${getErrorMessage(error)}`;
      warningPath = configPath;
    }
  }

  return { intervalMs, sourcePath, warning, warningPath };
}
