import { test } from "node:test";
import assert from "node:assert/strict";

import { readDimensions, imageTokensFor, estimateImageTokens } from "@optimaizr/core";

/** Minimal valid PNG header: signature + IHDR with the given dimensions. */
function pngHeader(width, height) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Minimal JPEG: SOI, then an SOF0 segment carrying the dimensions. */
function jpegHeader(width, height) {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0xffd8, 0);
  buf.writeUInt16BE(0xffc0, 2);
  buf.writeUInt16BE(17, 4); // segment length
  buf.writeUInt8(8, 6); // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

test("reads PNG dimensions from the IHDR chunk", () => {
  assert.deepEqual(readDimensions(pngHeader(1024, 768)), { width: 1024, height: 768 });
});

test("reads JPEG dimensions from the start-of-frame marker", () => {
  assert.deepEqual(readDimensions(jpegHeader(800, 600)), { width: 800, height: 600 });
});

test("tokens follow pixel area, not encoded size", () => {
  // 750 pixels per token.
  assert.equal(imageTokensFor({ width: 750, height: 1000 }), 1000);
});

test("oversized images are downscaled to a 1568px long edge before billing", () => {
  const tokens = imageTokensFor({ width: 4000, height: 2000 });
  // Scales to 1568x784 -> 1,229,312 px / 750.
  assert.equal(tokens, Math.round((1568 * 784) / 750));
  assert.ok(tokens < 1700, "a full-page screenshot should be well under 1700 tokens");
});

test("a large screenshot costs far less than its base64 length implies", () => {
  const header = pngHeader(1512, 982);
  // Pad to something the size of a real screenshot payload.
  const base64 = Buffer.concat([header, Buffer.alloc(600_000)]).toString("base64");
  const tokens = estimateImageTokens(base64);

  assert.ok(tokens < 2100, `expected under 2100 tokens, got ${tokens}`);
  // The naive chars/4 estimate would be off by more than a hundredfold.
  assert.ok(base64.length / 4 > tokens * 100);
});

test("an unparseable payload falls back rather than throwing", () => {
  assert.equal(estimateImageTokens("not-base64-at-all!!"), 1600);
});
