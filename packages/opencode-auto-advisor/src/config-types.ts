import type { Model } from "@opencode/plugin";

export const ROUTING_MODES = ["off", "observe", "active"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export interface RoutingConfig {
  readonly mode: RoutingMode;
  readonly models: readonly string[];
  readonly advisorWouldHelpThreshold: number;
  readonly consequenceThreshold: number;
  readonly maxConsultationsPerTurn: number;
}

export interface AdvisorConfig {
  readonly advisor: { readonly model?: Model.Ref };
  readonly routing: RoutingConfig;
}

export function defaultConfig(): AdvisorConfig {
  return {
    advisor: {},
    routing: {
      mode: "off",
      models: ["jev-1.13-free", "jev-1.13"],
      advisorWouldHelpThreshold: 0.7,
      consequenceThreshold: 3,
      maxConsultationsPerTurn: 1,
    },
  };
}

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly key: string | undefined,
    detail: string,
  ) {
    super(
      key === undefined
        ? `Invalid auto-advisor configuration at ${path}: ${detail}`
        : `Invalid auto-advisor configuration at ${path}: ${key} ${detail}`,
    );
    this.name = "ConfigError";
  }
}
