import { randomUUID } from "node:crypto";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { SessionID } from "./messages.js";

export const ADVICE_HISTORY_STORAGE_KEY = "advice-history:v1";
export const ADVICE_HISTORY_MAX_SESSIONS = 64;
export const ADVICE_HISTORY_MAX_RECORDS_PER_SESSION = 16;
export const ADVICE_HISTORY_MAX_ADVICE_CHARS = 32_768;
export const ADVICE_HISTORY_MAX_SESSION_CHARS = 131_072;

type StorageValue = Awaited<ReturnType<PluginContext["storage"]["get"]>>;
export type AdviceHistoryJson = Exclude<StorageValue, null | undefined>;

export interface AdviceHistoryStorage {
  readonly get: (key: string) => Promise<StorageValue>;
  readonly set: (key: string, value: AdviceHistoryJson) => Promise<void>;
}

export interface AdviceRecord {
  readonly id: string;
  readonly sequence: number;
  readonly turnKey: string;
  readonly materialFingerprint: string;
  readonly advice: string;
}

export interface AdviceReservation {
  readonly sessionID: SessionID;
}

export interface AdviceCommitInput {
  readonly turnKey: string;
  readonly materialFingerprint: string;
  readonly advice: string;
}

export interface AdviceHistoryLimits {
  readonly maxSessions?: number;
  readonly maxRecordsPerSession?: number;
  readonly maxAdviceChars?: number;
  readonly maxSessionChars?: number;
}

export interface AdviceHistory {
  readonly reserve: (sessionID: SessionID) => Promise<AdviceReservation | undefined>;
  readonly get: (sessionID: SessionID) => Promise<readonly AdviceRecord[]>;
  readonly commit: (
    reservation: AdviceReservation,
    input: AdviceCommitInput,
  ) => Promise<AdviceRecord | undefined>;
  readonly release: (reservation: AdviceReservation) => void;
  readonly retire: (sessionID: SessionID, recordIDs: readonly string[]) => Promise<void>;
  readonly forget: (sessionID: SessionID) => Promise<void>;
  readonly dispose: () => void;
}

export class AdviceHistoryStateError extends Error {
  constructor() {
    super("stored advice history is not a valid version 1 state");
    this.name = "AdviceHistoryStateError";
  }
}

interface StoredSession {
  readonly sessionID: string;
  readonly records: readonly AdviceRecord[];
}

interface StoredState {
  readonly version: 1;
  readonly nextSequence: number;
  readonly sessions: readonly StoredSession[];
}

interface Grant {
  readonly sessionID: SessionID;
  readonly generation: number;
  readonly chars: number;
}

interface Held {
  readonly count: number;
  readonly chars: number;
}

const emptyState = (): StoredState => ({ version: 1, nextSequence: 1, sessions: [] });

