import { describe, expect, test } from "bun:test";
import {
  AIError,
  AuthenticationError,
  ContentPolicyError,
  HttpContext,
  InvalidProviderOutputError,
  InvalidRequestError,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnknownProviderError,
  UnsupportedOperationError,
} from "@opencode/ai";
import { classifyZenFailure } from "./zen-errors.js";

const plain = (reason: ConstructorParameters<typeof AIError>[0]["reason"]) =>
  new AIError({ reason });

function headers(value: string, name = "x-should-retry"): HttpContext {
  return new HttpContext({
    url: "https://zen.test/systemone",
    status: 500,
    headers: { [name]: value },
  });
}

describe("classifyZenFailure", () => {
  test("retries rate limits, provider internals, and transport failures", () => {
    expect(classifyZenFailure(plain(new RateLimitError({ message: "slow down" })))).toEqual({
      disposition: "retry",
      errorClass: "RateLimit",
    });
    expect(classifyZenFailure(plain(new ProviderInternalError({ message: "5xx" })))).toEqual({
      disposition: "retry",
      errorClass: "ProviderInternal",
    });
    expect(
      classifyZenFailure(
        plain(new TransportError({ message: "socket", transport: "http", operation: "request" })),
      ),
    ).toEqual({ disposition: "retry", errorClass: "Transport" });
  });

  test("falls back to the next model on quota exhaustion", () => {
    expect(classifyZenFailure(plain(new QuotaExceededError({ message: "402" })))).toEqual({
      disposition: "fallback",
      errorClass: "QuotaExceeded",
    });
  });

  test("fails open immediately on deterministic classes", () => {
    const cases = [
      plain(new AuthenticationError({ message: "401" })),
      plain(new ContentPolicyError({ message: "policy" })),
      plain(new InvalidRequestError({ message: "400" })),
      plain(new TimeoutError({ message: "deadline" })),
      plain(new UnsupportedOperationError({ message: "nope", operation: "evaluate" })),
      plain(new InvalidProviderOutputError({ message: "bad shape" })),
      plain(new UnknownProviderError({ message: "?" })),
      new Error("not an AIError"),
    ];
    for (const cause of cases) {
      expect(classifyZenFailure(cause).disposition).toBe("terminal");
    }
  });

  test("honors the x-should-retry override in both directions", () => {
    expect(
      classifyZenFailure(plain(new InvalidRequestError({ message: "400", http: headers("true") }))),
    ).toEqual({ disposition: "retry", errorClass: "InvalidRequest" });
    expect(
      classifyZenFailure(plain(new RateLimitError({ message: "429", http: headers("false") }))),
    ).toEqual({ disposition: "terminal", errorClass: "RateLimit" });
    expect(
      classifyZenFailure(plain(new QuotaExceededError({ message: "402", http: headers("false") }))),
    ).toEqual({ disposition: "terminal", errorClass: "QuotaExceeded" });
  });

  test("reads the x-should-retry override case-insensitively", () => {
    expect(
      classifyZenFailure(
        plain(new InvalidRequestError({ message: "400", http: headers("true", "X-Should-Retry") })),
      ),
    ).toEqual({ disposition: "retry", errorClass: "InvalidRequest" });
    expect(
      classifyZenFailure(
        plain(new RateLimitError({ message: "429", http: headers("false", "X-SHOULD-RETRY") })),
      ),
    ).toEqual({ disposition: "terminal", errorClass: "RateLimit" });
  });

  test("reports the AIError class tag for every classified class", () => {
    expect(classifyZenFailure(plain(new AuthenticationError({ message: "401" }))).errorClass).toBe(
      "Authentication",
    );
    expect(classifyZenFailure(new Error("plain")).errorClass).toBe("UnknownError");
  });
});
