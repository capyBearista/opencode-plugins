import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  debugLog,
  getErrorMessage,
  getRamMonitorDebugLogPath,
  isRamMonitorDebugEnabled,
} from "./debug.js";

const initialDebugValue = process.env.OPENCODE_RAM_MONITOR_DEBUG;

afterEach(() => {
  if (initialDebugValue === undefined) delete process.env.OPENCODE_RAM_MONITOR_DEBUG;
  else process.env.OPENCODE_RAM_MONITOR_DEBUG = initialDebugValue;
});

describe("debug", () => {
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

  test("derives stable error messages from unknown throws", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage("failure")).toBe("failure");
    expect(getErrorMessage({ reason: "unknown" })).toBe("RAM error");
  });

  test("debug logging reports stderr fallback when file writes fail", async () => {
    process.env.OPENCODE_RAM_MONITOR_DEBUG = "1";
    const directory = await mkdtemp(join(tmpdir(), "ram-monitor-debug-"));
    await mkdir(getRamMonitorDebugLogPath(directory));
    const originalCwd = process.cwd();
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrWrite = mock(() => true);
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      process.chdir(directory);
      await debugLog("test-event", { source: "unit-test" });
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      const calls = (stderrWrite as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(String(calls[0]?.[0])).toContain("debug log write failed");
    } finally {
      process.stderr.write = originalWrite;
      process.chdir(originalCwd);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
