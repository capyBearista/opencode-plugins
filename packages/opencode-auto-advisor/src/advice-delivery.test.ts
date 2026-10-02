import { describe, expect, test } from "bun:test";
import {
  ADVISOR_DELIVERY_PREFIX,
  advisorAdviceText,
  deliverAdvice,
  deliverRetainedReview,
} from "./advice-delivery.js";
import type { AssembledSystemPart } from "./messages.js";
import { RETAINED_REVIEW_HEADER } from "./retained-review.js";

function priorSystem(): AssembledSystemPart[] {
  return [{ type: "text", text: "hook-only system mutation" }];
}

describe("advice delivery", () => {
  test("appends the advice as one text system part", () => {
    const system = priorSystem();

    deliverAdvice({ system, advice: "check the rollback" });

    expect(system).toHaveLength(2);
    expect(system[0]).toEqual(priorSystem()[0]);
    expect(system[1]).toEqual({ type: "text", text: advisorAdviceText("check the rollback") });
    expect(advisorAdviceText("check the rollback")).toStartWith(ADVISOR_DELIVERY_PREFIX);
  });

  test("propagates an immutable system failure instead of claiming delivery", () => {
    const system = priorSystem();
    Object.freeze(system);

    expect(() => deliverAdvice({ system, advice: "check the rollback" })).toThrow();
    expect(system).toHaveLength(1);
  });
});

describe("retained review delivery", () => {
  test("appends one reviewer-framed system part for the retained review", () => {
    const system = priorSystem();

    deliverRetainedReview({
      system,
      review: { advice: "recheck the migration", turnKey: "msg-1" },
    });

    expect(system).toHaveLength(2);
    const text = system[1]?.text ?? "";
    expect(text).toStartWith(RETAINED_REVIEW_HEADER);
    expect(text).toContain("recheck the migration");
    expect(text).toContain("msg-1");
  });

  test("propagates an immutable system failure instead of claiming delivery", () => {
    const system = priorSystem();
    Object.freeze(system);

    expect(() =>
      deliverRetainedReview({ system, review: { advice: "recheck", turnKey: "msg-1" } }),
    ).toThrow();
    expect(system).toHaveLength(1);
  });
});
