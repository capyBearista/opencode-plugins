import { describe, expect, test } from "bun:test";
import { findOrphanPtyDaemons, findServer, inspectProcesses, measureRam } from "./measure.js";
import type { ProcessEntry, ProcessSnapshot } from "./snapshot.js";

const HOME = "/home/a";
const TUI = 100;
const SERVER = 200;

function entry(pid: number, ppid: number, mb: number, command: string): ProcessEntry {
  return { pid, ppid, rss: mb * 1024 * 1024, command };
}

const PTY_CMD = `/home/a/.cache/opencode/bin/opencode-pty/v/opencode-pty daemon --runtime-dir ${HOME}/.local/state/opencode/pty --name abc`;

// Mirrors the user's probe: the shared server is a child of the TUI that started it.
const childServer: ProcessEntry[] = [
  entry(1, 0, 10, "/sbin/init"),
  entry(50, 1, 5, "bash"),
  entry(TUI, 50, 600, "opencode"),
  entry(SERVER, TUI, 900, "/home/a/.opencode/bin/opencode serve --service"),
  entry(300, SERVER, 200, "uv tool uvx serena"),
  entry(301, 300, 100, "node /srv/mcp.js"),
  entry(302, SERVER, 50, "/usr/bin/clangd"),
  entry(400, TUI, 4, "sh -c ps -A"),
];

function snapshot(entries: ProcessEntry[]): ProcessSnapshot {
  return {
    entries,
    parentByPid: new Map(entries.map((item) => [item.pid, item.ppid])),
    takenAt: 0,
  };
}

const MB = 1024 * 1024;

describe("findServer", () => {
  test("trusts a reported pid only when it is a local opencode server", () => {
    expect(findServer(childServer, SERVER, TUI)).toBe(SERVER);
    expect(findServer(childServer, 301, TUI)).toBeNull();
    expect(findServer(childServer, 999, TUI)).toBeNull();
    expect(findServer(childServer, null, TUI)).toBeNull();
    expect(findServer(childServer, TUI, TUI)).toBeNull();
  });
});

describe("findOrphanPtyDaemons", () => {
  test("keeps daemons under the home whose parent is no longer a server", () => {
    const entries = [
      ...childServer,
      entry(500, 1, 30, PTY_CMD),
      entry(501, SERVER, 30, PTY_CMD),
      entry(502, 1, 30, PTY_CMD.replaceAll(HOME, "/home/b")),
      entry(503, 777, 30, PTY_CMD),
    ];
    expect(findOrphanPtyDaemons(entries, HOME)).toEqual([500, 503]);
  });

  test("compares paths case-sensitively outside Windows", () => {
    const entries = [entry(500, 1, 30, PTY_CMD.replaceAll(HOME, "/home/A"))];
    expect(findOrphanPtyDaemons(entries, HOME, "linux")).toEqual([]);
    expect(findOrphanPtyDaemons(entries, HOME, "win32")).toEqual([500]);
  });
});

