import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import type { Plugin } from "@opencode/plugin/tui";
import { createEscapeDetector, type TimerHandle } from "./escape-detector.js";

const keyboardHandlers: Array<(event: { readonly name: string }) => void> = [];
const cleanupHandlers: Array<() => void> = [];

mock.module("@opentui/solid", () => ({
  useKeyboard(handler: (event: { readonly name: string }) => void) {
    keyboardHandlers.push(handler);
  },
}));

mock.module("solid-js", () => ({
  createComponent: () => undefined,
  createContext: () => ({ Provider: undefined }),
  onCleanup(cleanup: () => void) {
    cleanupHandlers.push(cleanup);
  },
  useContext: () => undefined,
}));

const { default: plugin } = await import("./index.js");
type SlotClaim = Parameters<Plugin.Context["ui"]["slot"]>[0];

class FakeClock {
  now = 0;
  private nextTimer = 0;
  private timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  schedule = (callback: () => void, delay: number): TimerHandle => {
    const id = ++this.nextTimer;
    this.timers.set(id, { at: this.now + delay, callback });
    return id as TimerHandle;
  };

  cancel = (handle: TimerHandle) => {
    this.timers.delete(handle as number);
  };

  advance(milliseconds: number) {
    this.now += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }

  pending() {
    return this.timers.size;
  }
}

function makeDetector(clock: FakeClock) {
  let modal = false;
  let route:
    | { readonly type: "home" }
    | { readonly type: "plugin"; readonly id: string; readonly name: string }
    | { readonly type: "session"; readonly sessionID: string } = {
    type: "session",
    sessionID: "session-1",
  };
  let dispatches = 0;

  const detector = createEscapeDetector({
    now: () => clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    isModal: () => modal,
    currentRoute: () => route,
    dispatchTimeline: () => dispatches++,
  });

  return {
    detector,
    clock,
    setModal(value: boolean) {
      modal = value;
    },
    setRoute(value: typeof route) {
      route = value;
    },
    dispatches: () => dispatches,
  };
}

