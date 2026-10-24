import type { RamBreakdown } from "./measure.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Sidebar is 42 columns; the host's padding, the box border, and the box's own
// padding leave 33 for a row inside the full layout.
export const FULL_ROW_WIDTH = 33;
// Without the box, a row gets the 37 columns left after the host's padding.
export const MINIMAL_LINE_WIDTH = 37;

export function formatBytes(bytes: number): string {
  const mb = Math.round(bytes / MB);
  if (mb < 1000) return `${mb} MB`;
  const gb = bytes / GB;
  if (gb < 9.995) return `${gb.toFixed(2)} GB`;
  if (gb < 99.95) return `${gb.toFixed(1)} GB`;
  return `${Math.round(gb)} GB`;
}

export function formatTreeSize(bytes: number): string {
  return `${(bytes / MB).toFixed(2)} MB`;
}

export function formatRoleRow(breakdown: RamBreakdown): string {
  return `OpenCode ${formatBytes(breakdown.opencode)} · Tools ${formatBytes(breakdown.tools)}`;
}

export function formatMinimalLine(breakdown: RamBreakdown): string {
  return `${formatBytes(breakdown.total)} (tools ${formatBytes(breakdown.tools)})`;
}
