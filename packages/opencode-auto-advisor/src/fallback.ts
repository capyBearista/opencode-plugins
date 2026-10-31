/**
 * Walks an ordered list of models until one answers, for both the Decision router and the
 * Advisor chain. The host already retries rate limits, overload and requests it never sent, so a
 * failure here moves to the next model or stops; it never retries.
 */

export type AttemptOutcome = "ok" | "next" | "stop" | "timeout" | "skipped";

export interface Attempt {
  readonly model: string;
  readonly outcome: AttemptOutcome;
  readonly ms: number;
  readonly error?: string;
}

export type WalkResult<T> =
  | { readonly ok: true; readonly model: string; readonly value: T; readonly attempts: Attempt[] }
  | { readonly ok: false; readonly attempts: Attempt[] };

export const SKIP_MS = 60_000;

/**
 * OpenCode 2.2.0's generate errors (`core/src/generate.ts`, spike S1). A provider's
 * `invalid_request` moves on: it is how a context overflow arrives (the host drops its
 * `context-overflow` classification), and a parameter one model rejects says nothing about the
 * next. A content filter would see the same content anywhere, and `Generate.InvalidRequestError`
 * is a config error such as a bad `#variant`: both stop, so they fail loudly.
 */
export function classify(error: unknown): {
  action: "next" | "stop";
  skip: boolean;
  error: string;
} {
  const value = error as { _tag?: string; reason?: string; message?: unknown } | undefined;
  const tag = value?._tag;
  if (!tag) {
    const message = typeof value?.message === "string" ? value.message : String(error);
    return { action: "stop", skip: false, error: message };
  }
  if (tag === "Generate.ProviderRequestError") {
    const label = `${tag} (${value.reason})`;
    if (value.reason === "content_filter") return { action: "stop", skip: false, error: label };
    const skip = value.reason === "rate_limit" || value.reason === "overloaded";
    return { action: "next", skip, error: label };
  }
  if (
    tag === "Generate.ModelNotFoundError" ||
    tag === "Generate.UnsupportedModelError" ||
    tag === "Generate.UnavailableError" ||
    tag === "Advisor.EmptyAdvice"
  ) {
    return { action: "next", skip: false, error: tag };
  }
  return { action: "stop", skip: false, error: tag };
}

const TIMEOUT = Symbol("timeout");

function race<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  // A late rejection from an abandoned call must not surface as unhandled.
  promise.catch(() => {});
  // setTimeout treats Infinity as 0, so an unlimited wait must not start a timer.
  if (!Number.isFinite(ms)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One walker per chain; its skip map outlives a walk, so a model that was rate limited,
 * overloaded or timed out is skipped for `SKIP_MS` instead of stalling every call.
 */
export function createWalker(now: () => number = Date.now) {
  const skipUntil = new Map<string, number>();
  return async <E, T>(input: {
    readonly entries: readonly E[];
    readonly key: (entry: E) => string;
    readonly call: (entry: E) => Promise<T>;
    /** Per model; may be Infinity. */
    readonly attemptMs: number;
    /** Shared by the whole walk; may be Infinity. */
    readonly totalMs: number;
  }): Promise<WalkResult<T>> => {
    const attempts: Attempt[] = [];
    const deadline = now() + input.totalMs;
    for (const entry of input.entries) {
      const model = input.key(entry);
      if ((skipUntil.get(model) ?? 0) > now()) {
        attempts.push({ model, outcome: "skipped", ms: 0 });
        continue;
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const start = now();
      try {
        const value = await race(input.call(entry), Math.min(input.attemptMs, remaining));
        if (value === TIMEOUT) {
          attempts.push({ model, outcome: "timeout", ms: now() - start });
          skipUntil.set(model, now() + SKIP_MS);
          continue;
        }
        attempts.push({ model, outcome: "ok", ms: now() - start });
        return { ok: true, model, value, attempts };
      } catch (cause) {
        const { action, skip, error } = classify(cause);
        attempts.push({ model, outcome: action, ms: now() - start, error });
        if (skip) skipUntil.set(model, now() + SKIP_MS);
        if (action === "stop") return { ok: false, attempts };
      }
    }
    return { ok: false, attempts };
  };
}
