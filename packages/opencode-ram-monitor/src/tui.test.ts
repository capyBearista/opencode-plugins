import "@opentui/solid/preload";
import { describe, expect, mock, test } from "bun:test";
import { createElement, insert, type JSX, testRender } from "@opentui/solid";
import { createRoot, createSignal } from "solid-js";
import type { Inspection } from "./measure.js";
import type { ProcessEntry } from "./snapshot.js";
import tuiPlugin, { createRamMonitorPlugin, type RamMonitorDeps } from "./tui.js";

type SlotClaim = {
  render: (input: unknown) => unknown;
  append?: string;
};

type KeymapLayer = {
  mode: string;
  commands: Array<{ id: string; slash?: { name: string; arguments?: boolean }; run: () => void }>;
};

type TestSetup = Awaited<ReturnType<typeof testRender>>;

function entry(pid: number, ppid: number, mb: number, command: string): ProcessEntry {
  return { pid, ppid, rss: mb * 1024 * 1024, command };
}

const inspection: Inspection = {
  entries: [
    entry(100, 50, 600, "opencode"),
    entry(200, 100, 900, "/home/a/.opencode/bin/opencode serve --service"),
    entry(300, 200, 350, "uv tool uvx serena"),
  ],
  layout: { tuiPid: 100, serverPid: 200, terminalPids: [] },
  notice: null,
};

function fakeDeps(overrides: Partial<RamMonitorDeps> = {}): RamMonitorDeps {
  return { inspect: async () => inspection, selfRss: () => 0, ...overrides };
}

function createContext(options: Record<string, unknown> = {}) {
  const slots: SlotClaim[] = [];
  const layers: Array<() => KeymapLayer> = [];
  const dialogCalls: string[] = [];
  let shownRender: (() => unknown) | undefined;
  const dialog = {
    set: mock(() => {
      dialogCalls.push("set");
    }),
    show: mock((render: () => unknown) => {
      dialogCalls.push("show");
      shownRender = render;
    }),
    clear: mock(() => {
      dialogCalls.push("clear");
    }),
  };
  const context = {
    options,
    client: { server: { info: async () => ({ pid: 200 }) } },
    ui: {
      slot: (claim: SlotClaim) => {
        slots.push(claim);
        return () => {};
      },
      dialog,
    },
    keymap: {
      layer: (input: () => KeymapLayer) => {
        layers.push(input);
      },
    },
    theme: {
      text: {
        base: "white",
        muted: "gray",
        feedback: {
          error: { base: "red" },
          warning: { base: "yellow" },
          success: { base: "green" },
          info: { base: "blue" },
        },
      },
      background: { raised: { base: "#111111" } },
      border: { base: "#444444" },
      markdown: {
        text: "white",
        heading: "cyan",
        strong: "yellow",
        emphasis: "magenta",
        code: "green",
        blockQuote: "gray",
        listItem: "white",
        link: "blue",
        linkText: "blue",
      },
    },
    location: { directory: process.cwd() },
    renderer: undefined as unknown,
  };
  return { context, slots, layers, dialog, dialogCalls, getShownRender: () => shownRender };
}

async function setupPlugin(deps: RamMonitorDeps, options: Record<string, unknown> = {}) {
  const harness = createContext(options);
  await (createRamMonitorPlugin(deps).setup as unknown as (input: unknown) => Promise<void>)(
    harness.context,
  );
  return harness;
}

async function mountWidget(
  deps: RamMonitorDeps,
  options: Record<string, unknown> = {},
): Promise<
  { setup: TestSetup; frame: () => Promise<string> } & Awaited<ReturnType<typeof setupPlugin>>
