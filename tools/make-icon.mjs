// Generates a simple 1024x1024 PNG app icon (dark rounded square, cyan "iV"
// mark made of geometric strokes) without any image dependencies.
// Usage: node tools/make-icon.mjs > app-icon.png ; then `npx tauri icon app-icon.png`
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const px = new Uint8Array(S * S * 4);

function put(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // simple alpha blend over existing
  const da = px[i + 3] / 255;
  const sa = a / 255;
  const oa = sa + da * (1 - sa);
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / (oa || 1));
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / (oa || 1));
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / (oa || 1));
  px[i + 3] = Math.round(oa * 255);
}

// rounded square background
const R = 200;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = Math.max(R - x, 0, x - (S - 1 - R));
    const cy = Math.max(R - y, 0, y - (S - 1 - R));
    if (cx * cx + cy * cy <= R * R) put(x, y, 0x1d, 0x21, 0x28);
  }
}

// grid lines (subtle)
for (let k = 1; k < 8; k++) {
  const p = Math.round((k * S) / 8);
  for (let t = 0; t < S; t++) {
    put(p, t, 0x30, 0x37, 0x44, 160);
    put(t, p, 0x30, 0x37, 0x44, 160);
  }
}

function disc(cx, cy, rad, r, g, b) {
  for (let y = Math.floor(cy - rad); y <= cy + rad; y++)
    for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad) put(x, y, r, g, b);
      else if (d <= rad + 1) put(x, y, r, g, b, Math.round(255 * (rad + 1 - d)));
    }
}
function stroke(x0, y0, x1, y1, w, r, g, b) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(len);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, r, g, b);
  }
}

// "i"
stroke(300, 430, 300, 760, 70, 0x3d, 0xa5, 0xff);
disc(300, 320, 48, 0x3d, 0xa5, 0xff);
// "V"
stroke(430, 400, 590, 760, 74, 0xdf, 0xe4, 0xec);
stroke(750, 400, 590, 760, 74, 0xdf, 0xe4, 0xec);
// lidar points arc
for (let i = 0; i < 26; i++) {
  const a = -Math.PI * 0.05 - (i / 25) * Math.PI * 0.42;
  disc(560 + Math.cos(a) * 330, 640 + Math.sin(a) * 330, 12, 0x3c, 0xcf, 0x7a);
}

// --- PNG encode
function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = process.argv[2] ?? "app-icon.png";
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
