import { describe, expect, test } from "bun:test";
import {
  ADVISOR_DELIVERY_PREFIX,
  advisorAdviceText,
  deliverAdvice,
  deliverRetainedReviews,
  retainedReviewEntry,
} from "./advice-delivery.js";
import type { AdviceRecord } from "./advice-history.js";
import type { AssembledSystemPart } from "./messages.js";

function priorSystem(): AssembledSystemPart[] {
  return [{ type: "text", text: "hook-only system mutation" }];
}

function record(id: string, advice: string, turnKey = "turn-1"): AdviceRecord {
  return { id, sequence: 1, turnKey, materialFingerprint: "f".repeat(64), advice };
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
  test("builds one reviewer-framed system entry for retained records", () => {
    const entry = retainedReviewEntry([record("adv_1", "recheck the migration")]);

    expect(entry?.role).toBe("system");
    expect(entry?.text).toContain("[Auto Advisor retained reviews]");
    expect(entry?.text).toContain("recheck the migration");
    expect(entry?.text).toContain("adv_1");
  });

  test("omits the entry when there is nothing retained", () => {
    expect(retainedReviewEntry([])).toBeUndefined();
  });

  test("appends exactly one retained system part", () => {
    const system = priorSystem();

    const delivered = deliverRetainedReviews({
      system,
      records: [record("adv_1", "first"), record("adv_2", "second")],
    });

    expect(delivered).toBe(true);
    expect(system).toHaveLength(2);
    const text = system[1]?.text ?? "";
    expect(text).toContain("[Auto Advisor retained reviews]");
    expect(text).toContain("first");
    expect(text).toContain("second");
  });

  test("does not append when there are no retained records", () => {
    const system = priorSystem();

    expect(deliverRetainedReviews({ system, records: [] })).toBe(false);
    expect(system).toHaveLength(1);
  });
});
