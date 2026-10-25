import "@opentui/solid/preload";
import { describe, expect, mock, test } from "bun:test";
import { type JSX, testRender } from "@opentui/solid";
import type { StateOutput } from "./rpc.js";
import tuiPlugin from "./tui.js";

type Command = {
  id: string;
  title: string;
  palette?: boolean;
  slash?: { name: string; arguments?: boolean };
  run: (input?: string) => unknown;
};
type Layer = { mode: string; commands: Command[] };
type Action = { bind: string; title: string; onTrigger: (value: string) => unknown };
type SelectOptions = {
  title: string;
  current?: string;
  options: Array<{ title: string; value: string; description?: string; footer?: string }>;
  actions?: Action[];
};
type Route = { type: "home" } | { type: "session"; sessionID: string };
type SlotClaim = { append?: string; render: (input: { sessionID: string }) => unknown };

const STYLES: StateOutput["styles"] = [
  { id: "concise", name: "Concise", description: "Short answers", source: "built-in" },
  { id: "pirate", name: "Pirate", description: "Arr", source: "project" },
];

const baseState: StateOutput = {
  styles: STYLES,
  defaultStyle: null,
  sessionStyle: null,
  sidebar: true,
  subagent: false,
};

function createHarness(
  options: {
    state?: Partial<StateOutput>;
    stateError?: Error;
    route?: Route;
    sessions?: Record<
      string,
      { metadata?: Record<string, unknown>; parentID?: string; location?: { directory: string } }
    >;
    picked?: string;
    hold?: boolean;
    location?: { directory: string };
  } = {},
) {
  const state = { ...baseState, ...options.state };
  let route: Route = options.route ?? { type: "session", sessionID: "s-1" };
  const layers: Array<() => Layer> = [];
  const slots: SlotClaim[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const selects: SelectOptions[] = [];
  const settle: Array<(value: string | undefined) => void> = [];
  const unsubscribe = mock(() => {});
  const unregisterSlot = mock(() => {});

  const resolve = (style: string) => {
    if (style.toLowerCase() === "default") return "default";
    const found = STYLES.find((s) => s.id === style.toLowerCase());
    if (!found) throw { type: "unknown_style", message: `unknown ${style}`, data: { style } };
    return found.id;
  };
  let defaultStyle = state.defaultStyle;
  const rpc = {
    state: mock(async (_input: unknown, _options?: unknown) => {
      if (options.stateError) throw options.stateError;
      return { ...state, defaultStyle };
    }),
    setSessionStyle: mock(
      async (input: { sessionID: string; style: string }, _options?: unknown) => ({
        style: resolve(input.style),
      }),
    ),
    clearSessionStyle: mock(async (input: { sessionID: string }, _options?: unknown) => ({
      sessionID: input.sessionID,
    })),
    setDefaultStyle: mock(async (input: { style: string }, _options?: unknown) => {
      const style = resolve(input.style);
      defaultStyle = style === "default" ? null : style;
      return { style };
    }),
  };
  const toast = mock((_toast: { message: string; variant?: string }) => {});
  const dispatch = mock((_id: string) => {});
  const clear = mock(() => {});
  const context = {
    client: { rpc: () => rpc },
    keymap: { layer: (factory: () => Layer) => layers.push(factory), dispatch },
    ui: {
      router: { current: () => route },
      dialog: {
        select: async (select: SelectOptions) => {
          selects.push(select);
          if (options.hold) return new Promise<string | undefined>((done) => settle.push(done));
          return options.picked;
        },
        clear,
      },
      toast: { show: toast },
      slot: (claim: SlotClaim) => {
        slots.push(claim);
        return unregisterSlot;
      },
    },
    data: {
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, handler);
        return unsubscribe;
      },
      session: { get: (id: string) => options.sessions?.[id] },
      location: { default: () => ({ directory: "/default-project" }) },
    },
    location: options.location,
    theme: { text: { base: "white" } },
  };

  return {
    rpc,
    toast,
    dispatch,
    clear,
    selects,
    settle,
    slots,
    unsubscribe,
    unregisterSlot,
    setRoute: (next: Route) => {
      route = next;
    },
    emitMetadata: (sessionID: string, metadata: Record<string, unknown>) =>
      handlers.get("session.metadata.updated")?.({ data: { sessionID, metadata } }),
    layerCount: () => layers.length,
    layerMode: () => layers[0]?.().mode,
    command: () => {
      const command = layers[0]?.().commands[0];
      if (!command) throw new Error("no command registered");
      return command;
    },
    start: async () => {
      const cleanup = await (
        tuiPlugin.setup as unknown as (input: unknown) => Promise<(() => void) | undefined>
      )(context);
      await Bun.sleep(0);
      return cleanup;
    },
  };
}

