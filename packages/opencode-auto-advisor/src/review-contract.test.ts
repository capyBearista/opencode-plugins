import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  REVIEW_RPC,
  REVIEW_RPC_ID,
  REVIEW_STATUS_SCHEMA,
  type ReviewStatus,
} from "./review-contract.js";

interface SchemaNode {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly required?: readonly string[];
  readonly enum?: readonly unknown[];
  readonly additionalProperties?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findProperty(schema: SchemaNode, name: string): SchemaNode | undefined {
  const properties = schema.properties;
  if (!properties) return undefined;
  if (properties[name]) return properties[name];
  for (const child of Object.values(properties)) {
    const nested = findProperty(child, name);
    if (nested) return nested;
  }
  return schema.items ? findProperty(schema.items, name) : undefined;
}

function expectSchemaCovers(
  schema: SchemaNode,
  value: Record<string, unknown>,
  path: string,
): void {
  const properties = schema.properties;
  expect(properties, `no declared properties at ${path}`).toBeDefined();
  for (const key of Object.keys(value)) {
    const sub = properties?.[key];
    expect(sub, `undeclared field ${path}.${key} (the host RPC path strips it)`).toBeDefined();
    const subValue = value[key];
    if (sub?.type === "object" && sub.properties !== undefined && isRecord(subValue)) {
      expectSchemaCovers(sub, subValue, `${path}.${key}`);
    }
    if (sub?.type === "array" && sub.items !== undefined && Array.isArray(subValue)) {
      for (const item of subValue) {
        if (isRecord(item)) expectSchemaCovers(sub.items, item, `${path}.${key}[]`);
      }
    }
  }
}

const maximalStatus: ReviewStatus = {
  sessionID: "ses_max",
  epoch: "epoch-1",
  revision: 7,
  running: [{ id: "run-1", startedAt: 1000 }],
  lastFinished: { id: "run-0", startedAt: 900, finishedAt: 1000, outcome: "timeout" },
  latest: { id: "run-0", finishedAt: 1000, advice: "review text" },
};

describe("review contract", () => {
  test("declares an independent review rpc surface", () => {
    expect(REVIEW_RPC_ID).toBe("experimental.auto-advisor.review");
    expect(Object.keys(REVIEW_RPC.methods)).toEqual(["status"]);
    expect(Object.keys(REVIEW_RPC.events).sort()).toEqual(["review.finished", "review.started"]);
  });

  test("declares the status input as a strict sessionID request", () => {
    const input = REVIEW_RPC.methods.status.input as SchemaNode;
    expect(input.type).toBe("object");
    expect(input.properties?.sessionID).toEqual({ type: "string" });
    expect(input.required).toEqual(["sessionID"]);
    expect(input.additionalProperties).toBe(false);
  });

  test("declares every nested status field with strict objects and an outcome enum", () => {
    const schema = REVIEW_STATUS_SCHEMA as SchemaNode;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["sessionID", "epoch", "revision", "running"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "epoch",
      "lastFinished",
      "latest",
      "revision",
      "running",
      "sessionID",
    ]);

    const running = schema.properties?.running;
    expect(running?.type).toBe("array");
    expect(running?.items?.additionalProperties).toBe(false);
    expect(running?.items?.required).toEqual(["id", "startedAt"]);
    expect(Object.keys(running?.items?.properties ?? {}).sort()).toEqual(["id", "startedAt"]);

    const lastFinished = schema.properties?.lastFinished;
    expect(lastFinished?.additionalProperties).toBe(false);
    expect(lastFinished?.required).toEqual(["id", "startedAt", "finishedAt", "outcome"]);
    expect(lastFinished?.properties?.outcome?.enum).toEqual(["completed", "failed", "timeout"]);

    const latest = schema.properties?.latest;
    expect(latest?.additionalProperties).toBe(false);
    expect(latest?.required).toEqual(["id", "finishedAt", "advice"]);
    expect(Object.keys(latest?.properties ?? {}).sort()).toEqual(["advice", "finishedAt", "id"]);
  });

  test("declares both events with the full status schema", () => {
    expect(REVIEW_RPC.events["review.started"].schema).toBe(REVIEW_STATUS_SCHEMA);
    expect(REVIEW_RPC.events["review.finished"].schema).toBe(REVIEW_STATUS_SCHEMA);
  });

  test("the maximal status is fully covered by the schema", () => {
    expectSchemaCovers(
      REVIEW_STATUS_SCHEMA as SchemaNode,
      maximalStatus as unknown as Record<string, unknown>,
      "status",
    );
  });

  test("latest carries only advice and provenance identifiers", () => {
    expect(Object.keys(maximalStatus.latest ?? {}).sort()).toEqual(["advice", "finishedAt", "id"]);
    for (const forbidden of ["confidence", "reasoning", "input", "telemetry", "error"]) {
      expect(findProperty(REVIEW_STATUS_SCHEMA as SchemaNode, forbidden)).toBeUndefined();
    }
  });

  test("the contract module imports nothing, keeping it shared and dependency free", async () => {
    const source = await Bun.file(join(import.meta.dir, "review-contract.ts")).text();
    expect(source).not.toContain("import ");
    expect(source).not.toContain("@opentui");
    expect(source).not.toContain("@opencode/plugin");
  });
});
