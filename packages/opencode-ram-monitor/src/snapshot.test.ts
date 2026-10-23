import { describe, expect, test } from "bun:test";
import { parsePsProcessSnapshot, parseWmicProcessSnapshot } from "./snapshot.js";

describe("process snapshot parsing", () => {
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
});
