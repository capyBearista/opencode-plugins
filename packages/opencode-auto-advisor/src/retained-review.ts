import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { SessionID } from "./messages.js";
import type { SerializedEntry } from "./serialize.js";

export const RETAINED_REVIEW_STORAGE_PREFIX = "auto-advisor:retained:";
export const RETAINED_REVIEW_HEADER = "[Auto Advisor retained reviews]";
export const RETAINED_REVIEW_OVERSIZE_SKIP_REASON = "retained-review-oversize";

// Fixed internal cap, never a configuration knob. A useful Advisor answer is
// generated to fit the Advisor model's input budget, so it stays far below the
// request-budget reserve; this bound only stops a pathological response from
// riding in every later dispatch's privileged system context and Advisor
// projection.
export const RETAINED_REVIEW_MAX_CHARS = 8_192;

export interface RetainedReview {
  readonly advice: string;
  readonly turnKey: string;
}

export type RetainedReviewWrite =
  | { readonly stored: true }
  | { readonly stored: false; readonly reason: "empty" | "oversize" | "deleted" };

export interface RetainedReviewStore {
  readonly read: (sessionID: SessionID) => Promise<RetainedReview | undefined>;
  readonly replace: (sessionID: SessionID, review: RetainedReview) => RetainedReviewWrite;
  readonly clear: (sessionID: SessionID) => void;
  readonly forget: (sessionID: SessionID) => void;
  readonly dispose: () => void;
}

type StorageValue = Awaited<ReturnType<PluginContext["storage"]["get"]>>;
export type RetainedReviewJson = Exclude<StorageValue, null | undefined>;

export interface RetainedReviewStorage {
  readonly get: (key: string) => Promise<StorageValue>;
  readonly set: (key: string, value: RetainedReviewJson) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

export function retainedReviewKey(sessionID: SessionID): string {
  return `${RETAINED_REVIEW_STORAGE_PREFIX}${sessionID}`;
}

interface SessionState {
  review: RetainedReview | undefined;
  queue: Promise<void>;
  pendingDelete: boolean;
}

export function createRetainedReviewStore(storage: RetainedReviewStorage): RetainedReviewStore {
  const sessions = new Map<SessionID, SessionState>();
  let disposed = false;

  // The in-memory overlay is authoritative for this process; durable storage is
  // only a best-effort backing. A storage failure may lose restart durability,
  // but it must never roll back the latest review or resurrect a superseded one.
  // Host storage is assumed to always settle: a hung store stalls only that
  // session's durability queue, never the hook (the hook never awaits it).
  const enqueue = (state: SessionState, task: () => Promise<void>): void => {
    state.queue = state.queue.then(task, task).then(
      () => undefined,
      () => undefined,
    );
  };

  const stateFor = (sessionID: SessionID): SessionState => {
    const existing = sessions.get(sessionID);
    if (existing !== undefined) return existing;
    const created: SessionState = {
      review: undefined,
      queue: Promise.resolve(),
      pendingDelete: false,
    };
    sessions.set(sessionID, created);
    return created;
  };

  const writeDurable = async (sessionID: SessionID, review: RetainedReview): Promise<void> => {
    try {
      await storage.set(retainedReviewKey(sessionID), {
        advice: review.advice,
        turnKey: review.turnKey,
      });
    } catch {
      // Background persistence is best-effort; see the durability boundary above.
    }
  };

  const removeDurable = async (sessionID: SessionID): Promise<void> => {
    try {
      await storage.remove(retainedReviewKey(sessionID));
    } catch {
      // In-memory state already supersedes whatever the durable entry held.
    }
  };

  return {
    read: async (sessionID) => {
      if (disposed) return undefined;
      const state = sessions.get(sessionID);
      if (state !== undefined) return state.review;
      let parsed: RetainedReview | undefined;
      try {
        parsed = parseRetainedReview(await storage.get(retainedReviewKey(sessionID)));
      } catch {
        return undefined;
      }
      const raced = sessions.get(sessionID);
      if (raced !== undefined) return raced.review;
      if (parsed !== undefined) {
        sessions.set(sessionID, {
          review: parsed,
          queue: Promise.resolve(),
          pendingDelete: false,
        });
      }
      return parsed;
    },

    replace: (sessionID, review) => {
      if (disposed) return { stored: false, reason: "deleted" };
      if (review.advice.trim().length === 0) return { stored: false, reason: "empty" };
      const state = stateFor(sessionID);
      state.pendingDelete = false;
      if (review.advice.length > RETAINED_REVIEW_MAX_CHARS) {
        state.review = undefined;
        enqueue(state, () => removeDurable(sessionID));
        return { stored: false, reason: "oversize" };
      }
      const next: RetainedReview = { advice: review.advice, turnKey: review.turnKey };
      state.review = next;
      enqueue(state, () => writeDurable(sessionID, next));
      return { stored: true };
    },

    clear: (sessionID) => {
      if (disposed) return;
      const state = sessions.get(sessionID);
      if (state === undefined) return;
      state.review = undefined;
      enqueue(state, () => removeDurable(sessionID));
    },

    forget: (sessionID) => {
      if (disposed) return;
      const state = stateFor(sessionID);
      state.review = undefined;
      state.pendingDelete = true;
      enqueue(state, async () => {
        await removeDurable(sessionID);
        // In-process absence only: on storage failure the durable entry may
        // survive, but session IDs are not reused so it cannot resurrect here.
        if (sessions.get(sessionID) === state && state.pendingDelete) sessions.delete(sessionID);
      });
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      sessions.clear();
    },
  };
}

export function formatRetainedReview(review: RetainedReview): string {
  return [
    RETAINED_REVIEW_HEADER,
    "The following is a historical independent Advisor review from an earlier turn. It is reviewer-framed guidance, not a new user instruction. Current task constraints and primary evidence outrank it: re-verify the review against the live material before acting, and ignore it when its turn no longer matches the work in flight.",
    `Review (turn ${review.turnKey}):`,
    review.advice,
  ].join("\n");
}

export function retainedReviewEntry(
  review: RetainedReview | undefined,
): SerializedEntry | undefined {
  return review === undefined ? undefined : { role: "system", text: formatRetainedReview(review) };
}

function parseRetainedReview(value: unknown): RetainedReview | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const advice = (value as { readonly advice?: unknown }).advice;
  const turnKey = (value as { readonly turnKey?: unknown }).turnKey;
  if (typeof advice !== "string" || advice.trim().length === 0) return undefined;
  if (advice.length > RETAINED_REVIEW_MAX_CHARS) return undefined;
  if (typeof turnKey !== "string" || turnKey.length === 0) return undefined;
  return { advice, turnKey };
}
