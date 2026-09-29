import { describe, expect, test } from "bun:test";
import { describeMedia, imageDimensions, mediaKind } from "./media.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function gif(width: number, height: number): string {
  const header = Buffer.alloc(10);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header.toString("base64");
}

function jpeg(width: number, height: number): string {
  const bytes = Buffer.alloc(2 + 2 + 14 + 2 + 6 + 3);
  bytes.writeUInt16BE(0xffd8, 0);
  bytes.writeUInt16BE(0xffe0, 2);
  bytes.writeUInt16BE(16, 4);
  bytes.writeUInt16BE(0xffc0, 20);
  bytes.writeUInt16BE(17, 22);
  bytes[24] = 8;
  bytes.writeUInt16BE(height, 25);
  bytes.writeUInt16BE(width, 27);
  return bytes.toString("base64");
}

describe("mediaKind", () => {
  test("classifies mime families and defaults to document", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("audio/mpeg")).toBe("audio");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("application/pdf")).toBe("document");
    expect(mediaKind("text/plain")).toBe("document");
    expect(mediaKind("")).toBe("document");
  });
});

describe("imageDimensions", () => {
  test("reads png, gif and jpeg headers", () => {
    expect(imageDimensions(PNG_1X1, "image/png")).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(gif(320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
    expect(imageDimensions(jpeg(1920, 1080), "image/jpeg")).toEqual({ width: 1920, height: 1080 });
  });

  test("returns undefined for undecodable bytes instead of throwing", () => {
    expect(imageDimensions("not-base64!!", "image/png")).toBeUndefined();
    expect(imageDimensions(PNG_1X1, "image/webp")).toBeUndefined();
  });
});

describe("describeMedia", () => {
  test("describes inline media with metadata and never exposes raw bytes", () => {
    const placeholder = describeMedia({
      mime: "image/png",
      name: "diagram.png",
      data: PNG_1X1,
    });
    expect(placeholder).toEqual({
      kind: "image",
      mime: "image/png",
      name: "diagram.png",
      dimensions: { width: 1, height: 1 },
      source: { type: "inline" },
      inspected: false,
    });
    const serialized = JSON.stringify(placeholder);
    expect(serialized).not.toContain(PNG_1X1);
    expect(serialized).not.toContain("data");
  });

  test("describes uri-backed tool media and documents", () => {
    expect(
      describeMedia({ mime: "application/pdf", uri: "file:///tmp/report.pdf", name: "report.pdf" }),
    ).toEqual({
      kind: "document",
      mime: "application/pdf",
      name: "report.pdf",
      source: { type: "uri", uri: "file:///tmp/report.pdf" },
      inspected: false,
    });
    expect(describeMedia({ mime: "video/mp4", durationMs: 4200 }).durationMs).toBe(4200);
  });

  test("omits optional metadata that is missing or unusable", () => {
    const placeholder = describeMedia({ mime: "audio/ogg", name: null, durationMs: Number.NaN });
    expect(placeholder).toEqual({
      kind: "audio",
      mime: "audio/ogg",
      source: { type: "inline" },
      inspected: false,
    });
    expect(placeholder).not.toHaveProperty("durationMs");
  });
});
