import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "@opentui/solid/preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getRamMonitorDebugLogPath, isRamMonitorDebugEnabled } from "./debug.js";
import * as MemoryModule from "./memory.js";
import {
  classifyOpencodeProcess,
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

function getResolveActiveSessionPids(): ResolveActiveSessionPids {
  const module = MemoryModule as Record<string, unknown>;
  return module.resolveActiveSessionPids as ResolveActiveSessionPids;
}

function getSelectTargetRoots(): SelectTargetRoots {
  const module = MemoryModule as Record<string, unknown>;
  return module.selectTargetRoots as SelectTargetRoots;
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

  test("normalizes refresh interval to safe bounds", () => {
    expect(normalizeRefreshIntervalMs("200")).toBe(1000);
    expect(normalizeRefreshIntervalMs(0)).toBe(1000);
    expect(normalizeRefreshIntervalMs(1500)).toBe(1500);
    expect(normalizeRefreshIntervalMs(999999)).toBe(60_000);
    expect(normalizeRefreshIntervalMs("bad")).toBe(5000);
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

  test("package metadata targets compiled TUI and debug artifacts", async () => {
    const packageJson = JSON.parse(
      await Bun.file(new URL("../package.json", import.meta.url)).text(),
    ) as {
      scripts: { build: string };
      exports: { "./tui": { default: string } };
    };

    expect(packageJson.scripts.build).toContain(
      "bun build src/debug.ts --outfile=dist/debug.js --target=bun",
    );
    expect(packageJson.scripts.build).toContain(
      "bun build src/sidebar.tsx --outfile=dist/sidebar.js --target=bun",
    );
    expect(packageJson.exports["./tui"].default).toBe("./dist/sidebar.js");
  });

  test("build produces a loadable compiled TUI artifact", async () => {
    const packageDir = new URL("..", import.meta.url).pathname;
    await Bun.$`bun run build`.cwd(packageDir).quiet();
    await Bun.$`bun --eval ${`import("./dist/sidebar.js").then((module) => {
  if (module.default?.id !== "capybearista.opencode-ram-monitor") {
    throw new Error("invalid sidebar module id")
  }
  if (typeof module.default?.tui !== "function") {
    throw new Error("invalid sidebar module export")
  }
})`}`
      .cwd(packageDir)
      .quiet();
  });

  test("registers sidebar slot and returns a renderable", async () => {
    mock.module("@opentui/solid", () => ({
      createElement: () => ({ children: [] as unknown[] }),
      insert: (node: { children?: unknown[] }, child: unknown) => {
        node.children?.push(child);
      },
      spread: () => {},
    }));

    const module = await import(`./sidebar.js?slot-render=${Date.now()}`);
    let sidebarContent: (() => unknown) | undefined;

    await (module.default.tui as (api: unknown) => Promise<void>)({
      slots: {
        register: (payload: { slots?: { sidebar_content?: () => unknown } }) => {
          sidebarContent = payload.slots?.sidebar_content;
        },
      },
      theme: {
        current: {
          text: "white",
          secondary: "gray",
          error: "red",
        },
      },
      state: {
        path: {
          worktree: process.cwd(),
        },
      },
    });

    expect(sidebarContent).toBeFunction();
    expect(() => sidebarContent?.()).not.toThrow();
    expect(sidebarContent?.()).toBeTruthy();
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

  test("/ram command is handled only after prompt injection succeeds", async () => {
    mock.module("./memory.js", () => ({
      getHeavyProcessTree: async () => "tree",
    }));

    const module = await import("./server.js");
    const prompts: unknown[] = [];

    const plugin = await module.default.server({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            prompts.push(payload);
          },
        },
      },
    } as never);

    const beforeExecute = plugin["command.execute.before"];
    expect(beforeExecute).toBeFunction();
    await expect(
      beforeExecute?.({ command: "ram", sessionID: "s-1" } as never, {} as never),
    ).rejects.toThrow("__RAM_COMMAND_HANDLED__");
    expect(prompts.length).toBe(1);
  });

  test("/ram command raises a user-visible error when prompt injection fails", async () => {
    mock.module("./memory.js", () => ({
      getHeavyProcessTree: async () => "tree",
    }));

    const module = await import("./server.js");

    const plugin = await module.default.server({
      client: {
        session: {
          prompt: async () => {
            throw new Error("injection failed");
          },
        },
      },
    } as never);

    const beforeExecute = plugin["command.execute.before"];
    expect(beforeExecute).toBeFunction();
    await expect(
      beforeExecute?.({ command: "ram", sessionID: "s-1" } as never, {} as never),
    ).rejects.toThrow("Unable to display RAM usage output. Please try again.");
  });
});
