import { Model } from "@opencode/plugin";
import {
  type AdvisorConfig,
  ConfigError,
  ROUTING_MODES,
  type RoutingConfig,
  type RoutingMode,
} from "./config-types.js";

export function parseConfig(raw: unknown, path: string): AdvisorConfig {
  const root = asObject(raw, path, "root");
  only(root, ["advisor", "routing"], path, "");
  return {
    advisor: parseAdvisor(root.advisor, path),
    routing: parseRouting(root.routing, path),
  };
}

function parseAdvisor(value: unknown, path: string): AdvisorConfig["advisor"] {
  const advisor = asObject(value, path, "advisor");
  only(advisor, ["model"], path, "advisor");
  const model = advisor.model;
  if (model === undefined || model === "inherit") return {};
  if (typeof model !== "string")
    fail(path, "advisor.model", 'must be "inherit" or "providerID/modelID"');
  try {
    return { model: Model.Ref.parse(model) };
  } catch {
    fail(path, "advisor.model", `is not a valid model reference: ${model}`);
  }
}

function parseRouting(value: unknown, path: string): RoutingConfig {
  const routing = asObject(value, path, "routing");
  only(
    routing,
    [
      "mode",
      "models",
      "advisorWouldHelpThreshold",
      "consequenceThreshold",
      "maxConsultationsPerTurn",
    ],
    path,
    "routing",
  );
  return {
    mode: parseMode(routing.mode, path),
    models: parseModels(routing.models, path),
    advisorWouldHelpThreshold: parseThreshold(
      routing.advisorWouldHelpThreshold,
      path,
      "routing.advisorWouldHelpThreshold",
      0,
      1,
      0.7,
    ),
    consequenceThreshold: parseThreshold(
      routing.consequenceThreshold,
      path,
      "routing.consequenceThreshold",
      0,
      4,
      3,
    ),
    maxConsultationsPerTurn: parseBudget(routing.maxConsultationsPerTurn, path),
  };
}

function parseMode(value: unknown, path: string): RoutingMode {
  if (value === undefined) return "off";
  if (typeof value === "string" && (ROUTING_MODES as readonly string[]).includes(value))
    return value as RoutingMode;
  fail(path, "routing.mode", `must be one of ${ROUTING_MODES.join(", ")}`);
}

function parseModels(value: unknown, path: string): readonly string[] {
  if (value === undefined) return ["jev-1.13-free", "jev-1.13"];
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, "routing.models", "must be a non-empty array of model ids");
  }
  return value.map((model, index) => {
    if (typeof model !== "string" || model.trim() === "") {
      fail(path, `routing.models[${index}]`, "must be a non-empty string");
    }
    return model;
  });
}

function parseThreshold(
  value: unknown,
  path: string,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(path, key, `must be a number between ${min} and ${max}`);
  }
  return value;
}

function parseBudget(value: unknown, path: string): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(path, "routing.maxConsultationsPerTurn", "must be a positive integer");
  }
  return value;
}

function only(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  prefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key))
      fail(path, prefix === "" ? key : `${prefix}.${key}`, "is not a supported setting");
  }
}

function asObject(value: unknown, path: string, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(path, key, "must be a JSON object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, key: string, detail: string): never {
  throw new ConfigError(path, key, detail);
}
