import { describe, expect, test } from "bun:test";
import type { SessionID } from "./messages.js";
import { createOperationLifetime } from "./operation-lifetime.js";

const session = (id: string): SessionID => id as SessionID;

describe("createOperationLifetime", () => {
  test("tracks multiple pending tokens for the same session independently", () => {
    const lifetime = createOperationLifetime();
    const first = lifetime.begin(session("ses_1"));
    const second = lifetime.begin(session("ses_1"));

    expect(first.isCurrent()).toBe(true);
    expect(second.isCurrent()).toBe(true);

    first.release();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    second.release();

    expect(second.isCurrent()).toBe(false);
  });

  test("forget invalidates every pending token for that session and leaves other sessions current", () => {
    const lifetime = createOperationLifetime();
    const first = lifetime.begin(session("ses_1"));
    const second = lifetime.begin(session("ses_1"));
    const other = lifetime.begin(session("ses_2"));

    lifetime.forget(session("ses_1"));

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
    expect(other.isCurrent()).toBe(true);

    lifetime.forget(session("ses_2"));

    expect(other.isCurrent()).toBe(false);
  });

  test("a token captured before an await stays current until the session is forgotten", async () => {
    const lifetime = createOperationLifetime();
    const token = lifetime.begin(session("ses_1"));

    await Promise.resolve();
    expect(token.isCurrent()).toBe(true);

    lifetime.forget(session("ses_1"));

    await Promise.resolve();
    expect(token.isCurrent()).toBe(false);
  });

  test("a later operation for the same session is unaffected by releasing an old token", () => {
    const lifetime = createOperationLifetime();
    const stale = lifetime.begin(session("ses_1"));
    lifetime.forget(session("ses_1"));
    const fresh = lifetime.begin(session("ses_1"));

    stale.release();

    expect(stale.isCurrent()).toBe(false);
    expect(fresh.isCurrent()).toBe(true);

    lifetime.forget(session("ses_1"));

    expect(fresh.isCurrent()).toBe(false);
  });

  test("release is idempotent and only invalidates its own token", () => {
    const lifetime = createOperationLifetime();
    const first = lifetime.begin(session("ses_1"));
    const second = lifetime.begin(session("ses_1"));

    first.release();
    first.release();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    second.release();
    second.release();

    expect(second.isCurrent()).toBe(false);
    expect(lifetime.begin(session("ses_1")).isCurrent()).toBe(true);
  });

  test("dispose invalidates all tokens across sessions and is idempotent", () => {
    const lifetime = createOperationLifetime();
    const first = lifetime.begin(session("ses_1"));
    const second = lifetime.begin(session("ses_2"));

    lifetime.dispose();
    lifetime.dispose();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);

    first.release();
    second.release();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
  });

  test("begin after dispose returns an inert token without registering state", () => {
    const lifetime = createOperationLifetime();
    lifetime.dispose();

    const late = lifetime.begin(session("ses_1"));

    expect(late.isCurrent()).toBe(false);

    late.release();

    expect(late.isCurrent()).toBe(false);

    lifetime.forget(session("ses_1"));

    expect(late.isCurrent()).toBe(false);
  });
});
