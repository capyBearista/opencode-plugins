import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin/tui";
import { createRoot } from "solid-js";
import type { ReviewStatus } from "./review-contract.js";
import { REVIEW_RPC } from "./review-contract.js";

mock.module("@opentui/solid", () => ({
  createElement: () => ({}),
  insert: () => undefined,
  spread: () => undefined,
}));

const tuiModule = await import("./tui.js");
const plugin = tuiModule.default;
const { TUI_PLUGIN_ID, createReviewTransport, resolveDirectory } = tuiModule;

type SlotClaim = Parameters<Plugin.Context["ui"]["slot"]>[0];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeStatus(sessionID: string, revision = 1): ReviewStatus {
  return { sessionID, epoch: "epoch-test", revision, running: [] };
}

interface FakeQuery {
  readonly directory: string;
  readonly input: { readonly sessionID: string };
  readonly resolve: (value: ReviewStatus) => void;
  readonly reject: (reason?: unknown) => void;
}

interface FakeClient {
  readonly queries: FakeQuery[];
  readonly eventHandlers: Map<string, Array<(envelope: unknown) => void>>;
  readonly unsubscribes: string[];
  readonly rpc: (def: unknown) => {
    status: (
      input: { sessionID: string },
      opts: { location: { directory: string }; signal: AbortSignal },
    ) => Promise<ReviewStatus>;
    events: { on: (name: string, handler: (envelope: unknown) => void) => () => void };
  };
}

function createFakeClient(): FakeClient {
  const eventHandlers = new Map<string, Array<(envelope: unknown) => void>>();
  const client: FakeClient = {
    queries: [],
    eventHandlers,
    unsubscribes: [],
    rpc: (_def) => ({
      status: (input, opts) => {
        let resolve!: (value: ReviewStatus) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<ReviewStatus>((innerResolve, innerReject) => {
          resolve = innerResolve;
          reject = innerReject;
        });
        client.queries.push({ directory: opts.location.directory, input, resolve, reject });
        return promise;
      },
      events: {
        on: (name, handler) => {
          const list = eventHandlers.get(name) ?? [];
          list.push(handler);
          eventHandlers.set(name, list);
          return () => {
            client.unsubscribes.push(name);
          };
        },
      },
    }),
  };
  return client;
}

function createFakeContext(
  client: FakeClient,
  _sessionID: string | undefined,
  directory: string | undefined = "/work/main",
  sessions?: Record<string, { directory: string }>,
) {
  const claims: Array<SlotClaim> = [];
  const unregisters: Array<string> = [];
  const connected: Array<() => void> = [];
  const context = {
    location: directory === undefined ? undefined : { directory },
    data: {
      session: {
        get: (sessionID: string) => {
          const known = sessions?.[sessionID];
          if (!known) return undefined;
          return { id: sessionID, location: { directory: known.directory } };
        },
      },
      location: { default: () => ({ directory: "/work/default" }) },
      on: (type: string, handler: () => void) => {
        if (type === "server.connected") connected.push(handler);
        return () => undefined;
      },
    },
    client,
    theme: { text: { muted: "#888888", base: "#ffffff" } },
    ui: {
      slot: (claim: SlotClaim) => {
        claims.push(claim);
        const label = "append" in claim ? claim.append : "unknown";
        return () => {
          unregisters.push(String(label));
        };
      },
    },
  };
  return { context: context as unknown as Plugin.Context, claims, unregisters, connected };
}

function claimFor(claims: Array<SlotClaim>, path: string): { render: (input: unknown) => unknown } {
  const claim = claims.find((entry) => "append" in entry && entry.append === path);
  if (!claim) throw new Error(`missing slot claim ${path}`);
  return claim as unknown as { render: (input: unknown) => unknown };
}

function emit(client: FakeClient, name: string, envelope: unknown): void {
  for (const handler of client.eventHandlers.get(name) ?? []) handler(envelope);
}

