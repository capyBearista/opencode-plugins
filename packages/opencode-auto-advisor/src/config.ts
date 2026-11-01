import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type RoutingMode = "off" | "observe" | "active";

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  /** A catalog variant such as `high`; undefined uses the model's default. */
  readonly variant?: string;
}

export interface Config {
  readonly advisor: {
    /** Tried in order until one answers; `inherit` is the Executor's model and variant. */
    readonly models: readonly (ModelRef | "inherit")[];
    /** One deadline for the whole chain; -1 leaves hang detection to the host's HTTP timeouts. */
    readonly timeoutMs: number;
    /** Replace the host's tool, MCP and skill catalogs in the Advisor's copy of the context. */
    readonly compactContext: boolean;
    /** Ceiling on the Advisor's transcript; the model's window can lower it further. */
    readonly maxTokens: number;
  };
  readonly routing: {
    readonly mode: RoutingMode;
    readonly models: readonly ModelRef[];
    readonly momentThreshold: number;
    readonly consequenceThreshold: number;
    readonly maxConsultationsPerTurn: number;
    /** Distinct Executor steps after an automatic consult starts before another may; 0 is off. */
    readonly minStepsBetweenConsultations: number;
    /** How many of the user's latest requests the Decision model sees. */
    readonly requests: number;
    /** Characters per request in the Decision input, keeping the start; -1 is no cap. */
    readonly requestMaxChars: number;
  };
  readonly tui: {
    /** Show the Advisor widget at the bottom of the session sidebar. */
    readonly sidebar: boolean;
  };
}

export const CONFIG_FILE = "auto-advisor.json";
const MAX_MODELS = 8;

export const DEFAULTS: Config = {
  advisor: { models: ["inherit"], timeoutMs: -1, compactContext: true, maxTokens: 64_000 },
  routing: {
    mode: "active",
    models: [{ providerID: "opencode", id: "jev-1.13-free" }],
    momentThreshold: 0.7,
    consequenceThreshold: 1.5,
    maxConsultationsPerTurn: 2,
    minStepsBetweenConsultations: 10,
    requests: 3,
    requestMaxChars: 20_000,
  },
  tui: { sidebar: true },
};

export class ConfigError extends Error {}

/**
 * `provider/model[#variant]`, OpenCode's own model-ref syntax. Model IDs may contain slashes
 * (`openrouter/typesafe/jev-1.13`), so only the first one splits.
 */
export function parseModelRef(value: string): ModelRef | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  const hash = value.indexOf("#", slash + 1);
  const id = value.slice(slash + 1, hash === -1 ? undefined : hash);
  const variant = hash === -1 ? undefined : value.slice(hash + 1);
  const providerID = value.slice(0, slash);
  if (!id || providerID.includes("#") || variant === "" || variant?.includes("#")) return undefined;
  return { providerID, id, ...(variant ? { variant } : {}) };
}

export const modelKey = (ref: ModelRef) =>
  `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;

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

/** 1..MAX_MODELS distinct entries, each a model ref or, where allowed, "inherit". */
function modelList(list: unknown, inherit: boolean): (ModelRef | "inherit")[] | undefined {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MODELS) return undefined;
  if (new Set(list).size !== list.length) return undefined;
  const refs = list.map((item) =>
    inherit && item === "inherit"
      ? "inherit"
      : typeof item === "string"
        ? parseModelRef(item)
        : undefined,
  );
  return refs.every(Boolean) ? (refs as (ModelRef | "inherit")[]) : undefined;
}

/** -1 (no limit) or an integer in `min..max`. */
function noCapOr(value: unknown, name: string, min: number, max: number) {
  if (value === -1) return -1;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  throw new ConfigError(`${name} must be -1 (no limit) or an integer in ${min}..${max}`);
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new ConfigError(`${name} must be true or false`);
  return value;
}

/** Strict and sparse: omitted keys take defaults, invalid explicit values are errors. */
export function parseConfig(input: unknown): Config {
  if (!isRecord(input)) throw new ConfigError("config must be a JSON object");
  for (const key of Object.keys(input)) {
    if (key !== "advisor" && key !== "routing" && key !== "tui" && key !== "$schema") {
      throw new ConfigError(`unknown key: ${key}`);
    }
  }
  const advisor = section(input, "advisor", ["model", "timeoutMs", "compactContext", "maxTokens"]);
  const routing = section(input, "routing", [
    "mode",
    "models",
    "momentThreshold",
    "consequenceThreshold",
    "maxConsultationsPerTurn",
    "minStepsBetweenConsultations",
    "requests",
    "requestMaxChars",
  ]);
  const tui = section(input, "tui", ["sidebar"]);

  let advisorModels = DEFAULTS.advisor.models;
  if (advisor.model !== undefined) {
    const list = modelList(
      typeof advisor.model === "string" ? [advisor.model] : advisor.model,
      true,
    );
    if (!list) {
      throw new ConfigError(
        `advisor.model must be "inherit", "provider/model[#variant]" or a list of 1..${MAX_MODELS} distinct such entries`,
      );
    }
    advisorModels = list;
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
    const list = modelList(routing.models, false);
    if (!list) {
      throw new ConfigError(
        `routing.models must list 1..${MAX_MODELS} distinct "provider/model[#variant]" decision models`,
      );
    }
    models = list as ModelRef[];
  }

  return {
    advisor: {
      models: advisorModels,
      timeoutMs:
        advisor.timeoutMs === undefined
          ? DEFAULTS.advisor.timeoutMs
          : noCapOr(advisor.timeoutMs, "advisor.timeoutMs", 1, 3_600_000),
      compactContext:
        advisor.compactContext === undefined
          ? DEFAULTS.advisor.compactContext
          : boolean(advisor.compactContext, "advisor.compactContext"),
      maxTokens:
        advisor.maxTokens === undefined
          ? DEFAULTS.advisor.maxTokens
          : number(advisor.maxTokens, "advisor.maxTokens", 1_000, 10_000_000, true),
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
      minStepsBetweenConsultations:
        routing.minStepsBetweenConsultations === undefined
          ? DEFAULTS.routing.minStepsBetweenConsultations
          : number(
              routing.minStepsBetweenConsultations,
              "routing.minStepsBetweenConsultations",
              0,
              1_000,
              true,
            ),
      requests:
        routing.requests === undefined
          ? DEFAULTS.routing.requests
          : number(routing.requests, "routing.requests", 1, 20, true),
      requestMaxChars:
        routing.requestMaxChars === undefined
          ? DEFAULTS.routing.requestMaxChars
          : noCapOr(routing.requestMaxChars, "routing.requestMaxChars", 100, 10_000_000),
    },
    tui: {
      sidebar:
        tui.sidebar === undefined ? DEFAULTS.tui.sidebar : boolean(tui.sidebar, "tui.sidebar"),
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
    // One handle for both the mtime check and the read, so they always see the same file.
    let file: FileHandle;
    try {
      file = await open(path, "r");
    } catch {
      return { config: DEFAULTS };
    }
    let mtime: number;
    let loaded: LoadedConfig;
    try {
      mtime = (await file.stat()).mtimeMs;
      if (cached?.mtime === mtime) return cached.loaded;
      try {
        loaded = { config: parseConfig(JSON.parse(await file.readFile("utf8"))) };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        loaded = {
          config: { ...DEFAULTS, routing: { ...DEFAULTS.routing, mode: "off" } },
          error: `${path}: ${message}`,
        };
      }
    } finally {
      await file.close();
    }
    cached = { mtime, loaded };
    return loaded;
  };
}
