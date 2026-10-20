import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RpcDomain } from "@opencode/plugin/promise/rpc";
import {
  REVIEW_RPC,
  REVIEW_RPC_ID,
  REVIEW_STATUS_SCHEMA,
  type ReviewStatus,
} from "./review-contract.js";
import { createReviewLifecycle } from "./review-lifecycle.js";
import { ReviewRpc, registerReviewRpc } from "./review-rpc.js";
import { TELEMETRY_RPC_ID, TelemetryRpc } from "./telemetry-rpc.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Handler = (input: unknown) => Promise<unknown>;

interface FakeRegistration {
  readonly definition: {
    readonly id: string;
    readonly methods: Readonly<Record<string, unknown>>;
    readonly events: Readonly<Record<string, { readonly schema: unknown }>>;
  };
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly emitted: Array<[string, unknown]>;
  disposed: number;
}

function fakeRpc() {
  const registrations: FakeRegistration[] = [];
  const rpc = {
    register: async (
      definition: FakeRegistration["definition"],
      handlers: Record<string, Handler>,
    ) => {
      const registration: FakeRegistration = { definition, handlers, emitted: [], disposed: 0 };
      registrations.push(registration);
      return {
        dispose: async () => {
          registration.disposed += 1;
        },
        events: {
          emit: async (...args: [string, unknown]) => {
            registration.emitted.push(args);
          },
        },
      };
    },
  } as unknown as RpcDomain;
  return { rpc, registrations };
}

interface SchemaNode {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly required?: readonly string[];
  readonly enum?: readonly unknown[];
  readonly additionalProperties?: unknown;
}

function expectStrictSchema(schema: SchemaNode, value: unknown, path: string): void {
  if (schema.type === "object") {
    expect(schema.additionalProperties, `open object at ${path}`).toBe(false);
    const properties = schema.properties ?? {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const sub = properties[key];
      expect(sub, `undeclared field ${path}.${key}`).toBeDefined();
      if (sub) expectStrictSchema(sub, record[key], `${path}.${key}`);
    }
    for (const key of schema.required ?? []) {
      expect(Object.keys(record), `missing required field ${path}.${key}`).toContain(key);
    }
    return;
  }
  if (schema.type === "array") {
    expect(schema.items, `missing array items at ${path}`).toBeDefined();
    for (const [index, item] of (value as readonly unknown[]).entries()) {
      if (schema.items) expectStrictSchema(schema.items, item, `${path}[${index}]`);
    }
    return;
  }
  if (schema.enum) {
    expect(schema.enum, `enum mismatch at ${path}`).toContain(value);
    return;
  }
  expect(typeof value, `primitive type mismatch at ${path}`).toBe(schema.type);
}

const ALLOWED_PACKAGES = ["@opencode/ai", "@opencode/plugin"];
const REQUIRE_CALL = "requ" + "ire(";

function importSpecifiers(source: string): string[] {
  const from = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
  const bare = [...source.matchAll(/^import\s+["']([^"']+)["']/gm)].map((match) => match[1] ?? "");
  return [...from, ...bare];
}