export function createAdviceHistory(
  storage: AdviceHistoryStorage,
  options: { readonly limits?: AdviceHistoryLimits } = {},
): AdviceHistory {
  const maxSessions = atLeastOne(options.limits?.maxSessions ?? ADVICE_HISTORY_MAX_SESSIONS);
  const maxRecords = atLeastOne(
    options.limits?.maxRecordsPerSession ?? ADVICE_HISTORY_MAX_RECORDS_PER_SESSION,
  );
  const maxAdviceChars = atLeastOne(
    options.limits?.maxAdviceChars ?? ADVICE_HISTORY_MAX_ADVICE_CHARS,
  );
  const maxSessionChars = atLeastOne(
    options.limits?.maxSessionChars ?? ADVICE_HISTORY_MAX_SESSION_CHARS,
  );

  let state: StoredState | undefined;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const grants = new Map<AdviceReservation, Grant>();
  const held = new Map<SessionID, Held>();
  const generations = new Map<SessionID, number>();

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const load = async (): Promise<StoredState> => {
    if (state !== undefined) return state;
    const value = await storage.get(ADVICE_HISTORY_STORAGE_KEY);
    state = value === undefined || value === null ? emptyState() : parseStoredState(value);
    return state;
  };

  const persist = async (next: StoredState): Promise<void> => {
    await storage.set(ADVICE_HISTORY_STORAGE_KEY, next as unknown as AdviceHistoryJson);
  };

  const generationFor = (sessionID: SessionID): number => generations.get(sessionID) ?? 0;

  const dropGrant = (reservation: AdviceReservation): void => {
    const grant = grants.get(reservation);
    if (grant === undefined) return;
    grants.delete(reservation);
    const current = held.get(grant.sessionID);
    if (current === undefined) return;
    const count = current.count - 1;
    if (count <= 0) {
      held.delete(grant.sessionID);
      return;
    }
    held.set(grant.sessionID, { count, chars: current.chars - grant.chars });
  };

  const invalidateSession = (sessionID: SessionID): void => {
    for (const [reservation, grant] of grants) {
      if (grant.sessionID === sessionID) dropGrant(reservation);
    }
  };

  return {
    reserve: (sessionID) =>
      run(async () => {
        if (disposed) return undefined;
        const current = await load();
        if (disposed) return undefined;
        const records = sessionRecords(current, sessionID);
        const reserved = held.get(sessionID);
        const active = new Set(current.sessions.map((entry) => entry.sessionID));
        for (const id of held.keys()) active.add(id);
        if (!active.has(sessionID) && active.size >= maxSessions) return undefined;
        if (records.length + (reserved?.count ?? 0) >= maxRecords) return undefined;
        const chars =
          records.reduce((total, record) => total + record.advice.length, 0) +
          (reserved?.chars ?? 0);
        if (chars + maxAdviceChars > maxSessionChars) return undefined;

        const reservation: AdviceReservation = { sessionID };
        grants.set(reservation, {
          sessionID,
          generation: generationFor(sessionID),
          chars: maxAdviceChars,
        });
        held.set(sessionID, {
          count: (reserved?.count ?? 0) + 1,
          chars: (reserved?.chars ?? 0) + maxAdviceChars,
        });
        return reservation;
      }),

    get: (sessionID) =>
      run(async () => {
        const current = await load();
        return [...sessionRecords(current, sessionID)];
      }),

    commit: (reservation, input) =>
      run(async () => {
        const grant = grants.get(reservation);
        if (grant === undefined || disposed) return undefined;
        try {
          const current = await load();
          const live = grants.get(reservation);
          if (
            live === undefined ||
            live.generation !== generationFor(grant.sessionID) ||
            disposed
          ) {
            return undefined;
          }
          if (!isCommitInput(input) || input.advice.length > maxAdviceChars) return undefined;

          const record: AdviceRecord = Object.freeze({
            id: nextRecordID(current),
            sequence: current.nextSequence,
            turnKey: input.turnKey,
            materialFingerprint: input.materialFingerprint,
            advice: input.advice,
          });
          const next = appendRecord(current, grant.sessionID, record);
          await persist(next);
          state = next;
          return record;
        } finally {
          dropGrant(reservation);
        }
      }),

    release: (reservation) => {
      dropGrant(reservation);
    },

    retire: (sessionID, recordIDs) =>
      run(async () => {
        if (disposed) return;
        const current = await load();
        if (disposed) return;
        const next = removeRecords(current, sessionID, new Set(recordIDs));
        if (next === current) return;
        await persist(next);
        state = next;
      }),

    forget: (sessionID) => {
      generations.set(sessionID, generationFor(sessionID) + 1);
      invalidateSession(sessionID);
      return run(async () => {
        invalidateSession(sessionID);
        if (disposed) return;
        const current = await load();
        if (disposed) return;
        const next = dropSession(current, sessionID);
        if (next === current) return;
        await persist(next);
        state = next;
      });
    },

    dispose: () => {
      disposed = true;
      grants.clear();
      held.clear();
    },
  };
}

