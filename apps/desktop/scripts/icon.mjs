// Draws the app icon (an attic: a roof over a window) as a 1024px PNG, for `pnpm tauri icon icon.png`.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const size = 1024;
const pixels = Buffer.alloc(size * (size * 4 + 1));
const color = (x, y) => {
  const inBox = x > 96 && x < 928 && y > 96 && y < 928;
  if (!inBox) return [0, 0, 0, 0];
  const roof = y > 230 && y < 560 && Math.abs(x - 512) < (y - 230) * 1.25;
  const wall = y >= 560 && y < 800 && x > 250 && x < 774;
  const window = y > 610 && y < 740 && x > 440 && x < 584;
  if (window) return [138, 75, 20, 255];
  if (roof || wall) return [251, 250, 247, 255];
  return [138, 75, 20, 255];
};
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1);
  pixels[row] = 0;
  for (let x = 0; x < size; x++) {
    const [r, g, b, a] = color(x, y);
    const at = row + 1 + x * 4;
    pixels[at] = r;
    pixels[at + 1] = g;
    pixels[at + 2] = b;
    pixels[at + 3] = a;
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
writeFileSync(
  "icon.png",
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