describe("auto-advisor tui slots and setup", () => {
  test("uses the distinct tui plugin id and only supported append slots", async () => {
    expect(TUI_PLUGIN_ID).toBe("capybearista.opencode-auto-advisor-tui");
    expect(plugin.id).toBe("capybearista.opencode-auto-advisor-tui");
    const client = createFakeClient();
    const { context, claims, unregisters } = createFakeContext(client, "ses_1");
    const cleanup = await plugin.setup(context);
    expect(claims).toHaveLength(2);
    expect((claims[0] as { append?: string }).append).toBe("prompt.footer.status");
    expect((claims[1] as { append?: string }).append).toBe("session.composer.top");
    expect(typeof cleanup).toBe("function");
    cleanup?.();
    cleanup?.();
    expect(unregisters).toEqual(["prompt.footer.status", "session.composer.top"]);
  });

  test("setup returns cleanup synchronously without blocking on unsupported servers", async () => {
    const client = createFakeClient();
    const { context } = createFakeContext(client, "ses_1");
    const result = plugin.setup(context);
    expect(result).not.toBeInstanceOf(Promise);
    const cleanup = await result;
    expect(typeof cleanup).toBe("function");
    cleanup?.();
  });

  test("footer render stays quiet without a session id and never queries", async () => {
    const client = createFakeClient();
    const { context, claims } = createFakeContext(client, undefined);
    const cleanup = await plugin.setup(context);
    const footer = claimFor(claims, "prompt.footer.status");
    await createRoot(async (dispose) => {
      try {
        footer.render({ sessionID: undefined, mode: "normal", showDetails: false });
        await flush();
        expect(client.queries).toHaveLength(0);
      } finally {
        dispose();
      }
    });
    cleanup?.();
  });

  test("composer render queries status for its session and cleans up subscriptions", async () => {
    const client = createFakeClient();
    const { context, claims, connected } = createFakeContext(client, "ses_1", "/work/main");
    const cleanup = await plugin.setup(context);
    const composer = claimFor(claims, "session.composer.top");
    await createRoot(async (dispose) => {
      try {
        composer.render({ sessionID: "ses_1" });
        await flush();
        expect(client.queries).toHaveLength(1);
        expect(client.queries[0]).toMatchObject({
          directory: "/work/main",
          input: { sessionID: "ses_1" },
        });
        expect(client.eventHandlers.get("review.started")).toHaveLength(1);
        expect(client.eventHandlers.get("review.finished")).toHaveLength(1);
        expect(connected).toHaveLength(1);
        client.queries[0]?.resolve(fakeStatus("ses_1"));
        await flush();
      } finally {
        dispose();
      }
    });
    expect(client.unsubscribes).toHaveLength(2);
    cleanup?.();
  });

  test("footer and composer share one store and one status query per session", async () => {
    const client = createFakeClient();
    const { context, claims, connected } = createFakeContext(client, "ses_1", "/work/main");
    const cleanup = await plugin.setup(context);
    const footer = claimFor(claims, "prompt.footer.status");
    const composer = claimFor(claims, "session.composer.top");
    const footerRoot = createRoot((dispose) => {
      footer.render({ sessionID: "ses_1" });
      return dispose;
    });
    const composerRoot = createRoot((dispose) => {
      composer.render({ sessionID: "ses_1" });
      return dispose;
    });
    await flush();
    expect(client.queries).toHaveLength(1);
    expect(client.eventHandlers.get("review.started")).toHaveLength(1);
    expect(client.eventHandlers.get("review.finished")).toHaveLength(1);
    expect(connected).toHaveLength(1);
    client.queries[0]?.resolve(fakeStatus("ses_1"));
    await flush();
    emit(client, "review.finished", {
      location: { directory: "/work/main" },
      data: fakeStatus("ses_1", 2),
    });
    expect(client.queries).toHaveLength(2);
    composerRoot();
    await flush();
    emit(client, "review.started", {
      location: { directory: "/work/main" },
      data: fakeStatus("ses_1", 3),
    });
    expect(client.queries).toHaveLength(3);
    footerRoot();
    await flush();
    emit(client, "review.started", {
      location: { directory: "/work/main" },
      data: fakeStatus("ses_1", 4),
    });
    expect(client.queries).toHaveLength(3);
    cleanup?.();
  });

  test("composer ignores events from other locations and sessions", async () => {
    const client = createFakeClient();
    const { context, claims } = createFakeContext(client, "ses_1", "/work/main");
    const cleanup = await plugin.setup(context);
    const composer = claimFor(claims, "session.composer.top");
    await createRoot(async (dispose) => {
      try {
        composer.render({ sessionID: "ses_1" });
        await flush();
        expect(client.queries).toHaveLength(1);
        emit(client, "review.started", {
          location: { directory: "/work/other" },
          data: fakeStatus("ses_1", 5),
        });
        emit(client, "review.started", {
          location: { directory: "/work/main" },
          data: fakeStatus("ses_other", 6),
        });
        await flush();
        expect(client.queries).toHaveLength(1);
      } finally {
        dispose();
      }
    });
    cleanup?.();
  });

  test("unsupported rpc stays quiet instead of throwing", async () => {
    const client = createFakeClient();
    const broken = {
      ...client,
      rpc: () => {
        throw new Error("rpc.unavailable");
      },
    };
    const { context, claims } = createFakeContext(broken as unknown as FakeClient, "ses_1");
    const cleanup = await plugin.setup(context);
    const composer = claimFor(claims, "session.composer.top");
    await createRoot(async (dispose) => {
      try {
        expect(() => composer.render({ sessionID: "ses_1" })).not.toThrow();
        await flush();
      } finally {
        dispose();
      }
    });
    cleanup?.();
  });
});

