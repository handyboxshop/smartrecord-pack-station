import assert from "node:assert/strict";
import test from "node:test";
import { imageDimensions, validateImageFile } from "../src/domain/imageValidation.mjs";

test("imageDimensions reads PNG width and height", () => {
  const png = fakePng({ width: 320, height: 320 });
  assert.deepEqual(imageDimensions(png, "image/png"), {
    width: 320,
    height: 320,
    type: "image/png"
  });
});

test("validateImageFile accepts 1:1 images", () => {
  const result = validateImageFile(fakePng({ width: 512, height: 512 }), "image/png");
  assert.equal(result.ok, true);
  assert.equal(result.data.width, 512);
  assert.equal(result.data.height, 512);
});

test("validateImageFile accepts non-square images", () => {
  const result = validateImageFile(fakePng({ width: 640, height: 360 }), "image/png");
  assert.equal(result.ok, true);
  assert.equal(result.data.width, 640);
  assert.equal(result.data.height, 360);
});

function fakePng({ width, height }) {
  const buffer = Buffer.alloc(33);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, 4, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
