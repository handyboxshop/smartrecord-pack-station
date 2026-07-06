export function imageDimensions(bytes, contentType = "") {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 24) return null;

  if (isPng(buffer)) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      type: "image/png"
    };
  }

  if (isJpeg(buffer)) return jpegDimensions(buffer);
  if (isWebp(buffer)) return webpDimensions(buffer);

  const normalizedType = String(contentType).toLowerCase();
  if (normalizedType.includes("png") && buffer.length >= 24) return null;
  return null;
}

export function validateImageFile(bytes, contentType = "") {
  const dimensions = imageDimensions(bytes, contentType);
  if (!dimensions) {
    return { ok: false, code: "IMAGE_DIMENSIONS_UNREADABLE", message: "อ่านขนาดรูปไม่สำเร็จ รองรับ PNG/JPEG/WebP" };
  }
  return { ok: true, data: dimensions };
}

function isPng(buffer) {
  return buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47;
}

function isJpeg(buffer) {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (isSofMarker(marker)) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        type: "image/jpeg"
      };
    }
    offset += 2 + length;
  }
  return null;
}

function isSofMarker(marker) {
  return [
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf
  ].includes(marker);
}

function isWebp(buffer) {
  return buffer.length >= 30
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP";
}

function webpDimensions(buffer) {
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
      type: "image/webp"
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      type: "image/webp"
    };
  }
  return null;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}
