import { describe, expect, test } from "bun:test";
import type { Inspection } from "./measure.js";
import type { ProcessEntry } from "./snapshot.js";
import { renderProcessTree } from "./tree.js";

function entry(pid: number, ppid: number, mb: number, command: string): ProcessEntry {
  return { pid, ppid, rss: mb * 1024 * 1024, command };
}

const entries: ProcessEntry[] = [
  entry(1, 0, 10, "/sbin/init"),
  entry(100, 50, 600, "opencode"),
  entry(200, 100, 900, "/home/a/.opencode/bin/opencode serve --service"),
  entry(300, 200, 200, "uv tool uvx serena"),
  entry(301, 300, 100, "node /srv/mcp.js"),
  entry(500, 1, 30, "/x/opencode-pty daemon --runtime-dir /home/a/state/pty --name z"),
  entry(510, 500, 20, "bash"),
];

const inspection: Inspection = {
  entries,
  layout: { tuiPid: 100, serverPid: 200, terminalPids: [500] },
  notice: null,
};

describe("renderProcessTree", () => {
  test("summarizes totals by role", () => {
    expect(renderProcessTree(inspection, 0)).toContain(
      "Total 1.81 GB · OpenCode 1.46 GB · Tools 350 MB",
    );
  });

  test("renders the TUI, server, and orphaned terminals as separate trees", () => {
    const markdown = renderProcessTree(inspection, 0);
    expect(markdown).toContain("**TUI** (PID 100)");
    expect(markdown).toContain("**Server** (PID 200)");
    expect(markdown).toContain("**Terminals** (PID 500)");
    expect(markdown).toContain("[opencode serve] (PID 200) - 900.00 MB");
    expect(markdown).toContain("[node] (PID 301) - 100.00 MB");
    expect(markdown).toContain("[bash] (PID 510) - 20.00 MB");
  });

  test("does not repeat the server inside the TUI tree", () => {
    const markdown = renderProcessTree(inspection, 0);
    expect(markdown.match(/\(PID 200\) - 900\.00 MB/g)?.length).toBe(1);
  });

  test("shows the notice and only the TUI when the server is not visible", () => {
    const markdown = renderProcessTree(
      {
        entries,
        layout: { tuiPid: 100, serverPid: null, terminalPids: [] },
        notice: "server not visible",
      },
      0,
    );
    expect(markdown).toContain("> server not visible");
    expect(markdown).toContain("**TUI** (PID 100)");
    expect(markdown).not.toContain("**Server**");
  });

  test("falls back to the TUI's own size when the process list is empty", () => {
    const markdown = renderProcessTree(
      {
        entries: [],
        layout: { tuiPid: 100, serverPid: null, terminalPids: [] },
        notice: "process list unavailable",
      },
      42 * 1024 * 1024,
    );
    expect(markdown).toContain("Total 42 MB · OpenCode 42 MB · Tools 0 MB");
    expect(markdown).toContain("> process list unavailable");
  });

  test("marks parent cycles instead of looping", () => {
    const markdown = renderProcessTree(
      {
        entries: [entry(100, 101, 1, "opencode"), entry(101, 100, 1, "node")],
        layout: { tuiPid: 100, serverPid: null, terminalPids: [] },
        notice: null,
      },
      0,
    );
    expect(markdown).toContain("cycle detected");
  });
});
