import { AIError } from "@opencode/ai";

export type ZenDisposition = "retry" | "fallback" | "terminal";

export interface ZenFailure {
  readonly disposition: ZenDisposition;
  readonly errorClass: string;
}

const FALLBACK_CLASSES = new Set(["QuotaExceeded", "RateLimit"]);
const RETRY_CLASSES = new Set(["Transport", "ProviderInternal", "UnknownProvider"]);
const RETRY_HEADER = "x-should-retry";

export function classifyZenFailure(cause: unknown): ZenFailure {
  if (!(cause instanceof AIError)) {
    return { disposition: "terminal", errorClass: "UnknownError" };
  }
  const errorClass = cause.reason._tag;
  const base = baseDisposition(errorClass);
  const override = readHeader(cause.reason.http?.headers, RETRY_HEADER);
  if (override === "true") return { disposition: "retry", errorClass };
  if (override === "false") {
    return { disposition: base === "fallback" ? "fallback" : "terminal", errorClass };
  }
  return { disposition: base, errorClass };
}

function baseDisposition(errorClass: string): ZenDisposition {
  if (FALLBACK_CLASSES.has(errorClass)) return "fallback";
  if (RETRY_CLASSES.has(errorClass)) return "retry";
  return "terminal";
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
