export type MediaKind = "image" | "audio" | "video" | "document";

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

export interface MediaSource {
  readonly type: "inline" | "uri";
  readonly uri?: string;
}

export interface MediaPlaceholder {
  readonly kind: MediaKind;
  readonly mime: string;
  readonly name?: string;
  readonly dimensions?: MediaDimensions;
  readonly durationMs?: number;
  readonly source: MediaSource;
  readonly inspected: false;
}

export interface MediaDescriptor {
  readonly mime: string;
  readonly name?: string | null;
  readonly uri?: string;
  readonly data?: string;
  readonly durationMs?: number;
}

export function mediaKind(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

export function describeMedia(descriptor: MediaDescriptor): MediaPlaceholder {
  const kind = mediaKind(descriptor.mime);
  const dimensions =
    kind === "image" && descriptor.data
      ? imageDimensions(descriptor.data, descriptor.mime)
      : undefined;
  const durationMs =
    typeof descriptor.durationMs === "number" &&
    Number.isFinite(descriptor.durationMs) &&
    descriptor.durationMs >= 0
      ? descriptor.durationMs
      : undefined;
  return {
    kind,
    mime: descriptor.mime,
    ...(descriptor.name ? { name: descriptor.name } : {}),
    ...(dimensions ? { dimensions } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    source: descriptor.uri ? { type: "uri", uri: descriptor.uri } : { type: "inline" },
    inspected: false,
  };
}

export function imageDimensions(data: string, mime: string): MediaDimensions | undefined {
  const bytes = Buffer.from(data.slice(0, 4096), "base64");
  if (mime === "image/png") return pngDimensions(bytes);
  if (mime === "image/gif") return gifDimensions(bytes);
  if (mime === "image/jpeg") return jpegDimensions(bytes);
  return undefined;
}

function pngDimensions(bytes: Buffer): MediaDimensions | undefined {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes.toString("latin1", 1, 4) !== "PNG")
    return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes: Buffer): MediaDimensions | undefined {
  if (bytes.length < 10 || bytes.toString("latin1", 0, 3) !== "GIF") return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegDimensions(bytes: Buffer): MediaDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const frame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}