> {
  const harness = await setupPlugin(deps, options);
  const sidebar = harness.slots.find((slot) => slot.append === "sidebar.content");
  const setup = await testRender(() => sidebar?.render({ sessionID: "s-1" }) as JSX.Element, {
    width: 37,
    height: 10,
  });
  const frame = async () => {
    await Bun.sleep(5);
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  return { ...harness, setup, frame };
}

type RenderNode = { content?: unknown; constructor: { name: string }; getChildren(): RenderNode[] };

function findMarkdownContent(node: RenderNode): string | undefined {
  if (node.constructor.name === "MarkdownRenderable") return node.content as string;
  for (const child of node.getChildren()) {
    const content = findMarkdownContent(child);
    if (content !== undefined) return content;
  }
  return undefined;
}

function ramLayer(layers: Array<() => KeymapLayer>): KeymapLayer {
  const layer = layers[0]?.();
  if (!layer) throw new Error("no keymap layer registered");
  return layer;
}

describe("package and entrypoint", () => {
  test("package metadata exposes only the V2 TUI entry", async () => {
    const packageJson = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      main?: string;
      types?: string;
      scripts: { build: string };
      files: string[];
      exports: Record<string, { types: string; default: string }>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      "oc-plugin"?: unknown;
    };

    expect(packageJson.scripts.build).not.toContain("src/server.ts");
    expect(packageJson.scripts.build).toContain(
      "bun build src/tui.ts --outfile=dist/tui.js --target=bun",
    );
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.types).toBeUndefined();
    expect(Object.keys(packageJson.exports)).toEqual(["./tui"]);
    expect(packageJson.exports["./tui"].default).toBe("./dist/tui.js");
    expect(packageJson.files).toEqual(["dist", "tui.js"]);
    expect(packageJson["oc-plugin"]).toBeUndefined();
    expect(packageJson.peerDependencies["@opencode/plugin"]).toBe(">=2.1.0 <3");
    expect(packageJson.devDependencies["@opencode/plugin"]).toMatch(/^2\.1\./);
  });

  test("ships no server entry for OpenCode to resolve", async () => {
    expect(await Bun.file(new URL("../server.js", import.meta.url)).exists()).toBe(false);
    expect(await Bun.file(new URL("./server.ts", import.meta.url)).exists()).toBe(false);
  });

  test("TUI wrapper re-exports its built entrypoint", async () => {
    const tuiWrapper = await Bun.file(new URL("../tui.js", import.meta.url)).text();
    const bunfig = await Bun.file(new URL("../bunfig.toml", import.meta.url)).text();
    expect(tuiWrapper).toContain("./dist/tui.js");
    expect(bunfig).toContain('preload = ["@opentui/solid/preload"]');
  });

  test("default export is the V2 TUI plugin definition", () => {
    expect(tuiPlugin.id).toBe("capybearista.opencode-ram-monitor");
    expect(tuiPlugin.setup).toBeFunction();
  });
});