async function mountSidebar(harness: ReturnType<typeof createHarness>, sessionID = "s-1") {
  const claim = harness.slots.find((slot) => slot.append === "sidebar.content");
  const setup = await testRender(() => claim?.render({ sessionID }) as JSX.Element, {
    width: 40,
    height: 5,
  });
  const frame = async () => {
    await Bun.sleep(5);
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  return { setup, frame };
}

describe("registration", () => {
  test("has the TUI plugin id", () => {
    expect(tuiPlugin.id).toBe("capybearista.opencode-output-styles.tui");
  });

  test("registers one global command layer and one sidebar slot", async () => {
    const h = createHarness();
    await h.start();

    expect(h.layerCount()).toBe(1);
    expect(h.layerMode()).toBe("global");
    const command = h.command();
    expect(command.id).toBe("output-styles.pick");
    expect(command.title).toBe("Output style");
    expect(command.palette).toBe(true);
    expect(command.slash).toEqual({ name: "output-style", arguments: true });
    expect(h.slots.map((slot) => slot.append)).toEqual(["sidebar.content"]);
  });

  test("cleanup unsubscribes the event handler and the slot", async () => {
    const h = createHarness();
    const cleanup = await h.start();
    cleanup?.();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.unregisterSlot).toHaveBeenCalledTimes(1);
  });
});

describe("project routing", () => {
  test("every RPC call carries this TUI's location", async () => {
    const h = createHarness({ location: { directory: "/work/project-b" } });
    await h.start();
    await h.command().run("concise");
    await h.command().run("follow");
    h.setRoute({ type: "home" });
    await h.command().run("concise");
    await h.command().run();

    const location = { location: { directory: "/work/project-b" } };
    for (const method of [
      h.rpc.state,
      h.rpc.setSessionStyle,
      h.rpc.clearSessionStyle,
      h.rpc.setDefaultStyle,
    ]) {
      expect(method.mock.calls.length).toBeGreaterThan(0);
      for (const call of method.mock.calls) expect(call[1]).toEqual(location);
    }
  });

  test("session calls use the session's own location over the TUI's", async () => {
    const h = createHarness({
      location: { directory: "/work/project-b" },
      sessions: { "s-1": { location: { directory: "/work/project-a" } } },
    });
    await h.start();
    await h.command().run("concise");
    await h.command().run("follow");
    await h.command().run();
    const sessionLocation = { location: { directory: "/work/project-a" } };
    expect(h.rpc.setSessionStyle.mock.calls[0]?.[1]).toEqual(sessionLocation);
    expect(h.rpc.clearSessionStyle.mock.calls[0]?.[1]).toEqual(sessionLocation);
    expect(h.rpc.state.mock.calls.at(-1)?.[1]).toEqual(sessionLocation);
    // The setup call has no session, so it uses the TUI's location.
    expect(h.rpc.state.mock.calls[0]?.[1]).toEqual({ location: { directory: "/work/project-b" } });
  });

  test("falls back to the default location when the TUI has none", async () => {
    const h = createHarness();
    await h.start();
    expect(h.rpc.state.mock.calls[0]?.[1]).toEqual({
      location: { directory: "/default-project" },
    });
  });
});

