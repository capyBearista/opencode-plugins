import {
  TELEMETRY_CAP,
  TELEMETRY_PAGE_LIMIT,
  type TelemetryEvent,
  type TelemetryEventInput,
  type TelemetryJson,
  type TelemetryStorage,
  type TelemetryStore,
} from "./telemetry-types.js";

const HEAD_KEY = "head";
const EVENT_PREFIX = "evt:";

function eventKey(seq: number): string {
  return `${EVENT_PREFIX}${String(seq).padStart(16, "0")}`;
}

interface Head {
  readonly next: number;
  readonly oldest: number;
}

export function createTelemetryStore(
  storage: TelemetryStorage,
  options: { readonly cap?: number } = {},
): TelemetryStore {
  const cap = Math.max(1, options.cap ?? TELEMETRY_CAP);
  let queue: Promise<void> = Promise.resolve();

  const readHead = async (): Promise<Head> => {
    const value = await storage.get(HEAD_KEY);
    if (!isRecord(value) || !isCount(value.next) || !isCount(value.oldest)) {
      return { next: 0, oldest: 0 };
    }
    return { next: value.next, oldest: value.oldest };
  };

  const write = async (input: TelemetryEventInput): Promise<void> => {
    const head = await readHead();
    const seq = head.next;
    const evicted = seq - head.oldest + 1 > cap ? head.oldest : undefined;
    if (evicted !== undefined) await storage.remove(eventKey(evicted));
    await storage.set(HEAD_KEY, {
      next: seq + 1,
      oldest: evicted === undefined ? head.oldest : evicted + 1,
    });
    await storage.set(eventKey(seq), compact({ seq, time: Date.now(), ...input }));
  };

  return {
    record: (input) => {
      queue = queue.then(() => write(input)).catch(() => undefined);
      return queue;
    },
    query: async (input = {}) => {
      const limit = clampLimit(input.limit);
      const result = await storage.scan({
        prefix: EVENT_PREFIX,
        ...(input.after ? { after: input.after } : {}),
        limit,
      });
      const events: TelemetryEvent[] = [];
      for (const entry of result.entries) {
        if (isTelemetryEvent(entry.value)) events.push(entry.value);
      }
      return { events, ...(result.next ? { next: result.next } : {}) };
    },
    event: async (seq) => {
      const value = await storage.get(eventKey(seq));
      return isTelemetryEvent(value) ? value : undefined;
    },
  };
}

function compact(value: Record<string, unknown>): TelemetryJson {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as TelemetryJson;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TELEMETRY_PAGE_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), TELEMETRY_PAGE_LIMIT);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  return (
    isRecord(value) &&
    isCount(value.seq) &&
    typeof value.time === "number" &&
    typeof value.sessionID === "string" &&
    typeof value.turnKey === "string" &&
    typeof value.mode === "string" &&
    typeof value.decision === "string"
  );
}