describe("auto-advisor tui transport and contract seams", () => {
  test("resolves the current location directory for rpc calls", () => {
    const context = {
      location: { directory: "/work/explicit" },
      data: { location: { default: () => ({ directory: "/work/default" }) } },
    } as unknown as Plugin.Context;
    expect(resolveDirectory(context)).toBe("/work/explicit");
    const fallback = {
      location: undefined,
      data: { location: { default: () => ({ directory: "/work/default" }) } },
    } as unknown as Plugin.Context;
    expect(resolveDirectory(fallback)).toBe("/work/default");
  });

  test("shares the pure zero-import review descriptor", () => {
    expect(REVIEW_RPC.id).toBe("experimental.auto-advisor.review");
    expect(Object.keys(REVIEW_RPC.methods)).toEqual(["status"]);
  });

  test("transport forwards the session query with location isolation", async () => {
    const client = createFakeClient();
    const transport = createReviewTransport(
      client as unknown as Plugin.Context["client"],
      "ses_1",
      "/work/main",
    );
    const pending = transport.query(
      { sessionID: "ses_1" },
      { signal: new AbortController().signal },
    );
    expect(client.queries[0]).toMatchObject({
      directory: "/work/main",
      input: { sessionID: "ses_1" },
    });
    client.queries[0]?.resolve(fakeStatus("ses_1", 2));
    await expect(pending).resolves.toMatchObject({ sessionID: "ses_1", revision: 2 });
  });

  test("tui imports the shared store and contract but never the server entry", async () => {
    const source = await Bun.file(join(import.meta.dir, "tui.ts")).text();
    expect(source).toContain("./review-contract.js");
    expect(source).toContain("./tui-controller.js");
    expect(source).toContain("createReviewStoreRegistry");
    expect(source).not.toContain("createReviewController");
    expect(source).not.toContain("./index.js");
    expect(source).not.toContain("./review-rpc.js");
    expect(source).not.toContain("Spinner");
    expect(source).toContain("REVIEWING_LABEL");
    expect(source).toContain("FINISHED_LABEL");
  });

  test("protected core never imports tui, opentui, or solid", async () => {
    const protectedFiles = [
      "index.ts",
      "routing-observer.ts",
      "review-lifecycle.ts",
      "review-rpc.ts",
    ];
    for (const file of protectedFiles) {
      const source = await Bun.file(join(import.meta.dir, file)).text();
      expect(source).not.toContain("./tui");
      expect(source).not.toContain("tui-controller");
      expect(source).not.toContain("@opentui");
      expect(source).not.toContain("solid-js");
    }
    const contract = await Bun.file(join(import.meta.dir, "review-contract.ts")).text();
    expect(contract.match(/^import[\s\S]*?;$/gm) ?? []).toEqual([]);
  });

  test("package keeps version and exact sdk pins while publishing the tui entry", async () => {
    const packageJson = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(packageJson.version).toBe("2.0.0");
    expect(packageJson.peerDependencies["@opencode/ai"]).toBe("2.0.21");
    expect(packageJson.peerDependencies["@opencode/plugin"]).toBe("2.0.21");
    expect(packageJson.devDependencies["@opencode/ai"]).toBe("2.0.21");
    expect(packageJson.devDependencies["@opencode/plugin"]).toBe("2.0.21");
    expect(packageJson.peerDependencies["@opentui/core"]).toBe(">=0.5.14");
    expect(packageJson.peerDependencies["@opentui/solid"]).toBe(">=0.5.14");
    expect(packageJson.exports["./tui"]).toEqual({
      types: "./dist/tui.d.ts",
      default: "./dist/tui.js",
    });
  });
});

