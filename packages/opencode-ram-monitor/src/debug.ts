import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const DEBUG_ENV_KEY = "OPENCODE_RAM_MONITOR_DEBUG";
const DEBUG_LOG_FILE = ".opencode-ram-monitor.log";

export function isRamMonitorDebugEnabled(): boolean {
  return process.env[DEBUG_ENV_KEY] === "1";
}

export function getRamMonitorDebugLogPath(cwd: string = process.cwd()): string {
  return join(cwd, DEBUG_LOG_FILE);
}

export async function debugLog(
  event: string,
  details: Record<string, string | number | boolean | undefined> = {},
): Promise<void> {
  if (!isRamMonitorDebugEnabled()) return;

  const payload = {
    time: new Date().toISOString(),
    event,
    ...details,
  };

  try {
    await appendFile(getRamMonitorDebugLogPath(), `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    try {
      process.stderr.write(
        `[opencode-ram-monitor] debug log write failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {}
  }
}
