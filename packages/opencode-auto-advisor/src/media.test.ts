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
  test("classifies known mime families and reports unknown types truthfully", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("audio/mpeg")).toBe("audio");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("application/pdf")).toBe("document");
    expect(mediaKind("text/plain")).toBe("document");
    expect(mediaKind("application/octet-stream")).toBe("unknown");
    expect(mediaKind("application/x-custom")).toBe("unknown");
    expect(mediaKind("")).toBe("unknown");
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
      source: { type: "uri", uri: "report.pdf" },
      inspected: false,
    });
    expect(describeMedia({ mime: "video/mp4", durationMs: 4200 }).durationMs).toBe(4200);
  });

  test("drops query strings and fragments from https sources but keeps host and path", () => {
    const placeholder = describeMedia({
      mime: "image/png",
      name: "signed.png",
      uri: "https://cdn.example.com/assets/a/signed.png?X-Amz-Signature=SECRET#fragment",
    });

    expect(placeholder).toEqual({
      kind: "image",
      mime: "image/png",
      name: "signed.png",
      source: { type: "uri", uri: "https://cdn.example.com/assets/a/signed.png" },
      inspected: false,
    });
    const serialized = JSON.stringify(placeholder);
    expect(serialized).not.toContain("?");
    expect(serialized).not.toContain("#");
    expect(serialized).not.toContain("SECRET");
  });

  test("reduces local file paths to a basename and never keeps directory paths", () => {
    for (const uri of [
      "file:///home/user/secret-project/report.pdf",
      "/home/user/secret-project/report.pdf",
      "relative/dir/report.pdf?token=SECRET#frag",
      "\\\\server\\share\\secret-project\\report.pdf",
    ]) {
      const placeholder = describeMedia({ mime: "application/pdf", uri, name: "report.pdf" });
      expect(placeholder.source).toEqual({ type: "uri", uri: "report.pdf" });
      const serialized = JSON.stringify(placeholder);
      expect(serialized).not.toContain("secret-project");
      expect(serialized).not.toContain("token");
    }
  });

  test("reduces media names to a sanitized leaf and drops query and fragment", () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly expected: string }> = [
      { name: "/home/user/secret-project/report.pdf", expected: "report.pdf" },
      { name: "C:\\Users\\me\\secret-project\\report.pdf", expected: "report.pdf" },
      { name: "https://cdn.example.com/a/signed.png?token=SECRET#frag", expected: "signed.png" },
      { name: "report.pdf?X-Amz-Signature=SECRET#fragment", expected: "report.pdf" },
    ];
    for (const { name, expected } of cases) {
      const placeholder = describeMedia({ mime: "application/pdf", name });
      expect(placeholder.name).toBe(expected);
      const serialized = JSON.stringify(placeholder);
      expect(serialized).not.toContain("secret-project");
      expect(serialized).not.toContain("SECRET");
    }
    expect(describeMedia({ mime: "application/pdf", name: "secret-project/" })).not.toHaveProperty(
      "name",
    );
  });

  test("represents unrepresentable uri schemes structurally without leaking payloads", () => {
    const placeholder = describeMedia({
      mime: "image/png",
      uri: "data:image/png;base64,SECRETPAYLOAD",
    });
    expect(placeholder.source).toEqual({ type: "uri", uri: "data:" });
    expect(JSON.stringify(placeholder)).not.toContain("SECRETPAYLOAD");
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