describe("registration", () => {
  test("registers the sidebar widget and the /ram command layer", async () => {
    const { slots, layers, dialog } = await setupPlugin(fakeDeps());

    expect(slots.map((slot) => slot.append)).toEqual(["sidebar.content", "app"]);
    const dispose = createRoot((dispose) => {
      expect(slots[1]?.render({})).toBeNull();
      return dispose;
    });

    const layer = ramLayer(layers);
    expect(layer.mode).toBe("global");
    const command = layer.commands.find((item) => item.slash?.name === "ram");
    expect(command?.slash?.arguments).toBe(true);

    command?.run();
    expect(dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    expect(dialog.show).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("registers one keymap layer per mount and re-registers after disposal", async () => {
    const { slots, layers } = await setupPlugin(fakeDeps());
    const appSlot = slots.find((slot) => slot.append === "app");

    const dispose = createRoot((dispose) => {
      appSlot?.render({});
      appSlot?.render({});
      return dispose;
    });
    expect(layers.length).toBe(1);
    dispose();

    const disposeAgain = createRoot((dispose) => {
      appSlot?.render({});
      return dispose;
    });
    expect(layers.length).toBe(2);
    disposeAgain();
  });
});

describe("full layout", () => {
  test("shows the total and the OpenCode/tools split in a two-row box", async () => {
    const { setup, frame } = await mountWidget(fakeDeps());
    const text = await frame();

    expect(text).toContain("RAM Usage");
    expect(text).toContain("1.81 GB");
    expect(text).toContain("OpenCode 1.46 GB · Tools 350 MB");
    expect(text).not.toContain("session");
    expect(text.split("\n").filter((line) => line.trim()).length).toBe(4);
    setup.renderer.destroy();
  });

  test("shows a notice row when the server is not visible", async () => {
    const { setup, frame } = await mountWidget(
      fakeDeps({
        inspect: async () => ({
          ...inspection,
          layout: { ...inspection.layout, serverPid: null },
          notice: "server not visible",
        }),
      }),
    );
    const text = await frame();

    expect(text).toContain("OpenCode 600 MB · Tools 0 MB");
    expect(text).toContain("server not visible");
    setup.renderer.destroy();
  });

  test("shows every option warning in footer rows", async () => {
    const { setup, frame } = await mountWidget(fakeDeps(), {
      refreshIntervalMs: "bad",
      layout: "tiny",
    });
    const text = await frame();
    expect(text).toContain("refreshIntervalMs must be");
    expect(text).toContain("layout must be");
    setup.renderer.destroy();
  });

  test("shows poll errors in place of the split", async () => {
    const { setup, frame } = await mountWidget(
      fakeDeps({
        inspect: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(await frame()).toContain("Error: boom");
    setup.renderer.destroy();
  });

  test("clicking the widget opens the modal, clearing any previous dialog first", async () => {
    const { setup, frame, dialogCalls } = await mountWidget(fakeDeps());
    await frame();

    await setup.mockMouse.click(3, 1);
    await setup.mockMouse.click(3, 1);
    expect(dialogCalls).toEqual(["clear", "show", "set", "clear", "show", "set"]);
    setup.renderer.destroy();
  });
});

describe("minimal layout", () => {
  test("renders one borderless row with the total and tools share", async () => {
    const { setup, frame } = await mountWidget(fakeDeps(), { layout: "minimal" });
    const lines = (await frame()).split("\n").filter((line) => line.trim());

    expect(lines).toEqual([expect.stringMatching(/RAM [●○] 1\.81 GB \(tools 350 MB\)/)]);
    expect(lines[0]).not.toContain("│");
    setup.renderer.destroy();
  });

  test("keeps notices to one row", async () => {
    const { setup, frame } = await mountWidget(
      fakeDeps({
        inspect: async () => ({
          ...inspection,
          layout: { ...inspection.layout, serverPid: null },
          notice: "server not visible",
        }),
      }),
      { layout: "minimal", refreshIntervalMs: "bad" },
    );
    const lines = (await frame()).split("\n").filter((line) => line.trim());

    expect(lines).toEqual([expect.stringMatching(/RAM [●○] 600 MB \(tools 0 MB\)/)]);
    setup.renderer.destroy();
  });

  test("shows poll errors on the same row", async () => {
    const { setup, frame } = await mountWidget(
      fakeDeps({
        inspect: async () => {
          throw new Error("boom");
        },
      }),
      { layout: "minimal" },
    );
    const lines = (await frame()).split("\n").filter((line) => line.trim());

    expect(lines).toEqual([expect.stringMatching(/RAM [●○] Error: boom/)]);
    setup.renderer.destroy();
  });

  test("opens the modal on click", async () => {
    const { setup, frame, dialogCalls } = await mountWidget(fakeDeps(), { layout: "minimal" });
    await frame();

    await setup.mockMouse.click(2, 0);
    expect(dialogCalls).toEqual(["clear", "show", "set"]);
    setup.renderer.destroy();
  });
});

describe("modal", () => {
  async function renderModal(
    deps: RamMonitorDeps,
  ): Promise<{ setup: TestSetup; text: () => Promise<string> }> {
    const harness = await setupPlugin(deps);
    const [shown, setShown] = createSignal<(() => unknown) | undefined>(undefined);
    const setup = await testRender(
      () => {
        const host = createElement("box");
        insert(host, () => shown()?.() as JSX.Element);
        return host as unknown as JSX.Element;
      },
      { width: 100, height: 40 },
    );
    harness.context.renderer = setup.renderer;

    const dispose = createRoot((dispose) => {
      harness.slots[1]?.render({});
      return dispose;
    });
    ramLayer(harness.layers)
      .commands.find((item) => item.slash?.name === "ram")
      ?.run();
    dispose();
    setShown(() => harness.getShownRender());

    const text = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await Bun.sleep(25);
        await setup.renderOnce();
      }
      return setup.captureCharFrame();
    };
    return { setup, text };
  }

  test("renders the TUI and server trees", async () => {
    const { setup, text } = await renderModal(fakeDeps());
    const frame = await text();
    expect(findMarkdownContent(setup.renderer.root as unknown as RenderNode)).toContain(
      "**TUI** (PID 100)",
    );

    expect(frame).toContain("OpenCode RAM Usage");
    expect(frame).toContain("TUI (PID 100)");
    expect(frame).toContain("Server (PID 200)");
    expect(frame).toContain("[uv tool uvx] (PID 300)");
    setup.renderer.destroy();
  });

  test("shows the failure instead of loading forever", async () => {
    const { setup, text } = await renderModal(
      fakeDeps({
        inspect: async () => {
          throw new Error("tree exploded");
        },
      }),
    );
    await text();
    expect(findMarkdownContent(setup.renderer.root as unknown as RenderNode)).toBe(
      "Error: tree exploded",
    );
    setup.renderer.destroy();
  });
});
