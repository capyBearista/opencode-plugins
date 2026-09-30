import { describe, expect, test } from "bun:test";
import type { RpcDomain } from "@opencode/plugin/promise/rpc";
import { registerTelemetryRpc, TELEMETRY_RPC_ID, TelemetryRpc } from "./telemetry-rpc.js";
import type { TelemetryEvent, TelemetryQuery, TelemetryStore } from "./telemetry-types.js";

const stored: TelemetryEvent = {
  seq: 7,
  time: 123,
  sessionID: "ses_1",
  turnKey: "msg-1",
  mode: "observe",
  decision: "accept",
  fingerprint: "a".repeat(64),
};

function fakeStore() {
  const queries: Array<TelemetryQuery | undefined> = [];
  const reads: number[] = [];
  const store: TelemetryStore = {
    record: async () => undefined,
    query: async (input) => {
      queries.push(input);
      return { events: [stored], next: "evt:cursor" };
    },
    event: async (seq) => {
      reads.push(seq);
      return seq === stored.seq ? stored : undefined;
    },
  };
  return { store, queries, reads };
}

type Handler = (input: unknown) => Promise<unknown>;

function fakeRpc() {
  let registered: { definition: unknown; handlers: Record<string, Handler> } | undefined;
  let disposed = 0;
  const rpc = {
    register: async (definition: unknown, handlers: Record<string, Handler>) => {
      registered = { definition, handlers };
      return {
        dispose: async () => {
          disposed += 1;
        },
        events: { emit: async () => undefined },
      };
    },
  } as unknown as RpcDomain;
  return {
    rpc,
    registered: () => registered,
    disposed: () => disposed,
  };
}

describe("telemetry rpc", () => {
  test("exposes exactly the two read-only telemetry handlers", () => {
    expect(TELEMETRY_RPC_ID).toBe("experimental.auto-advisor");
    expect(Object.keys(TelemetryRpc.methods).sort()).toEqual([
      "telemetry.event",
      "telemetry.query",
    ]);
    expect(Object.keys(TelemetryRpc.events)).toEqual([]);
    for (const name of Object.keys(TelemetryRpc.methods)) {
      expect(name).not.toMatch(/record|set|remove|clear|write|delete/i);
    }
  });

  test("query handler reads the bounded store and returns the page", async () => {
    const fake = fakeStore();
    const rpc = fakeRpc();
    await registerTelemetryRpc(rpc.rpc, fake.store);

    const handlers = rpc.registered()?.handlers;
    const page = await handlers?.["telemetry.query"]?.({ after: "evt:0", limit: 5 });

    expect(fake.queries).toEqual([{ after: "evt:0", limit: 5 }]);
    expect(page).toEqual({ events: [stored], next: "evt:cursor" });
  });

  test("event handler returns one event or null", async () => {
    const fake = fakeStore();
    const rpc = fakeRpc();
    await registerTelemetryRpc(rpc.rpc, fake.store);

    const handler = rpc.registered()?.handlers?.["telemetry.event"];
    expect(await handler?.({ seq: 7 })).toEqual(stored);
    expect(await handler?.({ seq: 8 })).toBeNull();
    expect(fake.reads).toEqual([7, 8]);
  });

  test("registration disposes once", async () => {
    const fake = fakeStore();
    const rpc = fakeRpc();
    const registration = await registerTelemetryRpc(rpc.rpc, fake.store);

    await registration.dispose();
    expect(rpc.disposed()).toBe(1);
  });
});