function sessionRecords(state: StoredState, sessionID: SessionID): readonly AdviceRecord[] {
  return state.sessions.find((entry) => entry.sessionID === sessionID)?.records ?? [];
}

function appendRecord(state: StoredState, sessionID: SessionID, record: AdviceRecord): StoredState {
  const index = state.sessions.findIndex((entry) => entry.sessionID === sessionID);
  const sessions =
    index === -1
      ? [...state.sessions, { sessionID, records: [record] }]
      : state.sessions.map((entry, at) =>
          at === index ? { sessionID, records: [...entry.records, record] } : entry,
        );
  return { version: 1, nextSequence: record.sequence + 1, sessions };
}

function removeRecords(
  state: StoredState,
  sessionID: SessionID,
  ids: ReadonlySet<string>,
): StoredState {
  const entry = state.sessions.find((candidate) => candidate.sessionID === sessionID);
  if (entry === undefined) return state;
  const records = entry.records.filter((record) => !ids.has(record.id));
  if (records.length === entry.records.length) return state;
  const sessions =
    records.length === 0
      ? state.sessions.filter((candidate) => candidate.sessionID !== sessionID)
      : state.sessions.map((candidate) =>
          candidate.sessionID === sessionID ? { sessionID, records } : candidate,
        );
  return { version: 1, nextSequence: state.nextSequence, sessions };
}

function dropSession(state: StoredState, sessionID: SessionID): StoredState {
  if (!state.sessions.some((entry) => entry.sessionID === sessionID)) return state;
  return { ...state, sessions: state.sessions.filter((entry) => entry.sessionID !== sessionID) };
}

function nextRecordID(state: StoredState): string {
  const existing = new Set(
    state.sessions.flatMap((entry) => entry.records.map((record) => record.id)),
  );
  let id = `adv_${randomUUID()}`;
  while (existing.has(id)) id = `adv_${randomUUID()}`;
  return id;
}

function isCommitInput(input: AdviceCommitInput): boolean {
  return (
    typeof input.turnKey === "string" &&
    input.turnKey.length > 0 &&
    typeof input.materialFingerprint === "string" &&
    input.materialFingerprint.length > 0 &&
    typeof input.advice === "string" &&
    input.advice.length > 0
  );
}

function atLeastOne(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function parseStoredState(value: unknown): StoredState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isSequence(value.nextSequence) ||
    !Array.isArray(value.sessions)
  ) {
    throw new AdviceHistoryStateError();
  }

  const sessions: StoredSession[] = [];
  const ids = new Set<string>();
  const sessionIDs = new Set<string>();
  let maxSequence = 0;
  for (const raw of value.sessions) {
    if (
      !isRecord(raw) ||
      typeof raw.sessionID !== "string" ||
      raw.sessionID.length === 0 ||
      sessionIDs.has(raw.sessionID) ||
      !Array.isArray(raw.records)
    ) {
      throw new AdviceHistoryStateError();
    }
    sessionIDs.add(raw.sessionID);
    const records: AdviceRecord[] = [];
    for (const entry of raw.records) {
      if (!isStoredRecord(entry) || ids.has(entry.id)) throw new AdviceHistoryStateError();
      ids.add(entry.id);
      maxSequence = Math.max(maxSequence, entry.sequence);
      records.push(
        Object.freeze({
          id: entry.id,
          sequence: entry.sequence,
          turnKey: entry.turnKey,
          materialFingerprint: entry.materialFingerprint,
          advice: entry.advice,
        }),
      );
    }
    sessions.push({ sessionID: raw.sessionID, records });
  }

  if (value.nextSequence <= maxSequence) throw new AdviceHistoryStateError();
  return { version: 1, nextSequence: value.nextSequence, sessions };
}

function isStoredRecord(value: unknown): value is AdviceRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isSequence(value.sequence) &&
    typeof value.turnKey === "string" &&
    typeof value.materialFingerprint === "string" &&
    typeof value.advice === "string"
  );
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
