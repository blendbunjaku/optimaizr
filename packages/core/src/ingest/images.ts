/**
 * Image token estimation. Images bill on pixel area after the API downscales
 * them (long edge at most 1568px, then about `width * height / 750` tokens), not
 * on base64 size: a 170KB screenshot is ~1,600 tokens. Dimensions are read from
 * the encoded header, exact for PNG and GIF and near-exact for JPEG.
 */

const MAX_EDGE = 1568;
const PIXELS_PER_TOKEN = 750;
/** Used when the header can't be parsed: a full-size image after downscaling. */
const FALLBACK_TOKENS = 1600;

export interface Dimensions {
  width: number;
  height: number;
}

/** PNG: 8-byte signature, then the IHDR chunk carries width and height. */
function pngSize(buf: Buffer): Dimensions | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF: dimensions sit at bytes 6-10, little-endian. */
function gifSize(buf: Buffer): Dimensions | null {
  if (buf.length < 10) return null;
  if (buf.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** JPEG: walk the marker segments until a start-of-frame carries the size. */
function jpegSize(buf: Buffer): Dimensions | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1]!;
    // SOF0-SOF15, excluding the non-frame markers DHT (c4), JPGA (c8), DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength <= 0) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/** WebP (VP8X / VP8L / VP8) inside a RIFF container. */
function webpSize(buf: Buffer): Dimensions | null {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP")
    return null;
  const format = buf.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return {
      width: 1 + (buf.readUIntLE(24, 3) & 0xffffff),
      height: 1 + (buf.readUIntLE(27, 3) & 0xffffff),
    };
  }
  if (format === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

export function readDimensions(header: Buffer): Dimensions | null {
  return pngSize(header) ?? jpegSize(header) ?? gifSize(header) ?? webpSize(header);
}

/** Tokens an image costs, after the downscaling the API applies. */
export function imageTokensFor(dim: Dimensions | null): number {
  if (!dim || dim.width <= 0 || dim.height <= 0) return FALLBACK_TOKENS;
  const scale = Math.min(1, MAX_EDGE / Math.max(dim.width, dim.height));
  const w = dim.width * scale;
  const h = dim.height * scale;
  return Math.round((w * h) / PIXELS_PER_TOKEN);
}

/**
 * Estimate an image block's tokens from its base64 payload. Only the first few
 * kilobytes are decoded, enough for any of these headers.
 */
export function estimateImageTokens(base64Data: string): number {
  try {
    // 4 base64 chars per 3 bytes; 4KB of base64 is ~3KB decoded.
    const slice = base64Data.slice(0, 4096);
    const header = Buffer.from(slice, "base64");
    return imageTokensFor(readDimensions(header));
  } catch {
    return FALLBACK_TOKENS;
  }
}