const clientSolid = await import("solid-js/dist/solid.js");
const { createBindingScope, readBindingKey, sameBindingKey } = tuiModule;

function flushClientReactivity(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("binding scope session and location identity", () => {
  test("F3a same session directory change rebinds with the new location", async () => {
    const { createEffect, createRoot, createSignal } = clientSolid;
    const binds: Array<string> = [];
    const disposes: Array<string> = [];
    const [getSid, setSid] = createSignal<string | undefined>("ses_1");
    const [getDir, setDir] = createSignal("/work/A");
    const scope = createBindingScope({
      getSessionID: () => getSid(),
      getDirectory: () => getDir(),
      clear: () => undefined,
      bind: (key) => {
        binds.push(`${key.sessionID}|${key.directory}`);
        const label = `${key.sessionID}|${key.directory}`;
        return {
          dispose: () => {
            disposes.push(label);
          },
        };
      },
    });
    const disposeRoot = createRoot((dispose: () => void) => {
      scope.sync();
      createEffect(() => {
        scope.sync();
      });
      return dispose;
    });
    try {
      await flushClientReactivity();
      expect(binds).toEqual(["ses_1|/work/A"]);
      expect(scope.key()).toEqual({ sessionID: "ses_1", directory: "/work/A" });
      setSid("ses_1");
      setDir("/work/B");
      await flushClientReactivity();
      expect(binds).toEqual(["ses_1|/work/A", "ses_1|/work/B"]);
      expect(disposes).toEqual(["ses_1|/work/A"]);
      expect(scope.key()).toEqual({ sessionID: "ses_1", directory: "/work/B" });
    } finally {
      disposeRoot();
      scope.dispose();
    }
  });

  test("F3b session switch clears displayed state before the new binding query", async () => {
    const { createEffect, createRoot, createSignal } = clientSolid;
    const order: Array<string> = [];
    let display: string | undefined = "stale-A-advice";
    const [getSid, setSid] = createSignal<string | undefined>("ses_A");
    const [getDir] = createSignal("/work/main");
    const scope = createBindingScope({
      getSessionID: () => getSid(),
      getDirectory: () => getDir(),
      clear: () => {
        order.push("clear");
        display = undefined;
      },
      bind: (key) => {
        order.push(`bind:${key.sessionID}`);
        return {
          dispose: () => {
            order.push(`dispose:${key.sessionID}`);
          },
        };
      },
    });
    const disposeRoot = createRoot((dispose: () => void) => {
      scope.sync();
      createEffect(() => {
        scope.sync();
      });
      return dispose;
    });
    try {
      await flushClientReactivity();
      display = "stale-A-advice";
      order.length = 0;
      setSid("ses_B");
      await flushClientReactivity();
      const clearIndex = order.indexOf("clear");
      const bindIndex = order.indexOf("bind:ses_B");
      expect(clearIndex).toBeGreaterThanOrEqual(0);
      expect(bindIndex).toBeGreaterThanOrEqual(0);
      expect(clearIndex).toBeLessThan(bindIndex);
      expect(display).toBeUndefined();
    } finally {
      disposeRoot();
      scope.dispose();
    }
  });

  test("F3c same-id directory change clears stale advice while the new query is pending", async () => {
    const { createEffect, createRoot, createSignal } = clientSolid;
    let display: string | undefined;
    const [getSid] = createSignal<string | undefined>("ses_1");
    const [getDir, setDir] = createSignal("/work/A");
    const scope = createBindingScope({
      getSessionID: () => getSid(),
      getDirectory: () => getDir(),
      clear: () => {
        display = undefined;
      },
      bind: () => ({
        dispose: () => undefined,
      }),
    });
    const disposeRoot = createRoot((dispose: () => void) => {
      scope.sync();
      createEffect(() => {
        scope.sync();
      });
      return dispose;
    });
    try {
      await flushClientReactivity();
      display = "A-advice";
      setDir("/work/B");
      await flushClientReactivity();
      expect(scope.key()).toEqual({ sessionID: "ses_1", directory: "/work/B" });
      expect(display).toBeUndefined();
    } finally {
      disposeRoot();
      scope.dispose();
    }
  });

  test("binding scope stays quiet without a session id", async () => {
    const { createEffect, createRoot, createSignal } = clientSolid;
    const binds: Array<string> = [];
    const [getSid] = createSignal<string | undefined>(undefined);
    const [getDir] = createSignal("/work/main");
    const scope = createBindingScope({
      getSessionID: () => getSid(),
      getDirectory: () => getDir(),
      clear: () => undefined,
      bind: (key) => {
        binds.push(key.sessionID);
        return { dispose: () => undefined };
      },
    });
    const disposeRoot = createRoot((dispose: () => void) => {
      scope.sync();
      createEffect(() => {
        scope.sync();
      });
      return dispose;
    });
    try {
      await flushClientReactivity();
      expect(binds).toEqual([]);
      expect(scope.key()).toBeUndefined();
    } finally {
      disposeRoot();
      scope.dispose();
    }
  });

  test("binding keys compare both session and directory", () => {
    expect(readBindingKey("ses_1", "/work/A")).toEqual({
      sessionID: "ses_1",
      directory: "/work/A",
    });
    expect(readBindingKey(undefined, "/work/A")).toBeUndefined();
    expect(readBindingKey("ses_1", "")).toBeUndefined();
    expect(sameBindingKey(undefined, undefined)).toBe(true);
    expect(sameBindingKey({ sessionID: "s", directory: "d" }, undefined)).toBe(false);
    expect(
      sameBindingKey({ sessionID: "s", directory: "a" }, { sessionID: "s", directory: "b" }),
    ).toBe(false);
    expect(
      sameBindingKey({ sessionID: "s", directory: "a" }, { sessionID: "s", directory: "a" }),
    ).toBe(true);
  });
});

describe("session-scoped location resolution", () => {
  test("G3a known session ref wins over global location and default", () => {
    const synced = {
      location: undefined,
      data: {
        session: {
          get: (sessionID: string) =>
            sessionID === "ses_1"
              ? { id: sessionID, location: { directory: "/work/B" } }
              : undefined,
        },
        location: { default: () => ({ directory: "/work/A" }) },
      },
    } as unknown as Plugin.Context;
    expect(resolveDirectory(synced, "ses_1")).toBe("/work/B");
    const moved = {
      location: { directory: "/work/stale" },
      data: {
        session: {
          get: (sessionID: string) =>
            sessionID === "ses_1"
              ? { id: sessionID, location: { directory: "/work/C" } }
              : undefined,
        },
        location: { default: () => ({ directory: "/work/A" }) },
      },
    } as unknown as Plugin.Context;
    expect(resolveDirectory(moved, "ses_1")).toBe("/work/C");
    const unknownSession = {
      location: { directory: "/work/global" },
      data: {
        session: { get: (_sessionID: string) => undefined },
        location: { default: () => ({ directory: "/work/A" }) },
      },
    } as unknown as Plugin.Context;
    expect(resolveDirectory(unknownSession, "ses_missing")).toBe("/work/global");
    const absent = {
      location: undefined,
      data: {
        session: { get: (_sessionID: string) => undefined },
        location: { default: () => ({ directory: "/work/A" }) },
      },
    } as unknown as Plugin.Context;
    expect(resolveDirectory(absent, "ses_missing")).toBe("/work/A");
    expect(resolveDirectory(absent, undefined)).toBe("/work/A");
  });

  test("G3b composer scopes its status query to the known session directory", async () => {
    const client = createFakeClient();
    const { context, claims } = createFakeContext(client, "ses_1", undefined, {
      ses_1: { directory: "/work/B" },
    });
    const cleanup = await plugin.setup(context);
    const composer = claimFor(claims, "session.composer.top");
    await createRoot(async (dispose) => {
      try {
        composer.render({ sessionID: "ses_1" });
        await flush();
        expect(client.queries).toHaveLength(1);
        expect(client.queries[0]).toMatchObject({
          directory: "/work/B",
          input: { sessionID: "ses_1" },
        });
      } finally {
        dispose();
      }
    });
    cleanup?.();
  });

  test("G3c session move rebinds through the reactive session ref", async () => {
    const { createEffect, createRoot, createSignal } = clientSolid;
    const { resolveDirectory: resolveDir } = tuiModule;
    const [getSessionDir, setSessionDir] = createSignal("/work/B");
    const binds: Array<string> = [];
    const disposes: Array<string> = [];
    const order: Array<string> = [];
    const context = {
      location: undefined,
      data: {
        session: {
          get: (sessionID: string) =>
            sessionID === "ses_1"
              ? { id: sessionID, location: { directory: getSessionDir() } }
              : undefined,
        },
        location: { default: () => ({ directory: "/work/A" }) },
      },
    } as unknown as Plugin.Context;
    const scope = createBindingScope({
      getSessionID: () => "ses_1",
      getDirectory: () => resolveDir(context, "ses_1"),
      clear: () => {
        order.push("clear");
      },
      bind: (key) => {
        binds.push(`${key.sessionID}|${key.directory}`);
        order.push(`bind:${key.directory}`);
        const label = key.directory;
        return {
          dispose: () => {
            disposes.push(label);
            order.push(`dispose:${label}`);
          },
        };
      },
    });
    const disposeRoot = createRoot((dispose: () => void) => {
      scope.sync();
      createEffect(() => {
        scope.sync();
      });
      return dispose;
    });
    try {
      await flushClientReactivity();
      expect(binds).toEqual(["ses_1|/work/B"]);
      expect(scope.key()).toEqual({ sessionID: "ses_1", directory: "/work/B" });
      order.length = 0;
      setSessionDir("/work/C");
      await flushClientReactivity();
      expect(binds).toEqual(["ses_1|/work/B", "ses_1|/work/C"]);
      expect(disposes).toEqual(["/work/B"]);
      expect(scope.key()).toEqual({ sessionID: "ses_1", directory: "/work/C" });
      expect(order).toEqual(["dispose:/work/B", "clear", "bind:/work/C"]);
    } finally {
      disposeRoot();
      scope.dispose();
    }
  });
});
