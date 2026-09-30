import { describe, expect, test } from "bun:test";
import {
  ADVISOR_DELIVERY_PREFIX,
  advisorAdviceText,
  createAdviceLifetime,
  deliverAdvice,
} from "./advice-delivery.js";
import type { AssembledMessage, SessionID } from "./messages.js";

const SESSION = "ses_1" as SessionID;

function priorMessage(): AssembledMessage {
  return {
    id: "msg-user-1",
    role: "user",
    content: [{ type: "text", text: "fix it" }],
  } as AssembledMessage;
}

describe("advice delivery", () => {
  test("injects the advice as a system-role message at the end of the dispatch", () => {
    const messages: AssembledMessage[] = [priorMessage()];

    deliverAdvice({ messages, advice: "check the rollback" });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(priorMessage());
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toEqual([
      { type: "text", text: advisorAdviceText("check the rollback") },
    ]);
    expect(advisorAdviceText("check the rollback")).toStartWith(ADVISOR_DELIVERY_PREFIX);
  });
});

describe("advice lifetime", () => {
  test("keeps a single live advice per turn and lets newer advice supersede it", () => {
    const lifetime = createAdviceLifetime();

    lifetime.activate(SESSION, "turn-1", "first");
    expect(lifetime.current(SESSION)).toEqual({ turnKey: "turn-1", text: "first" });

    lifetime.activate(SESSION, "turn-1", "second");
    expect(lifetime.current(SESSION)).toEqual({ turnKey: "turn-1", text: "second" });
  });

  test("expires advice when a new user turn starts", () => {
    const lifetime = createAdviceLifetime();
    lifetime.activate(SESSION, "turn-1", "first");

    lifetime.expire(SESSION, "turn-1");
    expect(lifetime.current(SESSION)).toEqual({ turnKey: "turn-1", text: "first" });

    lifetime.expire(SESSION, "turn-2");
    expect(lifetime.current(SESSION)).toBeUndefined();
  });

  test("forgets a session on cleanup", () => {
    const lifetime = createAdviceLifetime();
    lifetime.activate(SESSION, "turn-1", "first");

    lifetime.forget(SESSION);
    expect(lifetime.current(SESSION)).toBeUndefined();
    expect(lifetime.sessions()).toBe(0);
  });

  test("bounds the number of tracked sessions", () => {
    const lifetime = createAdviceLifetime({ maxSessions: 2 });
    lifetime.activate("ses_1" as SessionID, "t", "a");
    lifetime.activate("ses_2" as SessionID, "t", "b");
    lifetime.activate("ses_3" as SessionID, "t", "c");

    expect(lifetime.sessions()).toBe(2);
    expect(lifetime.current("ses_1" as SessionID)).toBeUndefined();
    expect(lifetime.current("ses_3" as SessionID)).toEqual({ turnKey: "t", text: "c" });
  });
});