describe("slash command with an argument", () => {
  test("sets the session style and toasts the style name", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run("  Pirate ");

    expect(h.rpc.setSessionStyle).toHaveBeenCalledWith(
      { sessionID: "s-1", style: "Pirate" },
      expect.anything(),
    );
    expect(h.rpc.setDefaultStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({ message: "Output style: Pirate", variant: "success" });
  });

  test("on the home route sets the default for new sessions", async () => {
    const h = createHarness({ route: { type: "home" } });
    await h.start();
    await h.command().run("concise");

    expect(h.rpc.setDefaultStyle).toHaveBeenCalledWith({ style: "concise" }, expect.anything());
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Output style: Concise (default)",
      variant: "success",
    });
  });

  test("names the built-in default style 'Default'", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run("default");
    expect(h.toast).toHaveBeenCalledWith({ message: "Output style: Default", variant: "success" });
  });

  test("an unknown style raises a warning toast", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run("nope");
    expect(h.toast).toHaveBeenCalledWith({
      message: 'Unknown output style "nope"',
      variant: "warning",
    });
  });

  test("other errors raise an error toast with the message", async () => {
    const h = createHarness();
    await h.start();
    h.rpc.setSessionStyle.mockRejectedValueOnce(new Error("boom"));
    await h.command().run("pirate");
    expect(h.toast).toHaveBeenCalledWith({ message: "boom", variant: "error" });
  });
});

describe("follow and subagent sessions", () => {
  test("/output-style follow clears the session style, case-insensitively", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run(" Follow ");
    expect(h.rpc.clearSessionStyle).toHaveBeenCalledWith({ sessionID: "s-1" }, expect.anything());
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Output style: follows global default (Default)",
      variant: "success",
    });
  });

  test("/output-style follow on home warns without calling the server", async () => {
    const h = createHarness({ route: { type: "home" } });
    await h.start();
    await h.command().run("follow");
    expect(h.rpc.clearSessionStyle).not.toHaveBeenCalled();
    expect(h.rpc.setDefaultStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Open a session to follow the global default",
      variant: "warning",
    });
  });

  test("the picker refuses a subagent session the TUI cache doesn't know", async () => {
    const h = createHarness({ state: { subagent: true } });
    await h.start();
    await h.command().run();
    expect(h.selects).toHaveLength(0);
    expect(h.toast).toHaveBeenCalledWith({
      message: "Subagent sessions don't use output styles",
      variant: "warning",
    });
  });

  test("a subagent session warns without any RPC or picker", async () => {
    const h = createHarness({ sessions: { "s-1": { parentID: "root" } } });
    await h.start();
    const stateCalls = h.rpc.state.mock.calls.length;
    await h.command().run("concise");
    await h.command().run();
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.rpc.state.mock.calls).toHaveLength(stateCalls);
    expect(h.selects).toHaveLength(0);
    expect(h.toast).toHaveBeenCalledWith({
      message: "Subagent sessions don't use output styles",
      variant: "warning",
    });
  });

  test("a subagent_session RPC error raises the same warning", async () => {
    const h = createHarness();
    await h.start();
    h.rpc.setSessionStyle.mockRejectedValueOnce({ type: "subagent_session", message: "x" });
    await h.command().run("pirate");
    h.rpc.clearSessionStyle.mockRejectedValueOnce({ type: "subagent_session", message: "x" });
    await h.command().run("follow");
    const warnings = h.toast.mock.calls.filter(
      ([t]) => t.message === "Subagent sessions don't use output styles",
    );
    expect(warnings).toHaveLength(2);
  });
});

