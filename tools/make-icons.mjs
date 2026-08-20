// Generates the PWA icons. Run: node tools/make-icons.mjs
// Writes PNGs with zlib alone - no image library, so the repo stays dependency-free.
// Re-run only if the mark changes; the output is committed.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

/* ---------- minimal PNG encoder (8-bit RGBA, no interlace) ---------- */
const CRC = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = buf => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- the mark: three stops joined by a route ---------- */
const BG = [29, 78, 216];      // #1d4ed8
const FG = [255, 255, 255];
const SS = 4;                  // supersample factor, for antialiasing

// Route points in a 0..1 unit square, kept inside the maskable safe zone.
const STOPS = [[0.28, 0.70], [0.50, 0.36], [0.74, 0.62]];
const DOT = 0.075;
const LINE = 0.043;

const dist2 = (x, y, a, b) => (x - a) ** 2 + (y - b) ** 2;

/** Distance from point to segment, for drawing the connecting line. */
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.sqrt(dist2(px, py, ax + t * dx, ay + t * dy));
}

function inMark(u, v) {
  for (let i = 0; i < STOPS.length - 1; i++) if (segDist(u, v, STOPS[i], STOPS[i + 1]) < LINE / 2) return true;
  for (const [sx, sy] of STOPS) if (dist2(u, v, sx, sy) < DOT ** 2) return true;
  return false;
}

/** `round` gives the icon its own rounded corners; maskable icons stay square. */
function draw(size, round) {
  const px = Buffer.alloc(size * size * 4);
  const r = 0.22 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          let inside = true;
          if (round) {                                  // rounded-rect test
            const cx = Math.min(Math.max(fx, r), size - r);
            const cy = Math.min(Math.max(fy, r), size - r);
            inside = dist2(fx, fy, cx, cy) <= r * r;
          }
          if (!inside) continue;
          bg++;
          if (inMark(fx / size, fy / size)) fg++;
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      if (!bg) continue;
      const mix = fg / bg;                              // fg over bg, within the shape
      px[i]     = Math.round(BG[0] * (1 - mix) + FG[0] * mix);
      px[i + 1] = Math.round(BG[1] * (1 - mix) + FG[1] * mix);
      px[i + 2] = Math.round(BG[2] * (1 - mix) + FG[2] * mix);
      px[i + 3] = Math.round((bg / n) * 255);
    }
  }
  return png(size, size, px);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
const out = (name, buf) => {
  writeFileSync(new URL(`../icons/${name}`, import.meta.url), buf);
  console.log(`icons/${name}  ${(buf.length / 1024).toFixed(1)} KB`);
};

out('icon-192.png', draw(192, true));
out('icon-512.png', draw(512, true));
out('icon-maskable-512.png', draw(512, false));   // full bleed, launcher crops it
out('apple-touch-icon.png', draw(180, false));    // iOS applies its own mask
out('favicon-32.png', draw(32, true));
