import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "@opentui/solid/preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getRamMonitorDebugLogPath, isRamMonitorDebugEnabled } from "./debug.js";
import * as MemoryModule from "./memory.js";
import { classifyOpencodeProcess, selectValidatedSessionPids } from "./memory.js";
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