describe("picker", () => {
  test("lists Default first, then styles, marking the global default", async () => {
    const h = createHarness({ state: { defaultStyle: "concise", sessionStyle: "pirate" } });
    await h.start();
    await h.command().run();

    expect(h.rpc.state).toHaveBeenLastCalledWith({ sessionID: "s-1" }, expect.anything());
    const select = h.selects[0];
    expect(select?.title).toBe("Output style");
    expect(select?.current).toBe("pirate");
    expect(select?.options).toEqual([
      { title: "Default", value: "default", description: "No output style" },
      { title: "Follow global default", value: "/follow", description: "Uses Concise" },
      {
        title: "Concise",
        value: "concise",
        description: "Short answers",
        footer: "built-in (default)",
      },
      { title: "Pirate", value: "pirate", description: "Arr", footer: "project" },
    ]);
  });

  test("current is Follow when the session has no stored style", async () => {
    const h = createHarness({ state: { defaultStyle: "concise" } });
    await h.start();
    await h.command().run();
    expect(h.selects[0]?.current).toBe("/follow");
  });

  test("Follow describes a missing global default", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run();
    expect(h.selects[0]?.options[1]).toEqual({
      title: "Follow global default",
      value: "/follow",
      description: "No global default set",
    });
  });

  test("on home current falls back to the global default, then 'default', with no Follow", async () => {
    const withDefault = createHarness({
      route: { type: "home" },
      state: { defaultStyle: "concise" },
    });
    await withDefault.start();
    await withDefault.command().run();
    expect(withDefault.selects[0]?.current).toBe("concise");
    expect(withDefault.selects[0]?.options.map((o) => o.value)).toEqual([
      "default",
      "concise",
      "pirate",
    ]);

    const plain = createHarness({ route: { type: "home" } });
    await plain.start();
    await plain.command().run();
    expect(plain.selects[0]?.current).toBe("default");
  });

  test("picking Follow clears the session style and the sidebar shows the global default", async () => {
    const h = createHarness({
      picked: "/follow",
      state: { defaultStyle: "concise", sessionStyle: "pirate" },
      sessions: { "s-1": { metadata: { outputStyle: "pirate" } } },
    });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Style: Pirate");

    await h.command().run();
    expect(h.rpc.clearSessionStyle).toHaveBeenCalledWith({ sessionID: "s-1" }, expect.anything());
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Output style: follows global default (Concise)",
      variant: "success",
    });
    expect(await frame()).toContain("Style: Concise");
    setup.renderer.destroy();
  });

  test("a subagent_session error from the picker raises the subagent warning", async () => {
    const h = createHarness({ picked: "pirate" });
    await h.start();
    h.rpc.setSessionStyle.mockRejectedValueOnce({ type: "subagent_session", message: "x" });
    await h.command().run();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Subagent sessions don't use output styles",
      variant: "warning",
    });
  });

  test("on home it fetches state without a session and ignores the session style", async () => {
    const h = createHarness({
      route: { type: "home" },
      state: { defaultStyle: "pirate", sessionStyle: "concise" },
    });
    await h.start();
    await h.command().run();

    expect(h.rpc.state).toHaveBeenLastCalledWith({}, expect.anything());
    expect(h.selects[0]?.current).toBe("pirate");
  });

  test("applies the picked style to the session", async () => {
    const h = createHarness({ picked: "pirate" });
    await h.start();
    await h.command().run();
    expect(h.rpc.setSessionStyle).toHaveBeenCalledWith(
      { sessionID: "s-1", style: "pirate" },
      expect.anything(),
    );
  });

  test("applies the picked style as default on the home route", async () => {
    const h = createHarness({ picked: "default", route: { type: "home" } });
    await h.start();
    await h.command().run();
    expect(h.rpc.setDefaultStyle).toHaveBeenCalledWith({ style: "default" }, expect.anything());
  });

  test("does nothing when the picker is dismissed", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run();
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.rpc.setDefaultStyle).not.toHaveBeenCalled();
  });

  test("ctrl+d sets the highlighted style as the default", async () => {
    const h = createHarness({ hold: true });
    await h.start();
    void h.command().run();
    await Bun.sleep(0);

    const action = h.selects[0]?.actions?.[0];
    expect(action?.bind).toBe("ctrl+d");
    expect(action?.title).toBe("Set as default");
    void action?.onTrigger("concise");
    await Bun.sleep(5);

    expect(h.rpc.setDefaultStyle).toHaveBeenCalledWith({ style: "concise" }, expect.anything());
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({ message: "Output style: Concise", variant: "success" });

    // The picker reopens so the "(default)" marker moves to the new default.
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.selects).toHaveLength(2);
    const concise = h.selects[1]?.options.find((option) => option.value === "concise");
    expect(concise?.footer).toBe("built-in (default)");
  });

  test("ctrl+d does not reopen a picker that closed while the save was pending", async () => {
    const h = createHarness({ hold: true });
    await h.start();
    void h.command().run();
    await Bun.sleep(0);

    let release: () => void = () => {};
    h.rpc.setDefaultStyle.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return { style: "concise" };
    });
    const saving = h.selects[0]?.actions?.[0]?.onTrigger("concise");
    h.settle[0]?.(undefined);
    await Bun.sleep(0);
    release();
    await saving;

    expect(h.toast).toHaveBeenCalledWith({ message: "Output style: Concise", variant: "success" });
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.selects).toHaveLength(1);
  });

  test("a failed ctrl+d save keeps the picker as it is", async () => {
    const h = createHarness({ hold: true });
    await h.start();
    void h.command().run();
    await Bun.sleep(0);
    await h.selects[0]?.actions?.[0]?.onTrigger("nope");

    expect(h.toast).toHaveBeenCalledWith({
      message: 'Unknown output style "nope"',
      variant: "warning",
    });
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.selects).toHaveLength(1);
  });

  test("a failed state fetch toasts the error and opens no dialog", async () => {
    const h = createHarness();
    await h.start();
    h.rpc.state.mockRejectedValueOnce(new Error("offline"));
    await h.command().run();
    expect(h.selects).toHaveLength(0);
    expect(h.toast).toHaveBeenCalledWith({ message: "offline", variant: "error" });
  });
});

