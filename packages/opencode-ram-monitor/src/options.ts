const DEFAULT_REFRESH_INTERVAL_MS = 5000;
const MIN_REFRESH_INTERVAL_MS = 1000;
const MAX_REFRESH_INTERVAL_MS = 60_000;

export interface RamMonitorOptions {
  readonly refreshIntervalMs: number;
  readonly warnings: readonly string[];
}

function parseInterval(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInterval(value: number): number {
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(value)));
}

export function parseOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): RamMonitorOptions {
  const warnings: string[] = [];
  const rawInterval = options?.refreshIntervalMs;
  let refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;

  if (rawInterval !== undefined) {
    const parsed = parseInterval(rawInterval);
    if (parsed === null) {
      warnings.push(`refreshIntervalMs must be a number; using ${DEFAULT_REFRESH_INTERVAL_MS}`);
    } else {
      refreshIntervalMs = clampInterval(parsed);
    }
  }

  return { refreshIntervalMs, warnings };
}
