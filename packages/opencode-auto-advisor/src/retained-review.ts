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
  readonly write: (sessionID: SessionID, review: RetainedReview) => Promise<RetainedReviewWrite>;
  readonly remove: (sessionID: SessionID) => Promise<void>;
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

export function createRetainedReviewStore(storage: RetainedReviewStorage): RetainedReviewStore {
  const deleted = new Set<SessionID>();
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    read: (sessionID) =>
      run(async () => {
        if (disposed || deleted.has(sessionID)) return undefined;
        return parseRetainedReview(await storage.get(retainedReviewKey(sessionID)));
      }),

    write: (sessionID, review) => {
      if (review.advice.length === 0) return Promise.resolve({ stored: false, reason: "empty" });
      if (review.advice.length > RETAINED_REVIEW_MAX_CHARS) {
        return Promise.resolve({ stored: false, reason: "oversize" });
      }
      return run(async () => {
        if (disposed || deleted.has(sessionID)) return { stored: false, reason: "deleted" };
        await storage.set(retainedReviewKey(sessionID), {
          advice: review.advice,
          turnKey: review.turnKey,
        });
        return { stored: true };
      });
    },

    remove: (sessionID) => {
      deleted.add(sessionID);
      return run(async () => {
        await storage.remove(retainedReviewKey(sessionID));
      });
    },

    dispose: () => {
      disposed = true;
      deleted.clear();
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
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { advice?: unknown }).advice !== "string" ||
    typeof (value as { turnKey?: unknown }).turnKey !== "string"
  ) {
    return undefined;
  }
  const review = value as { readonly advice: string; readonly turnKey: string };
  return { advice: review.advice, turnKey: review.turnKey };
}
