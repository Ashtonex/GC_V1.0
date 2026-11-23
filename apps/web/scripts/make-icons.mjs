// Generates placeholder PWA icons (a simple truck silhouette) as PNGs with no image dependencies.
// Run: node apps/web/scripts/make-icons.mjs   (output: apps/web/public/icons/*.png)
// Real branding replaces these later (DECISIONS.md P-004).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [15, 23, 42]; // slate-900, matches theme colour
const FG = [245, 158, 11]; // amber-500
const WIN = [15, 23, 42];

const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// Returns colour at normalised (x, y) in [0,1]. `s` shrinks the drawing toward the centre (maskable safe zone).
function shade(x, y, s) {
  const u = (x - 0.5) / s + 0.5;
  const v = (y - 0.5) / s + 0.5;
  if (rect(u, v, 0.64, 0.44, 0.74, 0.52)) return WIN; // cab window
  if (circle(u, v, 0.33, 0.68, 0.075) || circle(u, v, 0.7, 0.68, 0.075)) return FG; // wheels
  if (rect(u, v, 0.14, 0.3, 0.58, 0.64)) return FG; // cargo box
  if (rect(u, v, 0.6, 0.4, 0.84, 0.64)) return FG; // cab
  return BG;
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, scale) {
  const SS = 4; // supersampling for smooth edges
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, scale);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      const o = py * (size * 3 + 1) + 1 + px * 3;
      const n = SS * SS;
      raw[o] = (r / n) | 0;
      raw[o + 1] = (g / n) | 0;
      raw[o + 2] = (b / n) | 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const icons = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['maskable-512.png', 512, 0.72],
  ['apple-touch-icon-180.png', 180, 0.85],
];
for (const [name, size, scale] of icons) {
  writeFileSync(join(outDir, name), png(size, scale));
  console.log('wrote', name);
}
