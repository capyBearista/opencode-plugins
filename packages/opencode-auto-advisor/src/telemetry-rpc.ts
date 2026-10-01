import { Rpc } from "@opencode/plugin";
import type { RpcDomain } from "@opencode/plugin/promise/rpc";
import type { TelemetryQuery, TelemetryStore } from "./telemetry-types.js";

export const TELEMETRY_RPC_ID = "experimental.auto-advisor";

const TELEMETRY_EVENT = {
  type: "object",
  properties: {
    seq: { type: "number" },
    time: { type: "number" },
    sessionID: { type: "string" },
    turnKey: { type: "string" },
    mode: { type: "string" },
    decision: { type: "string" },
    fingerprint: { type: "string" },
    advisorWouldHelp: { type: "number" },
    consequence: { type: "number" },
    rawConsequence: { type: "number" },
    consequenceProbabilities: { type: "object", additionalProperties: { type: "number" } },
    consequenceConfidence: { type: "number" },
    policy: {
      type: "object",
      properties: {
        advisorWouldHelpThreshold: { type: "number" },
        consequenceThreshold: { type: "number" },
      },
      required: ["advisorWouldHelpThreshold", "consequenceThreshold"],
      additionalProperties: false,
    },
    model: { type: "string" },
    attempts: { type: "number" },
    latencyMs: { type: "number" },
    errorClass: { type: "string" },
    failureDisposition: { type: "string", enum: ["retry", "fallback", "terminal"] },
    advisorModel: { type: "string" },
    skipReason: { type: "string" },
    advisorContext: {
      type: "object",
      properties: {
        complete: { type: "boolean" },
        omittedEntries: { type: "number" },
        includedEntries: { type: "number" },
        estimatedTokens: { type: "number" },
        inputBudget: { type: "number" },
      },
      required: ["complete", "omittedEntries", "includedEntries", "estimatedTokens", "inputBudget"],
      additionalProperties: false,
    },
    delivered: { type: "boolean" },
  },
  required: ["seq", "time", "sessionID", "turnKey", "mode", "decision"],
  additionalProperties: false,
} as const;

export const TelemetryRpc = Rpc.define({
  id: TELEMETRY_RPC_ID,
  methods: {
    "telemetry.query": {
      input: {
        type: "object",
        properties: {
          after: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          events: { type: "array", items: TELEMETRY_EVENT },
          next: { type: "string" },
        },
        required: ["events"],
        additionalProperties: false,
      },
    },
    "telemetry.event": {
      input: {
        type: "object",
        properties: { seq: { type: "number" } },
        required: ["seq"],
        additionalProperties: false,
      },
      output: { anyOf: [TELEMETRY_EVENT, { type: "null" }] },
    },
  },
  events: {},
});

export interface RpcRegistrationHandle {
  readonly dispose: () => Promise<void>;
}

export async function registerTelemetryRpc(
  rpc: RpcDomain,
  store: TelemetryStore,
): Promise<RpcRegistrationHandle> {
  const registration = await rpc.register(TelemetryRpc, {
    "telemetry.query": async (input) => {
      const page = await store.query(readQuery(input));
      return { events: [...page.events], ...(page.next ? { next: page.next } : {}) };
    },
    "telemetry.event": async (input) => (await store.event(readSeq(input))) ?? null,
  });
  return { dispose: () => registration.dispose() };
}

function readQuery(input: unknown): TelemetryQuery {
  if (!isRecord(input)) return {};
  return {
    ...(typeof input.after === "string" ? { after: input.after } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
  };
}

function readSeq(input: unknown): number {
  if (isRecord(input) && typeof input.seq === "number") return input.seq;
  throw new Error("telemetry.event requires a numeric seq");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
