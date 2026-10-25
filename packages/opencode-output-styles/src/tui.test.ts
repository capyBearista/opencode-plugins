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
type SelectOptions = {
  title: string;
  current?: string;
  options: Array<{ title: string; value: string; description?: string; footer?: string }>;
  actions?: unknown[];
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
    location?: { directory: string };
  } = {},
) {
  const state = { ...baseState, ...options.state };
  let route: Route = options.route ?? { type: "session", sessionID: "s-1" };
  const layers: Array<() => Layer> = [];
  const slots: SlotClaim[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const selects: SelectOptions[] = [];
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
  const context = {
    client: { rpc: () => rpc },
    keymap: { layer: (factory: () => Layer) => layers.push(factory), dispatch },
    ui: {
      router: { current: () => route },
      dialog: {
        select: async (select: SelectOptions) => {
          selects.push(select);
          return options.picked;
        },
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
    selects,
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
    await h.command().run("global");
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
    await h.command().run("global");
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

  test("on the home route sets the global style", async () => {
    const h = createHarness({ route: { type: "home" } });
    await h.start();
    await h.command().run("concise");

    expect(h.rpc.setDefaultStyle).toHaveBeenCalledWith({ style: "concise" }, expect.anything());
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Global output style: Concise",
      variant: "success",
    });
  });

  test("names the built-in default style 'None'", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run("default");
    expect(h.toast).toHaveBeenCalledWith({ message: "Output style: None", variant: "success" });
  });

  test("/output-style none sets the session to the default style id", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run(" None ");
    expect(h.rpc.setSessionStyle).toHaveBeenCalledWith(
      { sessionID: "s-1", style: "default" },
      expect.anything(),
    );
    expect(h.toast).toHaveBeenCalledWith({ message: "Output style: None", variant: "success" });
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

describe("global and subagent sessions", () => {
  test("/output-style global clears the session style, case-insensitively", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run(" Global ");
    expect(h.rpc.clearSessionStyle).toHaveBeenCalledWith({ sessionID: "s-1" }, expect.anything());
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Output style: uses global (None)",
      variant: "success",
    });
  });

  test("/output-style global on home warns without calling the server", async () => {
    const h = createHarness({ route: { type: "home" } });
    await h.start();
    await h.command().run("global");
    expect(h.rpc.clearSessionStyle).not.toHaveBeenCalled();
    expect(h.rpc.setDefaultStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Open a session to use the global output style",
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
    await h.command().run("global");
    const warnings = h.toast.mock.calls.filter(
      ([t]) => t.message === "Subagent sessions don't use output styles",
    );
    expect(warnings).toHaveLength(2);
  });
});

describe("picker", () => {
  test("lists None first, then styles, marking the global setting", async () => {
    const h = createHarness({ state: { defaultStyle: "concise", sessionStyle: "pirate" } });
    await h.start();
    await h.command().run();

    expect(h.rpc.state).toHaveBeenLastCalledWith({ sessionID: "s-1" }, expect.anything());
    const select = h.selects[0];
    expect(select?.title).toBe("Output style · this session");
    expect(select?.current).toBe("pirate");
    expect(select?.options).toEqual([
      { title: "None", value: "default", description: "No output style" },
      {
        title: "Use global (Concise)",
        value: "/global",
        description: "Follow the global setting",
      },
      {
        title: "Concise",
        value: "concise",
        description: "Short answers",
        footer: "built-in · global setting",
      },
      { title: "Pirate", value: "pirate", description: "Arr", footer: "project" },
    ]);
  });

  test("the picker passes no actions in a session or on home", async () => {
    const session = createHarness();
    await session.start();
    await session.command().run();
    expect(session.selects).toHaveLength(1);
    expect(session.selects[0]?.actions).toBeUndefined();

    const home = createHarness({ route: { type: "home" } });
    await home.start();
    await home.command().run();
    expect(home.selects).toHaveLength(1);
    expect(home.selects[0]?.actions).toBeUndefined();
  });

  test("the picker title says whether it edits the session or the global setting", async () => {
    const session = createHarness();
    await session.start();
    await session.command().run();
    expect(session.selects[0]?.title).toBe("Output style · this session");

    const home = createHarness({ route: { type: "home" } });
    await home.start();
    await home.command().run();
    expect(home.selects[0]?.title).toBe("Output style · global");
  });

  test("current is Use global when the session has no stored style", async () => {
    const h = createHarness({ state: { defaultStyle: "concise" } });
    await h.start();
    await h.command().run();
    expect(h.selects[0]?.current).toBe("/global");
  });

  test("Use global names None when no global style is set", async () => {
    const h = createHarness();
    await h.start();
    await h.command().run();
    expect(h.selects[0]?.options[1]).toEqual({
      title: "Use global (None)",
      value: "/global",
      description: "Follow the global setting",
    });
  });

  test("on home current falls back to the global style, then 'default', with no Use global", async () => {
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

  test("picking Use global clears the session style and the sidebar shows the global style", async () => {
    const h = createHarness({
      picked: "/global",
      state: { defaultStyle: "concise", sessionStyle: "pirate" },
      sessions: { "s-1": { metadata: { outputStyle: "pirate" } } },
    });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Output Style: Pirate");

    await h.command().run();
    expect(h.rpc.clearSessionStyle).toHaveBeenCalledWith({ sessionID: "s-1" }, expect.anything());
    expect(h.rpc.setSessionStyle).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith({
      message: "Output style: uses global (Concise)",
      variant: "success",
    });
    expect(await frame()).toContain("Output Style: Concise");
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
    expect(await frame()).toContain("Output Style: Pirate");
    setup.renderer.destroy();
  });

  test("updates after a session.metadata.updated event", async () => {
    const h = createHarness({ sessions: { "s-1": { metadata: { outputStyle: "pirate" } } } });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Output Style: Pirate");

    h.emitMetadata("s-1", { outputStyle: "concise" });
    expect(await frame()).toContain("Output Style: Concise");

    h.emitMetadata("other", { outputStyle: "pirate" });
    expect(await frame()).toContain("Output Style: Concise");
    setup.renderer.destroy();
  });

  test("falls back to the global style, then to None", async () => {
    const withDefault = createHarness({ state: { defaultStyle: "concise" } });
    await withDefault.start();
    const first = await mountSidebar(withDefault);
    expect(await first.frame()).toContain("Output Style: Concise");
    first.setup.renderer.destroy();

    const plain = createHarness();
    await plain.start();
    const second = await mountSidebar(plain);
    expect(await second.frame()).toContain("Output Style: None");
    second.setup.renderer.destroy();
  });

  test("shows None when the stored style is not in the style list", async () => {
    const h = createHarness({
      state: { defaultStyle: "concise" },
      sessions: { "s-1": { metadata: { outputStyle: "gone" } } },
    });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Output Style: None");
    setup.renderer.destroy();
  });

  test("reflects a style set through the command", async () => {
    const h = createHarness();
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    await h.command().run("pirate");
    expect(await frame()).toContain("Output Style: Pirate");
    setup.renderer.destroy();
  });

  test("an explicit None on the session overrides the global style", async () => {
    const h = createHarness({ state: { defaultStyle: "concise" } });
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    await h.command().run("default");
    expect(await frame()).toContain("Output Style: None");
    setup.renderer.destroy();
  });

  test("shows Output Style: None when nothing applies", async () => {
    const h = createHarness();
    await h.start();
    const { setup, frame } = await mountSidebar(h);
    expect(await frame()).toContain("Output Style: None");
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
