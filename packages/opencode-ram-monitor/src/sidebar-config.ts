import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_REFRESH_INTERVAL_MS = 5000;
const MIN_REFRESH_INTERVAL_MS = 1000;
const MAX_REFRESH_INTERVAL_MS = 60_000;

const GLOBAL_CONFIG_FILES = ["opencode.json", "opencode.jsonc", "cli.json", "cli.jsonc"] as const;

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getGlobalConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR;
  if (isNonBlank(override)) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (isNonBlank(xdg)) return join(xdg, "opencode");
  return join(homedir(), ".config", "opencode");
}
const CONFIG_PATH_SEGMENTS = [
  ["opencode.json"],
  ["opencode.jsonc"],
  [".opencode", "opencode.json"],
  [".opencode", "opencode.jsonc"],
  ["tui.json"],
  ["tui.jsonc"],
  [".opencode", "tui.json"],
  [".opencode", "tui.jsonc"],
  ["cli.json"],
  ["cli.jsonc"],
  [".opencode", "cli.json"],
  [".opencode", "cli.jsonc"],
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
  const parsed = Number(value);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function getConfigValue(config: unknown): unknown {
  const experimental = asRecord(config)?.experimental;
  const ramMonitor = asRecord(experimental)?.ramMonitor;
  return asRecord(ramMonitor)?.refreshIntervalMs;
}

function parsePluginOptionIntervalMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? normalizeRefreshIntervalMs(value) : null;
  }
  if (!isNonBlank(value)) return null;

  // String overrides are parsed with Number(), so hex ("0x10"), scientific
  // ("5e3"), and whitespace-padded (" 3000 ") numerics are accepted by design;
  // normalization then floors and clamps them like any other value.
  const parsed = Number(value);
  return Number.isFinite(parsed) ? normalizeRefreshIntervalMs(parsed) : null;
}

function isMissingConfigError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function getRamMonitorConfigPaths(worktree: string): string[] {
  const globalDir = getGlobalConfigDir();
  return [
    ...GLOBAL_CONFIG_FILES.map((file) => join(globalDir, file)),
    ...CONFIG_PATH_SEGMENTS.map((segments) => join(worktree, ...segments)),
  ];
}

export async function loadRamMonitorWidgetConfig(
  worktree: string,
  overrides?: { readonly refreshIntervalMs?: unknown },
): Promise<RamMonitorWidgetConfig> {
  const overrideIntervalMs = parsePluginOptionIntervalMs(overrides?.refreshIntervalMs);
  if (overrideIntervalMs !== null) {
    return {
      intervalMs: overrideIntervalMs,
      sourcePath: "plugin options",
      warning: null,
      warningPath: null,
    };
  }

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
