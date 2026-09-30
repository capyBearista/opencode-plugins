import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { RoutingMode } from "./config.js";
import type { RoutingAction, RoutingPolicySnapshot } from "./routing-types.js";

export const TELEMETRY_CAP = 5000;
export const TELEMETRY_PAGE_LIMIT = 100;

type StorageValue = Awaited<ReturnType<PluginContext["storage"]["get"]>>;

export type TelemetryJson = Exclude<StorageValue, null | undefined>;

export interface TelemetryStorage {
  readonly get: (key: string) => Promise<StorageValue>;
  readonly set: (key: string, value: TelemetryJson) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  readonly scan: (options: {
    readonly prefix: string;
    readonly after?: string;
    readonly limit?: number;
  }) => Promise<{
    readonly entries: readonly { key: string; value: Exclude<StorageValue, undefined> }[];
    readonly next?: string;
  }>;
}

export interface TelemetryEvent {
  readonly seq: number;
  readonly time: number;
  readonly sessionID: string;
  readonly turnKey: string;
  readonly mode: RoutingMode;
  readonly decision: RoutingAction;
  readonly fingerprint?: string;
  readonly advisorWouldHelp?: number;
  readonly consequence?: number;
  readonly policy?: RoutingPolicySnapshot;
  readonly model?: string;
  readonly attempts?: number;
  readonly latencyMs?: number;
  readonly errorClass?: string;
  readonly advisorModel?: string;
  readonly delivered?: boolean;
}

export type TelemetryEventInput = Omit<TelemetryEvent, "seq" | "time">;

export interface TelemetryQuery {
  readonly after?: string;
  readonly limit?: number;
}

export interface TelemetryPage {
  readonly events: readonly TelemetryEvent[];
  readonly next?: string;
}

export interface TelemetryStore {
  readonly record: (input: TelemetryEventInput) => Promise<void>;
  readonly query: (input?: TelemetryQuery) => Promise<TelemetryPage>;
  readonly event: (seq: number) => Promise<TelemetryEvent | undefined>;
}

export type TelemetrySink = Pick<TelemetryStore, "record">;
