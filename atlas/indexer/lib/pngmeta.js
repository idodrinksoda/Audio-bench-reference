// Reads width/height from a PNG's IHDR chunk without a full decode —
// the header is always the first 24 bytes for a non-corrupt PNG.

'use strict';

const fs = require('fs');

function pngDimensions(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  const sig = buf.subarray(0, 8);
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!sig.equals(PNG_SIG)) throw new Error(`not a PNG: ${file}`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = { pngDimensions };
