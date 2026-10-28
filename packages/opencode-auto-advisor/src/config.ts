import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type RoutingMode = "off" | "observe" | "active";

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
}

export interface Config {
  readonly advisor: {
    /** Undefined means "use the Executor's model". */
    readonly model: ModelRef | undefined;
    readonly timeoutMs: number;
  };
  readonly routing: {
    readonly mode: RoutingMode;
    readonly models: readonly ModelRef[];
    readonly momentThreshold: number;
    readonly consequenceThreshold: number;
    readonly maxConsultationsPerTurn: number;
  };
}

export const CONFIG_FILE = "auto-advisor.json";
const MAX_MODELS = 8;

export const DEFAULTS: Config = {
  advisor: { model: undefined, timeoutMs: 300_000 },
  routing: {
    mode: "off",
    models: [{ providerID: "opencode", id: "jev-1.13-free" }],
    momentThreshold: 0.7,
    consequenceThreshold: 1.5,
    maxConsultationsPerTurn: 2,
  },
};

export class ConfigError extends Error {}

/** Model IDs may contain slashes (`openrouter/typesafe/jev-1.13`), so only the first one splits. */
export function parseModelRef(value: string): ModelRef | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function section(input: Record<string, unknown>, key: string, allowed: readonly string[]) {
  const value = input[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`${key} must be an object`);
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) throw new ConfigError(`unknown key: ${key}.${name}`);
  }
  return value;
}

function number(value: unknown, name: string, min: number, max: number, integer = false) {
  const ok =
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value));
  if (!ok) {
    throw new ConfigError(
      `${name} must be ${integer ? "an integer" : "a number"} in ${min}..${max}`,
    );
  }
  return value as number;
}

/** Strict and sparse: omitted keys take defaults, invalid explicit values are errors. */
export function parseConfig(input: unknown): Config {
  if (!isRecord(input)) throw new ConfigError("config must be a JSON object");
  for (const key of Object.keys(input)) {
    if (key !== "advisor" && key !== "routing" && key !== "$schema") {
      throw new ConfigError(`unknown key: ${key}`);
    }
  }
  const advisor = section(input, "advisor", ["model", "timeoutMs"]);
  const routing = section(input, "routing", [
    "mode",
    "models",
    "momentThreshold",
    "consequenceThreshold",
    "maxConsultationsPerTurn",
  ]);

  let model = DEFAULTS.advisor.model;
  if (advisor.model !== undefined && advisor.model !== "inherit") {
    model = typeof advisor.model === "string" ? parseModelRef(advisor.model) : undefined;
    if (!model) throw new ConfigError('advisor.model must be "inherit" or "provider/model"');
  }

  let mode = DEFAULTS.routing.mode;
  if (routing.mode !== undefined) {
    if (routing.mode !== "off" && routing.mode !== "observe" && routing.mode !== "active") {
      throw new ConfigError('routing.mode must be "off", "observe" or "active"');
    }
    mode = routing.mode;
  }

  let models = DEFAULTS.routing.models;
  if (routing.models !== undefined) {
    const list = routing.models;
    const refs = Array.isArray(list)
      ? list.map((item) => (typeof item === "string" ? parseModelRef(item) : undefined))
      : [];
    const valid =
      refs.length > 0 &&
      refs.length <= MAX_MODELS &&
      refs.every(Boolean) &&
      new Set(list as string[]).size === refs.length;
    if (!valid) {
      throw new ConfigError(
        `routing.models must list 1..${MAX_MODELS} distinct "provider/model" decision models`,
      );
    }
    models = refs as ModelRef[];
  }

  return {
    advisor: {
      model,
      timeoutMs:
        advisor.timeoutMs === undefined
          ? DEFAULTS.advisor.timeoutMs
          : number(advisor.timeoutMs, "advisor.timeoutMs", 1, 3_600_000, true),
    },
    routing: {
      mode,
      models,
      momentThreshold:
        routing.momentThreshold === undefined
          ? DEFAULTS.routing.momentThreshold
          : number(routing.momentThreshold, "routing.momentThreshold", 0, 1),
      consequenceThreshold:
        routing.consequenceThreshold === undefined
          ? DEFAULTS.routing.consequenceThreshold
          : number(routing.consequenceThreshold, "routing.consequenceThreshold", 0, 4),
      maxConsultationsPerTurn:
        routing.maxConsultationsPerTurn === undefined
          ? DEFAULTS.routing.maxConsultationsPerTurn
          : number(
              routing.maxConsultationsPerTurn,
              "routing.maxConsultationsPerTurn",
              1,
              100,
              true,
            ),
    },
  };
}

export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const dir = env.OPENCODE_CONFIG_DIR?.trim();
  if (dir) return join(dir, CONFIG_FILE);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "opencode", CONFIG_FILE);
}

export interface LoadedConfig {
  readonly config: Config;
  /** Set when the file exists but is invalid; the plugin then behaves as mode `off`. */
  readonly error?: string;
}

/** Re-reads the file only when its mtime changes, so it can be called on every prompt. */
export function createConfigLoader(path: string = resolveConfigPath()) {
  let cached: { mtime: number; loaded: LoadedConfig } | undefined;
  return async (): Promise<LoadedConfig> => {
    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      return { config: DEFAULTS };
    }
    if (cached?.mtime === mtime) return cached.loaded;
    let loaded: LoadedConfig;
    try {
      loaded = { config: parseConfig(JSON.parse(await readFile(path, "utf8"))) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      loaded = {
        config: { ...DEFAULTS, routing: { ...DEFAULTS.routing, mode: "off" } },
        error: `${path}: ${message}`,
      };
    }
    cached = { mtime, loaded };
    return loaded;
  };
}
