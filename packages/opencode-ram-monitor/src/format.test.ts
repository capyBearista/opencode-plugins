import { describe, expect, test } from "bun:test";
import {
  FULL_ROW_WIDTH,
  formatBytes,
  formatMinimalLine,
  formatRoleRow,
  formatTreeSize,
  MINIMAL_LINE_WIDTH,
} from "./format.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("formatBytes", () => {
  test("keeps three significant digits within seven characters", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(923.4 * MB)).toBe("923 MB");
    expect(formatBytes(999.4 * MB)).toBe("999 MB");
    expect(formatBytes(999.6 * MB)).toBe("0.98 GB");
    expect(formatBytes(1.486 * GB)).toBe("1.49 GB");
    expect(formatBytes(9.996 * GB)).toBe("10.0 GB");
    expect(formatBytes(12.34 * GB)).toBe("12.3 GB");
    expect(formatBytes(99.96 * GB)).toBe("100 GB");
    expect(formatBytes(123.4 * GB)).toBe("123 GB");
  });

  test("never exceeds seven characters below a terabyte", () => {
    for (let bytes = MB; bytes < 1000 * GB; bytes *= 1.37) {
      expect(formatBytes(bytes).length).toBeLessThanOrEqual(7);
    }
  });
});

describe("formatTreeSize", () => {
  test("uses fixed two-decimal megabytes", () => {
    expect(formatTreeSize(529.41 * MB)).toBe("529.41 MB");
  });
});

describe("formatRoleRow", () => {
  test("splits OpenCode from tools", () => {
    expect(formatRoleRow({ opencode: 1.486 * GB, tools: 3.39 * GB, total: 4.876 * GB })).toBe(
      "OpenCode 1.49 GB · Tools 3.39 GB",
    );
  });

  test("fits the box at worst-case widths", () => {
    const row = formatRoleRow({ opencode: 12.34 * GB, tools: 99.4 * GB, total: 111.74 * GB });
    expect(row.length).toBeLessThanOrEqual(FULL_ROW_WIDTH);
  });
});

describe("formatMinimalLine", () => {
  test("shows the total and the tools share on one line", () => {
    expect(formatMinimalLine({ opencode: 1.486 * GB, tools: 3.39 * GB, total: 4.876 * GB })).toBe(
      "4.88 GB (tools 3.39 GB)",
    );
  });

  test("fits the sidebar next to the RAM label at worst-case widths", () => {
    const line = formatMinimalLine({ opencode: 12.34 * GB, tools: 99.4 * GB, total: 111.74 * GB });
    expect(`RAM ● ${line}`.length).toBeLessThanOrEqual(MINIMAL_LINE_WIDTH);
  });
});