describe("measureRam", () => {
  test("counts a TUI started inside an OpenCode terminal pane once", () => {
    const nested = [
      entry(1, 0, 10, "/sbin/init"),
      entry(SERVER, 1, 900, "/home/a/.opencode/bin/opencode serve --service"),
      entry(300, SERVER, 30, PTY_CMD),
      entry(310, 300, 20, "bash"),
      entry(TUI, 310, 600, "opencode"),
      entry(400, TUI, 50, "sh -c ps -A"),
      entry(401, 400, 50, "ps -A"),
    ];
    expect(measureRam(nested, { tuiPid: TUI, serverPid: SERVER, terminalPids: [] }, 0)).toEqual({
      opencode: 1600 * MB,
      tools: 50 * MB,
      total: 1650 * MB,
    });
  });

  test("counts a TUI inside an orphaned terminal pane once", () => {
    const nested = [
      ...childServer.filter((item) => item.pid !== TUI && item.pid !== 400),
      entry(500, 1, 30, PTY_CMD),
      entry(510, 500, 20, "bash"),
      entry(TUI, 510, 600, "opencode"),
      entry(520, TUI, 10, "sh -c ps -A"),
    ];
    expect(measureRam(nested, { tuiPid: TUI, serverPid: SERVER, terminalPids: [500] }, 0)).toEqual({
      opencode: 1510 * MB,
      tools: 400 * MB,
      total: 1910 * MB,
    });
  });

  test("splits TUI + server from everything under the server", () => {
    expect(
      measureRam(childServer, { tuiPid: TUI, serverPid: SERVER, terminalPids: [] }, 0),
    ).toEqual({ opencode: 1504 * MB, tools: 350 * MB, total: 1854 * MB });
  });

  test("does not count the TUI's own helper children as tools", () => {
    const result = measureRam(childServer, { tuiPid: TUI, serverPid: SERVER, terminalPids: [] }, 0);
    expect(result.tools).toBe(350 * MB);
  });

  test("measures a detached server the same way", () => {
    const detached = childServer.map((item) => (item.pid === SERVER ? { ...item, ppid: 1 } : item));
    expect(measureRam(detached, { tuiPid: TUI, serverPid: SERVER, terminalPids: [] }, 0)).toEqual({
      opencode: 1504 * MB,
      tools: 350 * MB,
      total: 1854 * MB,
    });
  });

  test("adds orphaned terminal daemons and their shells to tools", () => {
    const entries = [...childServer, entry(500, 1, 30, PTY_CMD), entry(510, 500, 20, "bash")];
    expect(
      measureRam(entries, { tuiPid: TUI, serverPid: SERVER, terminalPids: [500] }, 0).tools,
    ).toBe(400 * MB);
  });

  test("never counts a daemon twice when it is still under the server", () => {
    const entries = [...childServer, entry(501, SERVER, 30, PTY_CMD)];
    expect(
      measureRam(entries, { tuiPid: TUI, serverPid: SERVER, terminalPids: [501] }, 0).tools,
    ).toBe(380 * MB);
  });

  test("keeps an unverified server child out of the TUI's share", () => {
    expect(measureRam(childServer, { tuiPid: TUI, serverPid: null, terminalPids: [] }, 0)).toEqual({
      opencode: 604 * MB,
      tools: 0,
      total: 604 * MB,
    });
  });

  test("falls back to the TUI only when the server is not visible", () => {
    const tuiOnly = childServer.filter((item) => item.pid !== SERVER);
    expect(measureRam(tuiOnly, { tuiPid: TUI, serverPid: null, terminalPids: [] }, 0)).toEqual({
      opencode: 604 * MB,
      tools: 0,
      total: 604 * MB,
    });
  });

  test("uses the fallback TUI size when the TUI is missing from the snapshot", () => {
    expect(measureRam([], { tuiPid: TUI, serverPid: null, terminalPids: [] }, 42)).toEqual({
      opencode: 42,
      tools: 0,
      total: 42,
    });
  });

  test("terminates when a process lists itself as its parent", () => {
    const selfParented = [
      entry(TUI, 1, 1, "opencode"),
      entry(SERVER, SERVER, 1, "opencode serve --service"),
      entry(302, SERVER, 1, "node c"),
    ];
    expect(
      measureRam(selfParented, { tuiPid: TUI, serverPid: SERVER, terminalPids: [] }, 0),
    ).toEqual({ opencode: 2 * MB, tools: 1 * MB, total: 3 * MB });
  });
});

describe("inspectProcesses", () => {
  const client = (pid: number) => ({ server: { info: async () => ({ pid }) } });

  test("resolves the verified server and orphaned terminals", async () => {
    const entries = [...childServer, entry(500, 1, 30, PTY_CMD)];
    const result = await inspectProcesses(client(SERVER), {
      tuiPid: TUI,
      home: HOME,
      takeSnapshot: async () => snapshot(entries),
    });
    expect(result.layout).toEqual({ tuiPid: TUI, serverPid: SERVER, terminalPids: [500] });
    expect(result.notice).toBeNull();
    expect(result.entries).toBe(entries);
  });

  test("reports a notice when the server cannot be verified", async () => {
    const result = await inspectProcesses(client(4242), {
      tuiPid: TUI,
      home: HOME,
      takeSnapshot: async () => snapshot(childServer),
    });
    expect(result.layout.serverPid).toBeNull();
    expect(result.notice).toBe("server not visible");
  });

  test("leaves local terminals out of the TUI-only fallback", async () => {
    const entries = [
      ...childServer,
      entry(500, 1, 30, PTY_CMD),
      entry(510, 500, 400, "npm run dev"),
    ];
    const result = await inspectProcesses(client(4242), {
      tuiPid: TUI,
      home: HOME,
      takeSnapshot: async () => snapshot(entries),
    });
    expect(result.notice).toBe("server not visible");
    expect(result.layout).toEqual({ tuiPid: TUI, serverPid: null, terminalPids: [] });
  });

  test("reports a notice when the server info request fails", async () => {
    const failing = {
      server: {
        info: async () => {
          throw new Error("401");
        },
      },
    };
    const result = await inspectProcesses(failing, {
      tuiPid: TUI,
      home: HOME,
      takeSnapshot: async () => snapshot(childServer),
    });
    expect(result.layout.serverPid).toBeNull();
    expect(result.notice).toBe("server not visible");
  });

  test("reports a notice when the process list cannot be read", async () => {
    const result = await inspectProcesses(client(SERVER), {
      tuiPid: TUI,
      home: HOME,
      takeSnapshot: async () => {
        throw new Error("ps missing");
      },
    });
    expect(result.entries).toEqual([]);
    expect(result.layout).toEqual({ tuiPid: TUI, serverPid: null, terminalPids: [] });
    expect(result.notice).toBe("process list unavailable");
  });
});
