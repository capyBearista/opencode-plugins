import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "@opentui/solid/preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";
import { getRamMonitorDebugLogPath, isRamMonitorDebugEnabled } from "./debug.js";
import * as MemoryModule from "./memory.js";
import {
  classifyOpencodeProcess,
  computeLightweightRamBreakdown,
  computeSessionSubtrees,
  computeSubtreeRss,
  countLogicalSessions,
  formatBytes,
  getSessionRoots,
  parsePsRssSnapshot,
  parseWmicWorkingSetSnapshot,
  sampleDarwinRssPerPid,
  sampleDarwinRssWithFallback,
  sampleWindowsRssPerPid,
  sampleWindowsRssWithFallback,
  selectValidatedSessionPids,
  shouldUseBulkSnapshot,
} from "./memory.js";
import * as SidebarConfig from "./sidebar-config.js";
import { getErrorMessage, normalizeRefreshIntervalMs } from "./sidebar-config.js";
import {
  type ProcessEntry,
  type ProcessSnapshot,
  ProcessSnapshotCache,
  parsePsProcessSnapshot,
  parseWmicProcessSnapshot,
} from "./snapshot.js";
import { readRamWidgetTheme } from "./theme.js";

type LoadRamMonitorWidgetConfig = (worktree: string) => Promise<{
  intervalMs: number;
  sourcePath: string | null;
  warning: string | null;
  warningPath: string | null;
}>;

function getLoadRamMonitorWidgetConfig(): LoadRamMonitorWidgetConfig {
  const module = SidebarConfig as Record<string, unknown>;
  return module.loadRamMonitorWidgetConfig as LoadRamMonitorWidgetConfig;
}

type OpenCodePidSets = {
  core: Set<number>;
  launcher: Set<number>;
  all: Set<number>;
  parentByPid?: Map<number, number>;
};

type ResolveActiveSessionPids = (
  liveSets: OpenCodePidSets,
  lockfileCandidates: number[],
  currentPid?: number,
) => number[];

type ProcessNode = {
  pid: number;
  ppid: number;
  rss: number;
  command: string;
  children: ProcessNode[];
};

type SelectTargetRoots = (processes: ProcessNode[], rootPids: Set<number>) => ProcessNode[];

function makeSnapshot(entries: ProcessEntry[]): ProcessSnapshot {
  return {
    entries,
    parentByPid: new Map(entries.map((entry) => [entry.pid, entry.ppid])),
    takenAt: Date.now(),
  };
}

function getResolveActiveSessionPids(): ResolveActiveSessionPids {
  const module = MemoryModule as Record<string, unknown>;
  return module.resolveActiveSessionPids as ResolveActiveSessionPids;
}

function getSelectTargetRoots(): SelectTargetRoots {
  const module = MemoryModule as Record<string, unknown>;
  return module.selectTargetRoots as SelectTargetRoots;
}

type MockRenderable = {
  tag: string;
  children: unknown[];
  props: Record<string, unknown>;
};

type MockSlotClaim = {
  render: (input: unknown) => unknown;
  prepend?: string;
  append?: string;
  before?: string;
  after?: string;
  replace?: string;
};

function readProp(node: MockRenderable, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(node.props, key);
  return descriptor?.get ? descriptor.get.call(node.props) : node.props[key];
}

type MockTuiContext = {
  ui: {
    slot: (claim: MockSlotClaim) => () => void;
    dialog: {
      set: ReturnType<typeof mock>;
      show: ReturnType<typeof mock>;
      clear: ReturnType<typeof mock>;
    };
  };
  keymap: { layer: (input: () => unknown) => void };
  theme: Record<string, unknown>;
  location: { directory: string };
  renderer: { idle: () => Promise<void> };
};

function mockOpenTuiSolid(): void {
  mock.module("@opentui/solid", () => ({
    createElement: (tag: string) => ({ tag, children: [], props: {} }),
    insert: (node: MockRenderable, child: unknown) => {
      node.children.push(child);
    },
    spread: (node: MockRenderable, props: Record<string, unknown>) => {
      for (const key of Object.keys(props)) {
        const descriptor = Object.getOwnPropertyDescriptor(props, key);
        if (descriptor) {
          Object.defineProperty(node.props, key, descriptor);
        }
      }
    },
  }));
}

