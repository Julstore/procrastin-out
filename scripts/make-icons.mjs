// Genera icon-512/192/180.png sin dependencias (gradiente + "KO" en bitmap 5x7).
// Uso: node scripts/make-icons.mjs  (escribe en public/)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(process.cwd(), 'public');
const FONT = {
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
};
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
const TOP = [226, 72, 46];      // #e2482e
const BOT = [240, 160, 34];     // #f0a022
const SHADOW = [120, 30, 10];

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_T = crcTable();
function crc(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([td, data])));
  return Buffer.concat([len, td, data, c]);
}

function makePng(size) {
  const R = Math.round(size * 0.225);          // radio de esquinas
  const px = Buffer.alloc(size * size * 4);
  // fondo con gradiente dentro de rounded-rect
  for (let y = 0; y < size; y++) {
    const col = mix(TOP, BOT, y / (size - 1));
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
      let alpha = 255;
      if (cx < R && cy < R) {
        const dx = R - cx, dy = R - cy;
        if (dx * dx + dy * dy > R * R) alpha = 0;
      }
      const i = (y * size + x) * 4;
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = alpha;
    }
  }
  // letras "KO": grilla 11x7 (5+1+5), escala s, con sombra
  const s = Math.floor(size / 22);
  const gw = 11 * s, gh = 7 * s;
  const ox = Math.floor((size - gw) / 2), oy = Math.floor((size - gh) / 2);
  const draw = (dx, dy, color, a) => {
    const word = 'KO';
    for (let y = 0; y < 7; y++) {
      for (let gx = 0; gx < 11; gx++) {
        const li = gx < 5 ? 0 : gx === 5 ? -1 : 1;
        if (li < 0) continue;
        if (FONT[word[li]][y][li === 0 ? gx : gx - 6] !== '1') continue;
        for (let py = 0; py < s; py++) for (let qx = 0; qx < s; qx++) {
          const x = ox + dx + gx * s + qx, y2 = oy + dy + y * s + py;
          if (x < 0 || y2 < 0 || x >= size || y2 >= size) continue;
          const i = (y2 * size + x) * 4;
          if (px[i + 3] === 0) continue;
          px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2];
          px[i + 3] = Math.max(px[i + 3], a);
        }
      }
    }
  };
  draw(Math.round(s * 0.18), Math.round(s * 0.28), SHADOW, 150); // sombra
  draw(0, 0, [255, 255, 255], 255);                              // letras
  // brillo superior sutil
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    if (!px[i + 3]) continue;
    const l = Math.max(0, 1 - y / (size * 0.55)) * 26;
    px[i] = Math.min(255, px[i] + l); px[i + 1] = Math.min(255, px[i + 1] + l); px[i + 2] = Math.min(255, px[i + 2] + l);
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['icon-180.png', 180]]) {
  fs.writeFileSync(path.join(OUT, name), makePng(size));
  console.log('✅', name, size + 'x' + size);
}