describe("sidebar", () => {
  test("shows the style name stored in session metadata", async () => {
    const h = createHarness({ sessions: { "s-1": { metadata: { outputStyle: "pirate" } } } });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Style: Pirate");
    setup.renderer.destroy();
  });

  test("updates after a session.metadata.updated event", async () => {
    const h = createHarness({ sessions: { "s-1": { metadata: { outputStyle: "pirate" } } } });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Style: Pirate");

    h.emitMetadata("s-1", { outputStyle: "concise" });
    expect(await frame()).toContain("Style: Concise");

    h.emitMetadata("other", { outputStyle: "pirate" });
    expect(await frame()).toContain("Style: Concise");
    setup.renderer.destroy();
  });

  test("falls back to the global default, then to Default", async () => {
    const withDefault = createHarness({ state: { defaultStyle: "concise" } });
    await withDefault.start();
    const first = await mountSidebar(withDefault);
    expect(await first.frame()).toContain("Style: Concise");
    first.setup.renderer.destroy();

    const plain = createHarness();
    await plain.start();
    const second = await mountSidebar(plain);
    expect(await second.frame()).toContain("Style: Default");
    second.setup.renderer.destroy();
  });

  test("shows Default when the stored style is not in the style list", async () => {
    const h = createHarness({
      state: { defaultStyle: "concise" },
      sessions: { "s-1": { metadata: { outputStyle: "gone" } } },
    });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Style: Default");
    setup.renderer.destroy();
  });

  test("reflects a style set through the command", async () => {
    const h = createHarness();
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    await h.command().run("pirate");
    expect(await frame()).toContain("Style: Pirate");
    setup.renderer.destroy();
  });

  test("an explicit Default on the session overrides the global default", async () => {
    const h = createHarness({ state: { defaultStyle: "concise" } });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    await h.command().run("default");
    expect(await frame()).toContain("Style: Default");
    setup.renderer.destroy();
  });

  test("is hidden when the server disables the sidebar", async () => {
    const h = createHarness({ state: { sidebar: false } });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect((await frame()).trim()).toBe("");
    setup.renderer.destroy();
  });

  test("is hidden for subagent sessions", async () => {
    const h = createHarness({ sessions: { "s-1": { parentID: "root" } } });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect((await frame()).trim()).toBe("");
    setup.renderer.destroy();
  });

  test("clicking the line dispatches the picker command", async () => {
    const h = createHarness();
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    await frame();
    await setup.mockMouse.click(2, 0);
    expect(h.dispatch).toHaveBeenCalledWith("output-styles.pick");
    setup.renderer.destroy();
  });
});

describe("unreachable server plugin", () => {
  test("toasts once and keeps the sidebar hidden", async () => {
    const h = createHarness({ stateError: new Error("rpc.not_found") });
    await h.start();
    const { setup, frame } = await mountSidebar(h);

    expect((await frame()).trim()).toBe("");
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith({
      message: "Output styles: server plugin not reachable",
      variant: "error",
    });
    setup.renderer.destroy();
  });
});