function createTuiContext(): {
  context: MockTuiContext;
  slots: MockSlotClaim[];
  layers: Array<() => unknown>;
  dialog: MockTuiContext["ui"]["dialog"];
  dialogCalls: string[];
  getShownRender: () => (() => unknown) | undefined;
} {
  const slots: MockSlotClaim[] = [];
  const layers: Array<() => unknown> = [];
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
  const context: MockTuiContext = {
    ui: {
      slot: (claim) => {
        slots.push(claim);
        return () => {};
      },
      dialog,
    },
    keymap: {
      layer: (input) => {
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
      border: { base: "dimgray" },
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
    renderer: { idle: async () => {} },
  };

  return { context, slots, layers, dialog, dialogCalls, getShownRender: () => shownRender };
}

async function loadTuiPlugin() {
  return await import(`./tui.js?tui=${Date.now()}-${Math.random()}`);
}

describe("@capybearista/opencode-ram-monitor", () => {
  const initialDebugValue = process.env.OPENCODE_RAM_MONITOR_DEBUG;

  beforeEach(() => {
    mock.restore();
    if (initialDebugValue === undefined) {
      delete process.env.OPENCODE_RAM_MONITOR_DEBUG;
      return;
    }
    process.env.OPENCODE_RAM_MONITOR_DEBUG = initialDebugValue;
  });

  afterEach(() => {
    mock.restore();
    if (initialDebugValue === undefined) {
      delete process.env.OPENCODE_RAM_MONITOR_DEBUG;
      return;
    }
    process.env.OPENCODE_RAM_MONITOR_DEBUG = initialDebugValue;
  });

  test("classifies direct core and launcher commands", () => {
    expect(classifyOpencodeProcess("/usr/local/bin/.opencode -c")).toBe("core");
    expect(classifyOpencodeProcess("/usr/local/bin/opencode -c")).toBe("launcher");
  });

  test("classifies node-wrapped opencode commands with flags", () => {
    expect(
      classifyOpencodeProcess('node --require /tmp/bootstrap.js "/opt/opencode/bin/.opencode" -c'),
    ).toBe("core");
    expect(
      classifyOpencodeProcess("node --loader ts-node/esm /opt/opencode/bin/opencode --foo"),
    ).toBe("launcher");
  });

  test("does not misclassify non-script opencode args", () => {
    expect(classifyOpencodeProcess("node /srv/app.js --name opencode")).toBeNull();
    expect(classifyOpencodeProcess("node --require opencode /srv/app.js")).toBeNull();
  });

  test("ignores non-opencode commands", () => {
    expect(classifyOpencodeProcess("node /usr/bin/tsserver --stdio")).toBeNull();
    expect(classifyOpencodeProcess("/bin/sh -c 'echo hello'")).toBeNull();
  });

  test("validates candidate PIDs against live opencode set", () => {
    const selected = selectValidatedSessionPids([100, 200, 300, process.pid], new Set([100, 300]));
    expect(selected).toContain(process.pid);
    expect(selected).toContain(100);
    expect(selected).toContain(300);
    expect(selected).not.toContain(200);
  });

  test("keeps current PID even when not in live set", () => {
    const currentPid = 777;
    const selected = selectValidatedSessionPids([111, 222], new Set([111]), currentPid);
    expect(selected).toEqual([currentPid, 111]);
  });

  test("excludes lockfile launcher PID when runtime core set is preferred", () => {
    const currentPid = 900;
    const lockfileLauncherPid = 120;
    const runtimeCorePid = 121;
    const selected = selectValidatedSessionPids(
      [lockfileLauncherPid, runtimeCorePid],
      new Set([runtimeCorePid]),
      currentPid,
    );

    expect(selected).toEqual([currentPid, runtimeCorePid]);
  });

  test("parses ps process snapshots", () => {
    const parsed = parsePsProcessSnapshot(
      "101 10 42 /usr/bin/node\ninvalid\n102 11 7 /usr/bin/sh -c foo\n",
    );
    expect(parsed).toEqual([
      { pid: 101, ppid: 10, rss: 42 * 1024, command: "/usr/bin/node" },
      { pid: 102, ppid: 11, rss: 7 * 1024, command: "/usr/bin/sh -c foo" },
    ]);
  });

  test("parses wmic process snapshots", () => {
    const parsed = parseWmicProcessSnapshot(
      "ProcessId=101\nParentProcessId=10\nWorkingSetSize=1024\nCommandLine=opencode\n\nProcessId=102\nParentProcessId=11\nWorkingSetSize=2048\nCommandLine=.opencode\n",
    );
    expect(parsed).toEqual([
      { pid: 101, ppid: 10, rss: 1024, command: "opencode" },
      { pid: 102, ppid: 11, rss: 2048, command: ".opencode" },
    ]);
  });

  test("derives session roots and the current visible session root", () => {
    const snapshot = makeSnapshot([
      { pid: 100, ppid: 1, rss: 10, command: "/usr/bin/opencode" },
      { pid: 101, ppid: 100, rss: 20, command: "/usr/bin/.opencode" },
      { pid: 200, ppid: 1, rss: 30, command: "/usr/bin/opencode" },
      { pid: 201, ppid: 200, rss: 40, command: "/usr/bin/.opencode" },
    ]);

    const { roots, currentSessionRoot } = getSessionRoots(snapshot, [100, 101, 200, 201], 101);
    expect(roots).toEqual([100, 200]);
    expect(currentSessionRoot).toBe(100);
  });

  test("collapses a launcher-core pair even when ancestry is broken", () => {
    const snapshot = makeSnapshot([
      { pid: 100, ppid: 1, rss: 10, command: "/usr/bin/opencode" },
      { pid: 101, ppid: 1, rss: 20, command: "/usr/bin/.opencode" },
    ]);

    const { roots, currentSessionRoot } = getSessionRoots(snapshot, [100, 101], 101);
    expect(roots).toEqual([100]);
    expect(currentSessionRoot).toBe(100);
  });

  test("computes subtree totals from session roots", () => {
    const entries: ProcessEntry[] = [
      { pid: 100, ppid: 1, rss: 10, command: "/usr/bin/opencode" },
      { pid: 101, ppid: 100, rss: 20, command: "/usr/bin/.opencode" },
      { pid: 102, ppid: 101, rss: 30, command: "serena" },
      { pid: 200, ppid: 1, rss: 40, command: "/usr/bin/opencode" },
      { pid: 201, ppid: 200, rss: 50, command: "/usr/bin/.opencode" },
    ];

    const subtrees = computeSessionSubtrees(entries, [100, 200]);
    expect(subtrees.get(100)?.totalRss).toBe(60);
    expect(subtrees.get(200)?.totalRss).toBe(90);
    expect([...subtrees.values()].reduce((sum, item) => sum + item.totalRss, 0)).toBe(150);
  });

  test("splits direct and tool memory for a single active session", () => {
    const snapshot = makeSnapshot([
      { pid: 100, ppid: 1, rss: 10, command: "/usr/bin/opencode" },
      { pid: 101, ppid: 100, rss: 20, command: "/usr/bin/.opencode" },
      { pid: 102, ppid: 101, rss: 30, command: "serena" },
    ]);

    const { roots, currentSessionRoot } = getSessionRoots(snapshot, [100, 101], 101);
    expect(
      computeLightweightRamBreakdown(snapshot, [100, 101], roots, currentSessionRoot, 101),
    ).toEqual({
      thisDirect: 30,
      thisWithTools: 60,
      allDirect: 30,
      allWithTools: 60,
      count: 1,
    });
  });

  test("splits direct and tool memory across sessions", () => {
    const snapshot = makeSnapshot([
      { pid: 100, ppid: 1, rss: 10, command: "/usr/bin/opencode" },
      { pid: 101, ppid: 100, rss: 20, command: "/usr/bin/.opencode" },
      { pid: 102, ppid: 101, rss: 30, command: "serena" },
      { pid: 200, ppid: 1, rss: 40, command: "/usr/bin/opencode" },
      { pid: 201, ppid: 200, rss: 50, command: "/usr/bin/.opencode" },
      { pid: 202, ppid: 201, rss: 60, command: "uv" },
    ]);

    const { roots, currentSessionRoot } = getSessionRoots(snapshot, [100, 101, 200, 201], 101);
    expect(
      computeLightweightRamBreakdown(
        snapshot,
        [100, 101, 200, 201],
        roots,
        currentSessionRoot,
        101,
      ),
    ).toEqual({
      thisDirect: 30,
      thisWithTools: 60,
      allDirect: 120,
      allWithTools: 210,
      count: 2,
    });
  });

  test("computes subtree totals safely through cycles", () => {
    const rssByPid = new Map<number, number>([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
    const childrenByPid = new Map<number, number[]>([
      [1, [2]],
      [2, [3]],
      [3, [1]],
    ]);

    expect(computeSubtreeRss(1, rssByPid, childrenByPid)).toBe(60);
  });

  test("caches snapshots within ttl and deduplicates concurrent refreshes", async () => {
    let fetchCount = 0;
    const cache = new ProcessSnapshotCache(async () => {
      fetchCount += 1;
      return makeSnapshot([{ pid: 1, ppid: 0, rss: 1, command: "one" }]);
    });

    cache.setTtlMs(60_000);
    const first = await cache.get();
    const second = await cache.get();
    const [third, fourth] = await Promise.all([cache.get(true), cache.get(true)]);

    expect(first.entries.length).toBe(1);
    expect(second).toBe(first);
    expect(third.entries.length).toBe(1);
    expect(fourth).toBe(third);
    expect(fetchCount).toBe(2);
  });

  test("counts a launcher-core ancestry pair as one logical session", () => {
    expect(
      countLogicalSessions([120, 121], {
        core: new Set([121]),
        launcher: new Set([120]),
        all: new Set([120, 121]),
        parentByPid: new Map([
          [121, 120],
          [120, 1],
        ]),
      }),
    ).toBe(1);
  });

  test("still groups a launcher-core pair when ancestry data is partial", () => {
    expect(
      countLogicalSessions([120, 121], {
        core: new Set([121]),
        launcher: new Set([120]),
        all: new Set([120, 121]),
        parentByPid: new Map([[120, 1]]),
      }),
    ).toBe(1);
  });

  test("counts separate launcher-core trees as separate logical sessions", () => {
    expect(
      countLogicalSessions([120, 121, 220, 221], {
        core: new Set([121, 221]),
        launcher: new Set([120, 220]),
        all: new Set([120, 121, 220, 221]),
        parentByPid: new Map([
          [121, 120],
          [120, 1],
          [221, 220],
          [220, 1],
        ]),
      }),
    ).toBe(2);
  });

  test("falls back to raw pid count when ancestry data is unavailable", () => {
    expect(
      countLogicalSessions([120, 121], {
        core: new Set([121]),
        launcher: new Set([120]),
        all: new Set([120, 121]),
        parentByPid: new Map(),
      }),
    ).toBe(2);
  });

  test("normalizes refresh interval to safe bounds", () => {
    expect(normalizeRefreshIntervalMs("200")).toBe(1000);
    expect(normalizeRefreshIntervalMs(0)).toBe(1000);
    expect(normalizeRefreshIntervalMs(1500)).toBe(1500);
    expect(normalizeRefreshIntervalMs(999999)).toBe(60_000);
    expect(normalizeRefreshIntervalMs("bad")).toBe(5000);
  });

  test("formats large byte counts as gigabytes", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });

  test("derives stable error messages from unknown throws", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage("failure")).toBe("failure");
    expect(getErrorMessage({ reason: "unknown" })).toBe("RAM error");
  });

  test("debug mode env gating works", () => {
    delete process.env.OPENCODE_RAM_MONITOR_DEBUG;
    expect(isRamMonitorDebugEnabled()).toBeFalse();
    process.env.OPENCODE_RAM_MONITOR_DEBUG = "1";
    expect(isRamMonitorDebugEnabled()).toBeTrue();
  });

  test("debug log path is cwd-local", () => {
    expect(getRamMonitorDebugLogPath("/tmp/project")).toBe(
      "/tmp/project/.opencode-ram-monitor.log",
    );
  });

  test("package metadata targets dual V2 server and TUI entries", async () => {
    const packageJson = JSON.parse(
      await Bun.file(new URL("../package.json", import.meta.url)).text(),
    ) as {
      scripts: { build: string };
      files: string[];
      exports: Record<string, { types: string; default: string }>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      "oc-plugin"?: unknown;
    };

    expect(packageJson.scripts.build).toContain(
      "bun build src/server.ts --outfile=dist/server.js --target=bun",
    );
    expect(packageJson.scripts.build).toContain(
      "bun build src/tui.ts --outfile=dist/tui.js --target=bun",
    );
    expect(packageJson.exports["."].default).toBe("./dist/server.js");
    expect(packageJson.exports["./server"].default).toBe("./dist/server.js");
    expect(packageJson.exports["./tui"].default).toBe("./dist/tui.js");
    expect(packageJson.files).toEqual(["dist", "server.js", "tui.js"]);
    expect(packageJson["oc-plugin"]).toBeUndefined();
    expect(packageJson.peerDependencies["@opencode/plugin"]).toMatch(/^2\./);
    expect(packageJson.devDependencies["@opencode/plugin"]).toMatch(/^2\./);
    expect(packageJson.peerDependencies["@opencode-ai/plugin"]).toBeUndefined();
  });

  test("server and TUI wrappers re-export their built entrypoints", async () => {
    const serverWrapper = await Bun.file(new URL("../server.js", import.meta.url)).text();
    const tuiWrapper = await Bun.file(new URL("../tui.js", import.meta.url)).text();
    const bunfig = await Bun.file(new URL("../bunfig.toml", import.meta.url)).text();

    expect(serverWrapper).toContain("./dist/server.js");
    expect(tuiWrapper).toContain("./dist/tui.js");
    expect(bunfig).toContain('preload = ["@opentui/solid/preload"]');
  });

  test("source entrypoints expose the V2 server and TUI contracts", async () => {
    const server = await import(`./server.js?contract=${Date.now()}`);
    const tui = await import(`./tui.js?contract=${Date.now()}`);

    expect(server.default.id).toBe("capybearista.opencode-ram-monitor");
    expect(server.default.setup).toBeFunction();
    expect(tui.default.id).toBe("capybearista.opencode-ram-monitor");
    expect(tui.default.setup).toBeFunction();

    const commandNames: string[] = [];
    await (server.default.setup as unknown as (input: unknown) => Promise<void>)({
      command: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            add: (definition: { name: string }) => {
              commandNames.push(definition.name);
            },
          });
        },
      },
      session: { synthetic: async () => {} },
    });
    expect(commandNames).toEqual(["ram"]);

    const { context, slots } = createTuiContext();
    await (tui.default.setup as unknown as (input: unknown) => Promise<void>)(context);
    expect(slots[0]?.after).toBe("sidebar.content");
    expect(slots[1]?.append).toBe("app");
  });

  test("maps V2 theme tokens onto widget theme keys", () => {
    const theme = readRamWidgetTheme({
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
      border: { base: "dimgray" },
    });

    expect(theme).toEqual({
      text: "white",
      textMuted: "gray",
      secondary: "gray",
      error: "red",
      warning: "yellow",
      success: "green",
      borderSubtle: "dimgray",
      backgroundElement: "#111111",
    });
  });

  test("registers the sidebar widget and the ram command layer", async () => {
    mockOpenTuiSolid();
    const module = await loadTuiPlugin();
    const { context, slots, layers, dialog } = createTuiContext();

    await (module.default.setup as unknown as (input: unknown) => Promise<void>)(context);

    expect(slots[0]?.after).toBe("sidebar.content");
    expect(slots[1]?.append).toBe("app");

    const appSlot = slots.find((slot) => slot.append === "app");
    expect(appSlot?.render({})).toBeNull();
    expect(layers.length).toBe(1);

    const layer = layers[0]?.() as {
      mode: string;
      commands: Array<{
        id: string;
        slash?: { name: string; arguments?: boolean };
        run: () => void;
      }>;
    };
    expect(layer.mode).toBe("global");

    const command = layer.commands.find((item) => item.slash?.name === "ram");
    expect(command).toBeDefined();
    expect(command?.slash?.arguments).toBe(true);

    command?.run();
    expect(dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    expect(dialog.show).toHaveBeenCalledTimes(1);
  });

  test("registers one keymap layer per mount and re-registers after disposal", async () => {
    mockOpenTuiSolid();
    const module = await loadTuiPlugin();
    const { context, slots, layers } = createTuiContext();
    await (module.default.setup as unknown as (input: unknown) => Promise<void>)(context);

    const appSlot = slots.find((slot) => slot.append === "app");
    expect(appSlot).toBeDefined();

    const dispose = createRoot((dispose) => {
      appSlot?.render({});
      appSlot?.render({});
      expect(layers.length).toBe(1);
      return dispose;
    });
    dispose();

    const disposeAgain = createRoot((dispose) => {
      appSlot?.render({});
      return dispose;
    });
    expect(layers.length).toBe(2);
    disposeAgain();
  });

  test("sidebar widget opens the modal and the modal loads the process tree", async () => {
    mockOpenTuiSolid();
    mock.module("./memory.js", () => ({
      getHeavyProcessTree: async () => "TREE OUTPUT",
      getLightweightRam: async () => ({
        thisDirect: 0,
        thisWithTools: 0,
        allDirect: 0,
        allWithTools: 0,
        count: 0,
      }),
      formatBytes: () => "0 MB",
    }));

    const module = await loadTuiPlugin();
    const { context, slots, dialog, dialogCalls, getShownRender } = createTuiContext();
    await (module.default.setup as unknown as (input: unknown) => Promise<void>)(context);

    const sidebarSlot = slots.find((slot) => slot.after === "sidebar.content");
    const widget = sidebarSlot?.render({ sessionID: "s-1" }) as MockRenderable;
    expect(widget.tag).toBe("box");
    expect(widget.props.onMouseUp).toBeFunction();
    expect(widget.props.padding).toBeUndefined();
    expect(widget.props.paddingLeft).toBe(1);
    expect(widget.props.paddingRight).toBe(1);

    (widget.props.onMouseUp as () => void)();
    expect(dialogCalls).toEqual(["clear", "show", "set"]);
    expect(dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    expect(dialog.show).toHaveBeenCalledTimes(1);

    const modal = getShownRender()?.() as MockRenderable;
    expect(modal.tag).toBe("box");

    const scrollbox = modal.children[1] as MockRenderable;
    expect(scrollbox.tag).toBe("scrollbox");
    const bodyNode = scrollbox.children[0] as MockRenderable;
    expect(bodyNode.tag).toBe("markdown");
    expect(readProp(bodyNode, "internalBlockMode")).toBe("top-level");
    expect(readProp(bodyNode, "syntaxStyle")).toBeDefined();
    const body = () => readProp(bodyNode, "content") as string;
    expect(body()).toBe("Loading RAM usage...");

    await Bun.sleep(1);
    expect(body()).toBe("TREE OUTPUT");

    const hint = modal.children[2] as MockRenderable;
    (hint.props.onMouseUp as () => void)();
    expect(dialogCalls).toEqual(["clear", "show", "set", "clear"]);
  });

  test("re-opening the modal clears the previous dialog before showing again", async () => {
    mockOpenTuiSolid();
    mock.module("./memory.js", () => ({
      getHeavyProcessTree: async () => "TREE OUTPUT",
      getLightweightRam: async () => ({
        thisDirect: 0,
        thisWithTools: 0,
        allDirect: 0,
        allWithTools: 0,
        count: 0,
      }),
      formatBytes: () => "0 MB",
    }));

    const module = await loadTuiPlugin();
    const { context, slots, dialog, dialogCalls } = createTuiContext();
    await (module.default.setup as unknown as (input: unknown) => Promise<void>)(context);

    const sidebarSlot = slots.find((slot) => slot.after === "sidebar.content");
    const widget = sidebarSlot?.render({ sessionID: "s-1" }) as MockRenderable;
    const open = widget.props.onMouseUp as () => void;

    open();
    open();

    expect(dialogCalls).toEqual(["clear", "show", "set", "clear", "show", "set"]);
    expect(dialog.show).toHaveBeenCalledTimes(2);
    expect(dialog.set).toHaveBeenCalledTimes(2);
  });

  test("parses bulk ps rss snapshots", () => {
    const parsed = parsePsRssSnapshot("101 42\ninvalid line\n102 7\n103 NaN\n101x 8\n");
    expect(parsed.get(101)).toBe(42 * 1024);
    expect(parsed.get(102)).toBe(7 * 1024);
    expect(parsed.has(103)).toBeFalse();
    expect(parsed.size).toBe(2);
  });

  test("parses bulk wmic rss snapshots", () => {
    const parsed = parseWmicWorkingSetSnapshot(
      "ProcessId=101\r\nWorkingSetSize=42000\r\n\r\nProcessId=102\r\nWorkingSetSize=7000\r\n\r\nProcessId=103\r\nWorkingSetSize=bad\r\n",
    );
    expect(parsed.get(101)).toBe(42000);
    expect(parsed.get(102)).toBe(7000);
    expect(parsed.has(103)).toBeFalse();

    const malformed = parseWmicWorkingSetSnapshot(
      "ProcessId=10a\r\nWorkingSetSize=42000\r\n\r\nProcessId=105\r\nWorkingSetSize=77x\r\n",
    );
    expect(malformed.size).toBe(0);

    const nonIdeal = parseWmicWorkingSetSnapshot(
      "WorkingSetSize=9000\r\n\r\n\r\nProcessId=110\r\n\r\n\r\nProcessId=120\r\n\r\nWorkingSetSize=15000\r\n",
    );
    expect(nonIdeal.get(120)).toBe(15000);
    expect(nonIdeal.has(110)).toBeFalse();
    expect(nonIdeal.has(9000)).toBeFalse();
  });

  test("falls back to per-pid sampling when darwin bulk snapshot fails", async () => {
    const calls: string[] = [];
    const sampled = await sampleDarwinRssWithFallback([201, 202], async (command) => {
      calls.push(command);
      if (command === "ps -A -o pid= -o rss=") {
        throw new Error("bulk failed");
      }
      if (command === "ps -o rss= -p 201") return { stdout: "15\n" };
      if (command === "ps -o rss= -p 202") return { stdout: "7\n" };
      return { stdout: "" };
    });

    expect(calls).toContain("ps -A -o pid= -o rss=");
    expect(calls).toContain("ps -o rss= -p 201");
    expect(calls).toContain("ps -o rss= -p 202");
    expect(sampled.get(201)).toBe(15 * 1024);
    expect(sampled.get(202)).toBe(7 * 1024);
  });

  test("falls back to per-pid sampling when windows bulk snapshot fails", async () => {
    const calls: string[] = [];
    const sampled = await sampleWindowsRssWithFallback([301, 302], async (command) => {
      calls.push(command);
      if (command === "wmic process get ProcessId,WorkingSetSize /format:value") {
        throw new Error("bulk failed");
      }
      if (command === 'wmic process where "ProcessId=301" get WorkingSetSize') {
        return { stdout: "WorkingSetSize\n4096\n" };
      }
      if (command === 'wmic process where "ProcessId=302" get WorkingSetSize') {
        return { stdout: "WorkingSetSize\n2048\n" };
      }
      return { stdout: "" };
    });

    expect(calls).toContain("wmic process get ProcessId,WorkingSetSize /format:value");
    expect(calls).toContain('wmic process where "ProcessId=301" get WorkingSetSize');
    expect(calls).toContain('wmic process where "ProcessId=302" get WorkingSetSize');
    expect(sampled.get(301)).toBe(4096);
    expect(sampled.get(302)).toBe(2048);
  });

  test("throws when darwin bulk and per-pid fallback sampling both fail", async () => {
    await expect(
      sampleDarwinRssWithFallback([401, 402], async (command) => {
        if (command === "ps -A -o pid= -o rss=") throw new Error("bulk failed");
        throw new Error("pid failed");
      }),
    ).rejects.toThrow("darwin rss sampling failed for all candidate PIDs");
  });

  test("throws when windows bulk and per-pid fallback sampling both fail", async () => {
    await expect(
      sampleWindowsRssWithFallback([501, 502], async (command) => {
        if (command === "wmic process get ProcessId,WorkingSetSize /format:value") {
          throw new Error("bulk failed");
        }
        throw new Error("pid failed");
      }),
    ).rejects.toThrow("windows rss sampling failed for all candidate PIDs");
  });

  test("falls back to per-pid sampling when darwin bulk output is malformed", async () => {
    const calls: string[] = [];
    const sampled = await sampleDarwinRssWithFallback([601], async (command) => {
      calls.push(command);
      if (command === "ps -A -o pid= -o rss=") {
        return { stdout: "not-a-valid-row\n" };
      }
      return { stdout: "13\n" };
    });

    expect(calls).toContain("ps -A -o pid= -o rss=");
    expect(calls).toContain("ps -o rss= -p 601");
    expect(sampled.get(601)).toBe(13 * 1024);
  });

  test("merges partial darwin bulk snapshots with per-pid fallback", async () => {
    const calls: string[] = [];
    const sampled = await sampleDarwinRssWithFallback([611, 612], async (command) => {
      calls.push(command);
      if (command === "ps -A -o pid= -o rss=") {
        return { stdout: "611 20\n" };
      }
      if (command === "ps -o rss= -p 612") {
        return { stdout: "7\n" };
      }
      return { stdout: "" };
    });

    expect(calls).toContain("ps -A -o pid= -o rss=");
    expect(calls).toContain("ps -o rss= -p 612");
    expect(sampled.get(611)).toBe(20 * 1024);
    expect(sampled.get(612)).toBe(7 * 1024);
  });

  test("does not treat unrelated darwin bulk rows as full coverage", async () => {
    const calls: string[] = [];
    const sampled = await sampleDarwinRssWithFallback([621, 622], async (command) => {
      calls.push(command);
      if (command === "ps -A -o pid= -o rss=") {
        return { stdout: "621 20\n999 99\n" };
      }
      if (command === "ps -o rss= -p 622") {
        return { stdout: "8\n" };
      }
      return { stdout: "" };
    });

    expect(calls).toContain("ps -o rss= -p 622");
    expect(sampled.get(621)).toBe(20 * 1024);
    expect(sampled.get(622)).toBe(8 * 1024);
  });

  test("falls back to per-pid sampling when windows bulk output is malformed", async () => {
    const calls: string[] = [];
    const sampled = await sampleWindowsRssWithFallback([701], async (command) => {
      calls.push(command);
      if (command === "wmic process get ProcessId,WorkingSetSize /format:value") {
        return { stdout: "ProcessId=abc\nWorkingSetSize=def\n" };
      }
      return { stdout: "WorkingSetSize\n8192\n" };
    });

    expect(calls).toContain("wmic process get ProcessId,WorkingSetSize /format:value");
    expect(calls).toContain('wmic process where "ProcessId=701" get WorkingSetSize');
    expect(sampled.get(701)).toBe(8192);
  });

  test("merges partial windows bulk snapshots with per-pid fallback", async () => {
    const calls: string[] = [];
    const sampled = await sampleWindowsRssWithFallback([711, 712], async (command) => {
      calls.push(command);
      if (command === "wmic process get ProcessId,WorkingSetSize /format:value") {
        return { stdout: "ProcessId=711\nWorkingSetSize=4096\n" };
      }
      if (command === 'wmic process where "ProcessId=712" get WorkingSetSize') {
        return { stdout: "WorkingSetSize\n2048\n" };
      }
      return { stdout: "" };
    });

    expect(calls).toContain("wmic process get ProcessId,WorkingSetSize /format:value");
    expect(calls).toContain('wmic process where "ProcessId=712" get WorkingSetSize');
    expect(sampled.get(711)).toBe(4096);
    expect(sampled.get(712)).toBe(2048);
  });

  test("does not treat unrelated windows bulk rows as full coverage", async () => {
    const calls: string[] = [];
    const sampled = await sampleWindowsRssWithFallback([721, 722], async (command) => {
      calls.push(command);
      if (command === "wmic process get ProcessId,WorkingSetSize /format:value") {
        return {
          stdout: "ProcessId=721\nWorkingSetSize=4096\nProcessId=999\nWorkingSetSize=1024\n",
        };
      }
      if (command === 'wmic process where "ProcessId=722" get WorkingSetSize') {
        return { stdout: "WorkingSetSize\n2048\n" };
      }
      return { stdout: "" };
    });

    expect(calls).toContain('wmic process where "ProcessId=722" get WorkingSetSize');
    expect(sampled.get(721)).toBe(4096);
    expect(sampled.get(722)).toBe(2048);
  });

  test("does not fire partial callback when all requested darwin pids are present", async () => {
    const partialEvents: number[][] = [];
    const sampled = await sampleDarwinRssWithFallback(
      [731, 732],
      async (command) => {
        if (command === "ps -A -o pid= -o rss=") {
          return { stdout: "731 20\n732 10\n999 1\n" };
        }
        return { stdout: "" };
      },
      undefined,
      (missingPids) => {
        partialEvents.push(missingPids);
      },
    );

    expect(partialEvents.length).toBe(0);
    expect(sampled.get(731)).toBe(20 * 1024);
    expect(sampled.get(732)).toBe(10 * 1024);
  });

  test("reports darwin per-pid parse failures via onPidError", async () => {
    const errors: Array<{ pid: number; source: string; error: string }> = [];

    await expect(
      sampleDarwinRssWithFallback(
        [801],
        async (command) => {
          if (command === "ps -A -o pid= -o rss=") throw new Error("bulk failed");
          return { stdout: "not-a-number\n" };
        },
        (pid, source, error) => {
          errors.push({
            pid,
            source,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      ),
    ).rejects.toThrow("darwin rss sampling failed for all candidate PIDs");

    expect(errors.length).toBe(1);
    expect(errors[0]?.pid).toBe(801);
    expect(errors[0]?.source).toBe("ps");
  });

  test("reports windows per-pid parse failures via onPidError", async () => {
    const errors: Array<{ pid: number; source: string; error: string }> = [];

    await expect(
      sampleWindowsRssWithFallback(
        [901],
        async (command) => {
          if (command === "wmic process get ProcessId,WorkingSetSize /format:value") {
            throw new Error("bulk failed");
          }
          return { stdout: "WorkingSetSize\ninvalid\n" };
        },
        (pid, source, error) => {
          errors.push({
            pid,
            source,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      ),
    ).rejects.toThrow("windows rss sampling failed for all candidate PIDs");

    expect(errors.length).toBe(1);
    expect(errors[0]?.pid).toBe(901);
    expect(errors[0]?.source).toBe("wmic");
  });

  test("uses bulk sampling policy only for larger pid sets", () => {
    expect(shouldUseBulkSnapshot(1)).toBeFalse();
    expect(shouldUseBulkSnapshot(3)).toBeFalse();
    expect(shouldUseBulkSnapshot(4)).toBeTrue();
  });

  test("samples darwin per-pid without bulk snapshot", async () => {
    const calls: string[] = [];
    const sampled = await sampleDarwinRssPerPid([951, 952], async (command) => {
      calls.push(command);
      if (command === "ps -o rss= -p 951") return { stdout: "5\n" };
      if (command === "ps -o rss= -p 952") return { stdout: "6\n" };
      return { stdout: "" };
    });

    expect(calls).toEqual(["ps -o rss= -p 951", "ps -o rss= -p 952"]);
    expect(sampled.get(951)).toBe(5 * 1024);
    expect(sampled.get(952)).toBe(6 * 1024);
  });

  test("samples windows per-pid without bulk snapshot", async () => {
    const calls: string[] = [];
    const sampled = await sampleWindowsRssPerPid([961, 962], async (command) => {
      calls.push(command);
      if (command === 'wmic process where "ProcessId=961" get WorkingSetSize') {
        return { stdout: "WorkingSetSize\n1024\n" };
      }
      if (command === 'wmic process where "ProcessId=962" get WorkingSetSize') {
        return { stdout: "WorkingSetSize\n2048\n" };
      }
      return { stdout: "" };
    });

    expect(calls).toEqual([
      'wmic process where "ProcessId=961" get WorkingSetSize',
      'wmic process where "ProcessId=962" get WorkingSetSize',
    ]);
    expect(sampled.get(961)).toBe(1024);
    expect(sampled.get(962)).toBe(2048);
  });

  test("loads refresh interval from supported root config files with TUI precedence", async () => {
    const loadRamMonitorWidgetConfig = getLoadRamMonitorWidgetConfig();
    const dir = await mkdtemp(join(tmpdir(), "ram-monitor-config-"));

    try {
      await writeFile(
        join(dir, "opencode.jsonc"),
        `{
  // general setting
  "experimental": {
    "ramMonitor": {
      "refreshIntervalMs": 2000,
    },
  },
}
`,
      );
      await writeFile(
        join(dir, "tui.json"),
        JSON.stringify({
          experimental: {
            ramMonitor: {
              refreshIntervalMs: 4000,
            },
          },
        }),
      );

      await expect(loadRamMonitorWidgetConfig(dir)).resolves.toEqual({
        intervalMs: 4000,
        sourcePath: join(dir, "tui.json"),
        warning: null,
        warningPath: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prefers plugin options over config files", async () => {
    const loadRamMonitorWidgetConfig = getLoadRamMonitorWidgetConfig();
    const dir = await mkdtemp(join(tmpdir(), "ram-monitor-config-"));

    try {
      await writeFile(
        join(dir, "opencode.json"),
        JSON.stringify({
          experimental: {
            ramMonitor: {
              refreshIntervalMs: 2000,
            },
          },
        }),
      );

      await expect(loadRamMonitorWidgetConfig(dir, { refreshIntervalMs: 7000 })).resolves.toEqual({
        intervalMs: 7000,
        sourcePath: "plugin options",
        warning: null,
        warningPath: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads refresh interval from .opencode JSONC config files", async () => {
    const loadRamMonitorWidgetConfig = getLoadRamMonitorWidgetConfig();
    const dir = await mkdtemp(join(tmpdir(), "ram-monitor-config-"));

    try {
      await mkdir(join(dir, ".opencode"), { recursive: true });
      await writeFile(
        join(dir, ".opencode", "tui.jsonc"),
        `{
  "experimental": {
    "ramMonitor": {
      "refreshIntervalMs": 3100,
    },
  },
}
`,
      );

      await expect(loadRamMonitorWidgetConfig(dir)).resolves.toEqual({
        intervalMs: 3100,
        sourcePath: join(dir, ".opencode", "tui.jsonc"),
        warning: null,
        warningPath: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears stale config warnings when a later config file loads successfully", async () => {
    const loadRamMonitorWidgetConfig = getLoadRamMonitorWidgetConfig();
    const dir = await mkdtemp(join(tmpdir(), "ram-monitor-config-"));

    try {
      await writeFile(join(dir, "opencode.jsonc"), "{ invalid }");
      await writeFile(
        join(dir, "tui.jsonc"),
        `{
  "experimental": {
    "ramMonitor": {
      "refreshIntervalMs": 4200,
    },
  },
}
`,
      );

      await expect(loadRamMonitorWidgetConfig(dir)).resolves.toEqual({
        intervalMs: 4200,
        sourcePath: join(dir, "tui.jsonc"),
        warning: null,
        warningPath: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps live launcher and core sessions together when both are active", () => {
    const resolveActiveSessionPids = getResolveActiveSessionPids();

    expect(
      resolveActiveSessionPids(
        {
          core: new Set([121]),
          launcher: new Set([120]),
          all: new Set([120, 121]),
        },
        [120, 121],
        900,
      ),
    ).toEqual([900, 120, 121]);
  });

  test("filters nested roots from the heavy process tree target set", () => {
    const selectTargetRoots = getSelectTargetRoots();
    const child: ProcessNode = { pid: 101, ppid: 100, rss: 1, command: "child", children: [] };
    const parent: ProcessNode = { pid: 100, ppid: 1, rss: 1, command: "parent", children: [child] };

    expect(selectTargetRoots([parent, child], new Set([100, 101]))).toEqual([parent]);
  });

  test("debug logging reports stderr fallback when file writes fail", async () => {
    process.env.OPENCODE_RAM_MONITOR_DEBUG = "1";
    const stderrWrite = mock(() => true);
    const originalWrite = process.stderr.write.bind(process.stderr);

    mock.module("node:fs/promises", () => ({
      appendFile: async () => {
        throw new Error("disk full");
      },
    }));

    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      const module = await import(`./debug.js?stderr-fallback=${Date.now()}`);
      await module.debugLog("test-event", { source: "unit-test" });
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      const calls = (stderrWrite as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(String(calls[0]?.[0])).toContain("disk full");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("/ram command owns prompt injection and resolves normally", async () => {
    mock.module("./memory.js", () => ({
      getHeavyProcessTree: async () => "tree",
    }));

    const module = await import(`./server.js?server=${Date.now()}`);
    const definitions: Array<{
      name: string;
      description?: string;
      execute: (input: unknown) => Promise<void>;
    }> = [];
    const synthetic = mock(async (_input: unknown) => {});

    await (module.default.setup as unknown as (input: unknown) => Promise<void>)({
      command: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            add: (definition: unknown) => {
              definitions.push(definition as (typeof definitions)[number]);
            },
          });
        },
      },
      session: { synthetic },
    });

    const command = definitions[0];
    expect(command?.name).toBe("ram");
    expect(command?.description).toBe("Show a detailed process tree and RAM usage");

    await command?.execute({ sessionID: "s-1", prompt: { text: "" }, delivery: "steer" });

    expect(synthetic).toHaveBeenCalledTimes(1);
    expect(synthetic.mock.calls[0]?.[0]).toMatchObject({
      sessionID: "s-1",
      text: "tree",
      delivery: "steer",
      resume: false,
    });
  });

  test("/ram command raises a user-visible error when prompt injection fails", async () => {
    mock.module("./memory.js", () => ({
      getHeavyProcessTree: async () => "tree",
    }));

    const module = await import(`./server.js?server-fail=${Date.now()}`);
    const definitions: Array<{ execute: (input: unknown) => Promise<void> }> = [];

    await (module.default.setup as unknown as (input: unknown) => Promise<void>)({
      command: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            add: (definition: unknown) => {
              definitions.push(definition as (typeof definitions)[number]);
            },
          });
        },
      },
      session: {
        synthetic: async () => {
          throw new Error("injection failed");
        },
      },
    });

    await expect(
      definitions[0]?.execute({ sessionID: "s-1", prompt: { text: "" }, delivery: "steer" }),
    ).rejects.toThrow("Unable to display RAM usage output. Please try again.");
  });
});
