import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config-parse.js";
import { type AdvisorConfig, ConfigError, defaultConfig } from "./config-types.js";

export const CONFIG_FILE_NAME = "auto-advisor.json";
export const CONFIG_DIR_NAME = "opencode";

export interface LoadConfigOptions {
  readonly path?: string;
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
}

export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
  home: string | undefined = homedir(),
): string {
  const directory = env.OPENCODE_CONFIG_DIR?.trim();
  if (directory) return join(directory, CONFIG_FILE_NAME);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const root = xdg || (home ? join(home, ".config") : undefined);
  if (!root) {
    throw new ConfigError(
      CONFIG_FILE_NAME,
      undefined,
      "cannot be resolved without XDG_CONFIG_HOME or a home directory",
    );
  }
  return join(root, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AdvisorConfig> {
  const path = options.path ?? resolveConfigPath(options.env, options.home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return defaultConfig();
    throw new ConfigError(path, undefined, `could not be read: ${describe(cause)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(path, undefined, `is not valid JSON: ${describe(cause)}`);
  }
  return parseConfig(raw, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type { AdvisorConfig, RoutingConfig, RoutingMode } from "./config-types.js";
export { ConfigError, defaultConfig, ROUTING_MODES } from "./config-types.js";
