const DEFAULT_REFRESH_INTERVAL_MS = 5000;
const MIN_REFRESH_INTERVAL_MS = 1000;
const MAX_REFRESH_INTERVAL_MS = 60_000;

export function getDefaultRefreshIntervalMs(): number {
  return DEFAULT_REFRESH_INTERVAL_MS;
}

export function normalizeRefreshIntervalMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_INTERVAL_MS;
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(parsed)));
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "RAM error";
}