describe("@capybearista/opencode-double-tap-timeline", () => {
  beforeEach(() => {
    keyboardHandlers.length = 0;
    cleanupHandlers.length = 0;
  });

  test("exports a V2 Plugin.define TUI definition", () => {
    expect(plugin.id).toBe("capybearista.opencode-double-tap-timeline");
    expect(plugin.setup).toBeFunction();
    expect("tui" in plugin).toBe(false);
  });

  test("exposes only the V2 TUI package entrypoint", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

    expect(packageJson.main).toBeUndefined();
    expect(packageJson.types).toBeUndefined();
    expect(packageJson.files).toEqual(["dist", "tui.js"]);
    expect(packageJson.exports).toEqual({
      "./tui": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    });
  });

  test("built TUI module exports only the default plugin", async () => {
    const builtModule = await import("../dist/index.js");

    expect(Object.keys(builtModule)).toEqual(["default"]);
  });

  test("local root wrapper exports only the same default plugin", async () => {
    const wrappedModule = await import("../tui.js");

    expect(Object.keys(wrappedModule)).toEqual(["default"]);
    expect(wrappedModule.default.id).toBe(plugin.id);
    expect(keyboardHandlers).toHaveLength(0);
    expect(cleanupHandlers).toHaveLength(0);
  });

  test("runs the real Node Host.resolve regression in the package suite", () => {
    const packageRoot = path.resolve(import.meta.dir, "..");
    const child = Bun.spawnSync({
      cmd: ["node", "--test", "test/host-resolver.node.mjs"],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);

    if (child.exitCode !== 0) throw new Error(stderr || stdout);
    expect(child.exitCode).toBe(0);
  });

  test("registers the app slot and exposes its unregister cleanup", async () => {
    let claim: SlotClaim | undefined;
    let unregisterCalls = 0;
    const context = {
      ui: {
        slot(value: SlotClaim) {
          claim = value;
          return () => unregisterCalls++;
        },
      },
    };

    const cleanup = await plugin.setup(context as unknown as Plugin.Context);

    expect(claim?.append).toBe("app");
    expect(claim?.render).toBeFunction();
    expect(cleanup).toBeFunction();
    cleanup?.();
    expect(unregisterCalls).toBe(1);
  });

  test("setup cleanup disposes every rendered detector before unmount and is idempotent", async () => {
    let claim: SlotClaim | undefined;
    let unregisterCalls = 0;
    let dispatches = 0;
    const context = {
      ui: {
        slot(value: SlotClaim) {
          claim = value;
          return () => unregisterCalls++;
        },
        router: {
          current: () => ({ type: "session", sessionID: "session-1" }),
        },
      },
      keymap: {
        mode: { current: () => "base" },
        dispatch: () => dispatches++,
      },
    };

    const dispose = await plugin.setup(context as unknown as Plugin.Context);
    const render = claim?.render as (() => unknown) | undefined;
    render?.();
    render?.();

    expect(keyboardHandlers).toHaveLength(2);
    expect(cleanupHandlers).toHaveLength(2);
    keyboardHandlers[0]({ name: "escape" });
    dispose?.();
    dispose?.();
    cleanupHandlers.forEach((cleanup) => {
      cleanup();
    });
    keyboardHandlers.forEach((handler) => {
      handler({ name: "escape" });
      handler({ name: "escape" });
    });

    expect(unregisterCalls).toBe(1);
    expect(dispatches).toBe(0);
  });

  test("dispatches exactly once for two Escape presses inside the 800ms window", () => {
    const state = makeDetector(new FakeClock());

    state.detector.handle({ name: "escape" });
    state.clock.advance(799);
    state.detector.handle({ name: "escape" });

    expect(state.dispatches()).toBe(1);
    expect(state.clock.pending()).toBe(0);
  });

  test("keeps single, late, and non-Escape presses on native behavior", () => {
    const state = makeDetector(new FakeClock());

    state.detector.handle({ name: "enter" });
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(0);

    state.clock.advance(801);
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(0);

    state.detector.handle({ name: "escape" });
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(1);
  });

  test("resets detection while a modal dialog owns Escape", () => {
    const state = makeDetector(new FakeClock());
    state.setModal(true);

    state.detector.handle({ name: "escape" });
    state.setModal(false);
    state.detector.handle({ name: "escape" });

    expect(state.dispatches()).toBe(0);
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(1);
  });

  test("clears a pending gesture when a modal opens before the second Escape", () => {
    const state = makeDetector(new FakeClock());

    state.detector.handle({ name: "escape" });
    state.clock.advance(100);
    state.setModal(true);
    state.detector.handle({ name: "escape" });
    expect(state.clock.pending()).toBe(0);

    state.setModal(false);
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(0);
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(1);
  });

  test("checks the current route and requires a non-empty session ID", () => {
    const state = makeDetector(new FakeClock());

    state.setRoute({ type: "home" });
    state.detector.handle({ name: "escape" });
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(0);

    state.setRoute({ type: "session", sessionID: "" });
    state.detector.handle({ name: "escape" });
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(0);
  });

  test("does not use a stale route after a pending timer or route change", () => {
    const state = makeDetector(new FakeClock());

    state.detector.handle({ name: "escape" });
    state.setRoute({ type: "home" });
    state.clock.advance(801);
    state.setRoute({ type: "session", sessionID: "session-2" });
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(0);

    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(1);
  });

  test("rejects a pending session-A gesture after switching to session-B or home", () => {
    for (const route of [
      { type: "session", sessionID: "session-2" } as const,
      { type: "home" } as const,
    ]) {
      const state = makeDetector(new FakeClock());

      state.detector.handle({ name: "escape" });
      state.clock.advance(100);
      state.setRoute(route);
      state.detector.handle({ name: "escape" });

      expect(state.dispatches()).toBe(0);
    }
  });

  test("does not seed a gesture on a non-session route", () => {
    const state = makeDetector(new FakeClock());
    state.setRoute({ type: "home" });

    state.detector.handle({ name: "escape" });
    expect(state.clock.pending()).toBe(0);

    state.setRoute({ type: "session", sessionID: "session-1" });
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(0);
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(1);
  });

  test("treats an Escape at exactly 800ms as a new press when expiry runs first", () => {
    const state = makeDetector(new FakeClock());

    state.detector.handle({ name: "escape" });
    state.clock.advance(800);
    state.detector.handle({ name: "escape" });

    expect(state.dispatches()).toBe(0);
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(1);
  });

  test("dispatches at most once for a triple tap and arms the next pair", () => {
    const state = makeDetector(new FakeClock());

    state.detector.handle({ name: "escape" });
    state.clock.advance(100);
    state.detector.handle({ name: "escape" });
    state.detector.handle({ name: "escape" });

    expect(state.dispatches()).toBe(1);
    state.detector.handle({ name: "escape" });
    expect(state.dispatches()).toBe(2);
  });

  test("cancels timers and ignores events after idempotent disposal", () => {
    const state = makeDetector(new FakeClock());

    state.detector.handle({ name: "escape" });
    expect(state.clock.pending()).toBe(1);
    state.detector.dispose();
    state.detector.dispose();
    state.clock.advance(801);
    state.detector.handle({ name: "escape" });
    state.detector.handle({ name: "escape" });

    expect(state.clock.pending()).toBe(0);
    expect(state.dispatches()).toBe(0);
  });
});