function isSelfContained(specifier: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return true;
  return ALLOWED_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

const maximalStatus: ReviewStatus = {
  sessionID: "ses_max",
  epoch: "epoch-1",
  revision: 4,
  running: [{ id: "run-2", startedAt: 2000 }],
  lastFinished: { id: "run-1", startedAt: 1000, finishedAt: 1500, outcome: "timeout" },
  latest: { id: "run-0", finishedAt: 900, advice: "review text" },
};

describe("review rpc", () => {
  test("registers the independent review rpc with status and full-snapshot events", async () => {
    const fake = fakeRpc();
    const lifecycle = createReviewLifecycle({ clock: () => 5, idFactory: () => "run-1" });
    const registration = await registerReviewRpc(fake.rpc, lifecycle);

    const registered = fake.registrations[0];
    expect(registered?.definition.id).toBe(REVIEW_RPC_ID);
    expect(Object.keys(registered?.definition.methods ?? {})).toEqual(["status"]);
    expect(Object.keys(registered?.definition.events ?? {}).sort()).toEqual([
      "review.finished",
      "review.started",
    ]);
    expect(registered?.definition.events["review.started"]?.schema).toBe(REVIEW_STATUS_SCHEMA);
    expect(registered?.definition.events["review.finished"]?.schema).toBe(REVIEW_STATUS_SCHEMA);

    await registration.dispose();
  });

  test("the exported definition satisfies the portable registration contract", () => {
    type RegisterDefinition = Parameters<RpcDomain["register"]>[0];
    const accepts = (definition: RegisterDefinition): string => definition.id;
    expect(accepts(ReviewRpc)).toBe(REVIEW_RPC_ID);
    expect(ReviewRpc).toBe(REVIEW_RPC);
  });

  test("the status handler returns the lifecycle snapshot for known and unknown sessions", async () => {
    const fake = fakeRpc();
    const lifecycle = createReviewLifecycle({ clock: () => 5, idFactory: () => "run-1" });
    await registerReviewRpc(fake.rpc, lifecycle);

    lifecycle.begin("ses_1");
    lifecycle.begin("ses_2");
    const handler = fake.registrations[0]?.handlers.status;
    expect(await handler?.({ sessionID: "ses_1" })).toEqual(lifecycle.status("ses_1"));
    expect(await handler?.({ sessionID: "ses_2" })).toEqual(lifecycle.status("ses_2"));
    expect(await handler?.({ sessionID: "ses_2" })).not.toEqual(lifecycle.status("ses_1"));
    expect(await handler?.({ sessionID: "ses_unknown" })).toEqual({
      sessionID: "ses_unknown",
      epoch: lifecycle.status("ses_unknown").epoch,
      revision: 2,
      running: [],
    });
  });

  test("lifecycle events emit full snapshots through the registration", async () => {
    const fake = fakeRpc();
    const lifecycle = createReviewLifecycle({ clock: () => 7, idFactory: () => "run-1" });
    await registerReviewRpc(fake.rpc, lifecycle);

    const handle = lifecycle.begin("ses_1");
    const started = lifecycle.status("ses_1");
    lifecycle.finish(handle, "completed", "advice");
    const finished = lifecycle.status("ses_1");
    await tick();

    expect(fake.registrations[0]?.emitted).toEqual([
      ["review.started", started],
      ["review.finished", finished],
    ]);
    const declared = Object.keys(REVIEW_STATUS_SCHEMA.properties);
    for (const [, data] of fake.registrations[0]?.emitted ?? []) {
      for (const key of Object.keys(data as Record<string, unknown>)) {
        expect(declared).toContain(key);
      }
    }
  });

  test("the status schema strictly covers nested, optional, and enum fields", () => {
    const schema = REVIEW_STATUS_SCHEMA as SchemaNode;
    expectStrictSchema(schema, maximalStatus, "status");
    expectStrictSchema(schema, { sessionID: "s", epoch: "e", revision: 0, running: [] }, "status");

    expect(schema.required).toEqual(["sessionID", "epoch", "revision", "running"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.lastFinished?.additionalProperties).toBe(false);
    expect(schema.properties?.lastFinished?.properties?.outcome?.enum).toEqual([
      "completed",
      "failed",
      "timeout",
    ]);
    expect(schema.properties?.latest?.additionalProperties).toBe(false);
    expect(schema.properties?.running?.items?.additionalProperties).toBe(false);

    expect(() =>
      expectStrictSchema(schema, { ...maximalStatus, confidence: 0.9 }, "status"),
    ).toThrow();
    expect(() =>
      expectStrictSchema(
        schema,
        {
          ...maximalStatus,
          lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "unknown" },
        },
        "status",
      ),
    ).toThrow();
  });

  test("the status input schema declares only the sessionID request", () => {
    const input = REVIEW_RPC.methods.status.input as SchemaNode;
    expect(input.additionalProperties).toBe(false);
    expect(input.required).toEqual(["sessionID"]);
    expect(Object.keys(input.properties ?? {})).toEqual(["sessionID"]);
    expect(input.properties?.sessionID).toEqual({ type: "string" });

    expectStrictSchema(input, { sessionID: "ses_1" }, "input");
    expect(() => expectStrictSchema(input, { sessionID: "ses_1", extra: true }, "input")).toThrow();
    expect(() => expectStrictSchema(input, { extra: true }, "input")).toThrow();
    expect(() => expectStrictSchema(input, { sessionID: 7 }, "input")).toThrow();
  });

  test("dispose detaches emission, stays idempotent, and leaves lifecycle state intact", async () => {
    const fake = fakeRpc();
    const lifecycle = createReviewLifecycle({ clock: () => 5, idFactory: () => "run-1" });
    const registration = await registerReviewRpc(fake.rpc, lifecycle);

    await registration.dispose();
    await registration.dispose();
    expect(fake.registrations[0]?.disposed).toBe(1);

    const handle = lifecycle.begin("ses_1");
    lifecycle.finish(handle, "completed", "advice");
    await tick();
    expect(fake.registrations[0]?.emitted).toEqual([]);
    expect(lifecycle.status("ses_1").latest?.advice).toBe("advice");
  });

  test("the review rpc leaves the telemetry rpc surface untouched", () => {
    expect(REVIEW_RPC_ID).not.toBe(TELEMETRY_RPC_ID);
    expect(Object.keys(TelemetryRpc.methods).sort()).toEqual([
      "telemetry.event",
      "telemetry.query",
    ]);
    for (const method of Object.keys(TelemetryRpc.methods)) {
      expect(Object.keys(REVIEW_RPC.methods)).not.toContain(method);
    }
    expect(Object.keys(REVIEW_RPC.events)).not.toContain("telemetry.event");
  });

  test("the review modules stay self-contained for a clean frozen-lockfile checkout", async () => {
    const files = [...new Bun.Glob("review-*.ts").scanSync({ cwd: import.meta.dir })].sort();
    expect(files).toContain("review-contract.ts");
    expect(files).toContain("review-lifecycle.ts");
    expect(files).toContain("review-rpc.ts");
    for (const file of files) {
      const source = await Bun.file(join(import.meta.dir, file)).text();
      expect(source, `${file} must not read local reference copies`).not.toMatch(
        /["'`](?:\/tmp\/|\/home\/|~\/)/,
      );
      expect(source, `${file} must not use require`).not.toContain(REQUIRE_CALL);
      for (const specifier of importSpecifiers(source)) {
        expect(isSelfContained(specifier), `${file} imports undeclared ${specifier}`).toBe(true);
      }
    }
  });
});
