import { AIError } from "@opencode/ai";

export type ZenDisposition = "retry" | "fallback" | "terminal";

export interface ZenFailure {
  readonly disposition: ZenDisposition;
  readonly errorClass: string;
}

const RETRYABLE_CLASSES = new Set(["RateLimit", "ProviderInternal", "Transport"]);
const RETRY_HEADER = "x-should-retry";

export function classifyZenFailure(cause: unknown): ZenFailure {
  if (!(cause instanceof AIError)) {
    return { disposition: "terminal", errorClass: "UnknownError" };
  }
  const errorClass = cause.reason._tag;
  const override = readHeader(cause.reason.http?.headers, RETRY_HEADER);
  if (override === "true") return { disposition: "retry", errorClass };
  if (override === "false") return { disposition: "terminal", errorClass };
  if (errorClass === "QuotaExceeded") return { disposition: "fallback", errorClass };
  if (RETRYABLE_CLASSES.has(errorClass)) return { disposition: "retry", errorClass };
  return { disposition: "terminal", errorClass };
}

function readHeader(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}
