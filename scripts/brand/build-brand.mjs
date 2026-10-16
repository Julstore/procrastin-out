// Genera TODOS los assets de marca desde el master del usuario (pixel-perfect, sin redibujar).
//
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/brand/decode-master.ps1
//   node scripts/brand/build-brand.mjs
//
// Entrada : scripts/brand/.master.rgba (RGBA crudo del logo-master.jpg)
// Salidas :
//   public/icon-512.png  icon-192.png  icon-180.png          tile recortado COMPLETO (nada cortado)
//   public/icon-real-*.png                                    los mismos (nombres heredados)
//   public/icon-maskable-512.png                              verde a sangre + marca + rótulo (para Android)
//   public/mark-real.png  label-real.png                      marca y rótulo con alfa, resolucion nativa
//   public/splash-bg.png                                      fondo del splash (pantalla del mockup sin logo)
//   public/splash-real.png                                    splash 1080x1920 (fondo + marca + rótulo)
//   tmp-inspect/brand-report.json                              medidas (fracciones) usadas por el CSS del splash
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PUB = path.join(ROOT, 'public');
const TMP = path.join(ROOT, 'tmp-inspect');

// ---------------- PNG (encode) ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filtro none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return out;
}
function savePng(file, w, h, rgba) {
  fs.writeFileSync(file, encodePng(w, h, rgba));
  console.log('SAVED', path.relative(ROOT, file), `${w}x${h}`, `${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

// ---------------- utilidades de imagen ----------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function rgbaAt(img, x, y) {
  const i = (y * img.w + x) * 4;
  return [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]];
}
function isGreen(r, g, b) { return g > r + 6 && g > b + 6 && g > 20; }
// verde "franco": sirve para medir el borde del tile sin comerse la sombra oscura del master
function isGreenSolid(r, g, b) { return g > r + 18 && g > b + 18 && g > 48; }
function isWhite(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return (r + g + b) / 3 >= 125 && mx - mn <= 70;
}
function isCopper(r, g, b) {
  return r >= 85 && r > g + 10 && g >= b - 16;
}
// cierra huecos chicos: dilatar y erosionar (deja la mascara sin poros)
function closeMask(img, mask, rad = 1) {
  const dil = new Uint8Array(img.w * img.h), out = new Uint8Array(img.w * img.h);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (!mask[y * img.w + x]) continue;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= img.h) continue;
        for (let dx = -rad; dx <= rad; dx++) { const xx = x + dx; if (xx < 0 || xx >= img.w) continue; dil[yy * img.w + xx] = 1; }
      }
    }
  }
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (!dil[y * img.w + x]) continue;
      let full = true;
      for (let dy = -rad; dy <= rad && full; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= img.h) { full = false; break; }
        for (let dx = -rad; dx <= rad; dx++) { const xx = x + dx; if (xx < 0 || xx >= img.w || !dil[yy * img.w + xx]) { full = false; break; } }
      }
      if (full) out[y * img.w + x] = 1;
    }
  }
  return out;
}
// Catmull-Rom: sube/baja de tamano manteniendo el alfa.
function resample(img, dw, dh) {
  const out = { w: dw, h: dh, px: new Uint8Array(dw * dh * 4) };
  const sx = img.w / dw, sy = img.h / dh;
  const kernel = (x) => {
    x = Math.abs(x);
    if (x < 1) return 1 - 2.5 * x * x + 1.5 * x * x * x;
    if (x < 2) return 2 - 4 * x + 2.5 * x * x - 0.5 * x * x * x;
    return 0;
  };
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const iy = Math.floor(fy);
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const ix = Math.floor(fx);
      let acc = [0, 0, 0, 0], wsum = 0;
      for (let ky = -1; ky <= 2; ky++) {
        const yy = clamp(iy + ky, 0, img.h - 1);
        const wy = kernel(fy - (iy + ky));
        if (wy === 0) continue;
        for (let kx = -1; kx <= 2; kx++) {
          const xx = clamp(ix + kx, 0, img.w - 1);
          const wgt = wy * kernel(fx - (ix + kx));
          if (wgt === 0) continue;
          const i = (yy * img.w + xx) * 4;
          acc[0] += img.px[i] * wgt; acc[1] += img.px[i + 1] * wgt;
          acc[2] += img.px[i + 2] * wgt; acc[3] += img.px[i + 3] * wgt;
          wsum += wgt;
        }
      }
      const o = (y * dw + x) * 4;
      out.px[o] = clamp(Math.round(acc[0] / wsum), 0, 255);
      out.px[o + 1] = clamp(Math.round(acc[1] / wsum), 0, 255);
      out.px[o + 2] = clamp(Math.round(acc[2] / wsum), 0, 255);
      out.px[o + 3] = clamp(Math.round(acc[3] / wsum), 0, 255);
    }
  }
  return out;
}
// Recorte cuadrado redondeado (esquinas transparentes) desde un tile.
function roundCrop(img, size, radius) {
  const out = { w: size, h: size, px: new Uint8Array(size * size * 4) };
  const scaled = resample(img, size, size);
  const r = Math.max(1, radius);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // distancia al cuadrado redondeado centrado en el tile
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      const d = Math.hypot(dx, dy);
      const a = clamp(r - d + 0.5, 0, 1); // borde suave de 1 px
      const i = (y * size + x) * 4;
      out.px[i] = scaled.px[i]; out.px[i + 1] = scaled.px[i + 1]; out.px[i + 2] = scaled.px[i + 2];
      out.px[i + 3] = Math.round(scaled.px[i + 3] * a);
    }
  }
  return out;
}
function subImage(img, x0, y0, w, h) {
  const out = { w, h, px: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4, d = (y * w + x) * 4;
      out.px[d] = img.px[s]; out.px[d + 1] = img.px[s + 1];
      out.px[d + 2] = img.px[s + 2]; out.px[d + 3] = img.px[s + 3];
    }
  }
  return out;
}
function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const s = (y * src.w + x) * 4, dx = ox + x, dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h) continue;
      const d = (dy * dst.w + dx) * 4;
      const a = src.px[s + 3] / 255;
      if (a <= 0) continue;
      dst.px[d] = Math.round(src.px[s] * a + dst.px[d] * (1 - a));
      dst.px[d + 1] = Math.round(src.px[s + 1] * a + dst.px[d + 1] * (1 - a));
      dst.px[d + 2] = Math.round(src.px[s + 2] * a + dst.px[d + 2] * (1 - a));
      dst.px[d + 3] = Math.max(dst.px[d + 3], src.px[s + 3]);
    }
  }
}
function newImage(w, h, r, g, b) {
  const img = { w, h, px: new Uint8Array(w * h * 4) };
  for (let i = 0; i < w * h; i++) {
    img.px[i * 4] = r; img.px[i * 4 + 1] = g; img.px[i * 4 + 2] = b; img.px[i * 4 + 3] = 255;
  }
  return img;
}

// ---------------- master ----------------
const meta = JSON.parse(fs.readFileSync(path.join(HERE, '.master.json'), 'utf8'));
const raw = fs.readFileSync(path.join(HERE, '.master.rgba'));
const master = { w: meta.w, h: meta.h, px: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) };
// GDI+ entrega BGRA en memoria: se intercambian R y B para trabajar en RGBA
for (let i = 0; i < master.px.length; i += 4) { const t = master.px[i]; master.px[i] = master.px[i + 2]; master.px[i + 2] = t; }
console.log('master', master.w + 'x' + master.h);

const report = {};

// ---------------- 1) tile del icono (mitad izquierda) ----------------
const halfW = Math.floor(master.w / 2);
const rowN = new Int32Array(master.h);
for (let y = 0; y < master.h; y++) {
  let n = 0;
  for (let x = 0; x < halfW; x++) { const [r, g, b] = rgbaAt(master, x, y); if (isGreen(r, g, b)) n++; }
  rowN[y] = n;
}
// primera pasada (verde franco): mide alto/ancho, segunda pasada: ya con el rango conocido
const THR = 40;
let top = -1, bot = -1;
for (let y = 0; y < master.h; y++) if (rowN[y] >= THR) { if (top < 0) top = y; bot = y; }
const colN = new Int32Array(halfW);
for (let x = 0; x < halfW; x++) {
  let n = 0;
  for (let y = top; y <= bot; y++) { const [r, g, b] = rgbaAt(master, x, y); if (isGreen(r, g, b)) n++; }
  colN[x] = n;
}
let left = -1, right = -1;
for (let x = 0; x < halfW; x++) if (colN[x] >= THR) { if (left < 0) left = x; right = x; }
// radio de esquina del tile (sobre la caja holgada, que es donde vive la curva)
let radius = 0;
for (let i = 0; i < Math.min(200, bot - top + 1); i++) {
  const y = top + i;
  for (let x = left; x < left + 260; x++) {
    const [r, g, b] = rgbaAt(master, x, y);
    if (isGreen(r, g, b)) { radius = Math.max(radius, x - left); break; }
  }
}
console.log('radio medido (caja holgada) =', radius);

// ajuste fino con verde franco: recorta la sombra/degradado oscuro que rodea al tile
{
  let t2 = -1, b2 = -1;
  for (let y = top; y <= bot; y++) {
    let n = 0;
    for (let x = left; x <= right; x++) { const [r, g, bl] = rgbaAt(master, x, y); if (isGreenSolid(r, g, bl)) n++; }
    if (n >= THR) { if (t2 < 0) t2 = y; b2 = y; }
  }
  let l2 = -1, r2 = -1;
  for (let x = left; x <= right; x++) {
    let n = 0;
    for (let y = t2; y <= b2; y++) { const [r, g, bl] = rgbaAt(master, x, y); if (isGreenSolid(r, g, bl)) n++; }
    if (n >= THR) { if (l2 < 0) l2 = x; r2 = x; }
  }
  if (t2 >= 0 && l2 >= 0) {
    console.log(`ajuste fino: x=${l2}..${r2} y=${t2}..${b2} (antes ${left}..${right} / ${top}..${bot})`);
    left = l2; right = r2; top = t2; bot = b2;
  }
}
const tw = right - left + 1, th = bot - top + 1;
console.log(`tile x=${left}..${right} y=${top}..${bot} (${tw}x${th}) radio=${radius}`);
// 2 px de aire: el tile del mockup tiene un filo oscuro (JPEG) que no queremos en el icono
const AIR = 2;
const tile = subImage(master, left + AIR, top + AIR, tw - 2 * AIR, th - 2 * AIR);

// ---------------- 2) marca y rotulo (alfa, resolucion nativa) ----------------
function markMask(img, opts = {}) {
  const m = new Uint8Array(img.w * img.h);
  const minLum = opts.minLum ?? 125, maxSat = opts.maxSat ?? 70;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const [r, g, b] = rgbaAt(img, x, y);
      if (isGreen(r, g, b)) continue;                     // fondo verde del tile -> fuera
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const whiteOk = (r + g + b) / 3 >= minLum && mx - mn <= maxSat;
      if (whiteOk || isCopper(r, g, b)) m[y * img.w + x] = 1;
    }
  }
  return closeMask(img, m, opts.close ?? 1);
}
function bboxOf(mask, img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (!mask[y * img.w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
// Agrupa filas con pixeles marcados; une huecos chicos (las flechas tienen aire entre si)
// y descarta grupos raquiticоs que son solo brillos sueltos del fondo.
function rowClusters(mask, img, gap = 6, minPixels = 1) {
  const counts = new Int32Array(img.h);
  for (let y = 0; y < img.h; y++) { let n = 0; for (let x = 0; x < img.w; x++) if (mask[y * img.w + x]) n++; counts[y] = n; }
  const raw = [];
  let run = -1, last = -1;
  for (let y = 0; y < img.h; y++) {
    if (counts[y] > 0) {
      if (run < 0) run = y;
      else if (y - last > gap) { raw.push([run, last]); run = y; }
      last = y;
    }
  }
  if (run >= 0) raw.push([run, last]);
  return raw.filter(([a, b]) => {
    let n = 0;
    for (let y = a; y <= b; y++) n += counts[y];
    return n >= minPixels;
  });
}
function maskToAlpha(img, mask) {
  const out = { w: img.w, h: img.h, px: new Uint8Array(img.w * img.h * 4) };
  for (let i = 0; i < img.w * img.h; i++) {
    const a = mask[i] ? 255 : 0;
    out.px[i * 4] = img.px[i * 4]; out.px[i * 4 + 1] = img.px[i * 4 + 1];
    out.px[i * 4 + 2] = img.px[i * 4 + 2]; out.px[i * 4 + 3] = a;
  }
  return out;
}
const tmask = markMask(tile);                                   // marca: blanca o cobre
const labelMaskAll = markMask(tile, { minLum: 95, maxSat: 90, close: 2 }); // rótulo: letras con sombra suave
const tclusters = rowClusters(tmask, tile, 20, 40);
console.log('tile clusters (marca/rotulo):', tclusters.map((c) => `[${c[0]}..${c[1]}]`).join(' '));
const markRow = tclusters[0];
const labelRow = tclusters[1] || [tile.h - 1, tile.h - 1];
function clusterBox(mask, img, ya, yb) {
  let x0 = img.w, x1 = -1;
  for (let y = ya; y <= yb; y++) for (let x = 0; x < img.w; x++) if (mask[y * img.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  return { x0, x1, y0: ya, y1: yb, w: x1 - x0 + 1, h: yb - ya + 1 };
}
const tMarkBox = clusterBox(tmask, tile, markRow[0], markRow[1]);
const tLabelBox = clusterBox(labelMaskAll, tile, labelRow[0], labelRow[1]);
console.log('marca tile', JSON.stringify(tMarkBox), 'rotulo tile', JSON.stringify(tLabelBox));

// marca/rotulo con alfa (recortados justo, +2 px de aire)
function tightAlpha(img, mask, box, pad = 2) {
  const x0 = clamp(box.x0 - pad, 0, img.w - 1), y0 = clamp(box.y0 - pad, 0, img.h - 1);
  const x1 = clamp(box.x1 + pad, 0, img.w - 1), y1 = clamp(box.y1 + pad, 0, img.h - 1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = { w, h, px: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y;
      const on = mask[sy * img.w + sx];
      const d = (y * w + x) * 4, s = (sy * img.w + sx) * 4;
      out.px[d] = img.px[s]; out.px[d + 1] = img.px[s + 1]; out.px[d + 2] = img.px[s + 2];
      out.px[d + 3] = on ? 255 : 0;
    }
  }
  return out;
}
const markImg = tightAlpha(tile, tmask, tMarkBox, 2);
// el rotulo es texto blanco sobre el verde del tile: se saca con un matte suave por luminancia
// (letras con antialias, sin poros) y se des-mezcla el verde para que quede blanco limpio.
function labelMatte(img) {
  const out = { w: img.w, h: img.h, px: new Uint8Array(img.w * img.h * 4) };
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const [r, g, b] = rgbaAt(img, x, y);
      const lum = (r + g + b) / 3;
      let a = Math.round((lum - 72) * 3.3);
      a = clamp(a, 0, 255);
      if (isGreen(r, g, b) && lum < 110) a = 0;
      const f = a > 0 ? 255 / a : 0;
      // el rotulo de la marca es blanco: se des-mezcla el verde y se empuja hacia blanco limpio
      const white = (v) => clamp(Math.round((clamp(v * f, 0, 255) * 0.55) + 255 * 0.45), 0, 255);
      const o = (y * img.w + x) * 4;
      out.px[o] = white(r);
      out.px[o + 1] = white(g);
      out.px[o + 2] = white(b);
      out.px[o + 3] = a;
    }
  }
  return out;
}
const labelMatteImg = labelMatte(tile);
const labelImg = (() => {
  let x0 = tile.w, x1 = -1, y0 = tile.h, y1 = -1;
  for (let y = labelRow[0]; y <= labelRow[1]; y++) {
    for (let x = 0; x < tile.w; x++) {
      if (labelMatteImg.px[(y * tile.w + x) * 4 + 3] < 16) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const pad = 2;
  const bx0 = clamp(x0 - pad, 0, tile.w - 1), by0 = clamp(y0 - pad, 0, tile.h - 1);
  const bx1 = clamp(x1 + pad, 0, tile.w - 1), by1 = clamp(y1 + pad, 0, tile.h - 1);
  return subImage(labelMatteImg, bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1);
})();
savePng(path.join(PUB, 'mark-real.png'), markImg.w, markImg.h, markImg.px);
savePng(path.join(PUB, 'label-real.png'), labelImg.w, labelImg.h, labelImg.px);

// ---------------- 3) iconos (tile completo, con esquinas redondeadas) ----------------
// el radio del mask va un pelo mas grande que el del tile: asi se recorta el filo oscuro
// que deja el JPEG del master en el borde del tile (sin cortar nada del contenido).
const radius512 = Math.round((radius + AIR + 2) * (512 / tile.w));
const icon512 = roundCrop(tile, 512, radius512);
savePng(path.join(PUB, 'icon-real-512.png'), 512, 512, icon512.px);
savePng(path.join(PUB, 'icon-512.png'), 512, 512, icon512.px);
for (const s of [192, 180]) {
  const r = Math.max(4, Math.round((radius + AIR + 2) * (s / tile.w)));
  const im = roundCrop(tile, s, r);
  savePng(path.join(PUB, `icon-real-${s}.png`), s, s, im.px);
  savePng(path.join(PUB, `icon-${s}.png`), s, s, im.px);
}

// ---------------- 4) icono maskable: verde a sangre + marca + rotulo (Android) ----------------
// fondo: por fila, el color del borde del tile (columnas "espina", dentro de las esquinas)
const maskSize = 512;
const maskIcon = { w: maskSize, h: maskSize, px: new Uint8Array(maskSize * maskSize * 4) };
for (let y = 0; y < maskSize; y++) {
  const sy = clamp(Math.round((y / (maskSize - 1)) * (tile.h - 1)), 0, tile.h - 1);
  const lx = clamp(radius + 3, 0, tile.w - 1), rx = clamp(tile.w - radius - 4, 0, tile.w - 1);
  const a = rgbaAt(tile, lx, sy), b = rgbaAt(tile, rx, sy);
  const rr = Math.round((a[0] + b[0]) / 2), gg = Math.round((a[1] + b[1]) / 2), bb = Math.round((a[2] + b[2]) / 2);
  for (let x = 0; x < maskSize; x++) {
    const i = (y * maskSize + x) * 4;
    maskIcon.px[i] = rr; maskIcon.px[i + 1] = gg; maskIcon.px[i + 2] = bb; maskIcon.px[i + 3] = 255;
  }
}
const contentScale = 0.80; // el contenido vive dentro de la zona segura del icono adaptativo
const innerSize = Math.round(maskSize * contentScale);
const tileScaled = roundCrop(tile, innerSize, Math.round((radius + AIR + 2) * (innerSize / tile.w)));
blit(maskIcon, tileScaled, Math.round((maskSize - tileScaled.w) / 2), Math.round((maskSize - tileScaled.h) / 2));
savePng(path.join(PUB, 'icon-maskable-512.png'), maskSize, maskSize, maskIcon.px);

// color del borde del maskable (para background_color del manifest: el splash de Android queda sin costura)
{
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = 0; y < maskSize; y++) {
    for (const x of [2, 6, maskSize - 3, maskSize - 7]) {
      const i = (y * maskSize + x) * 4;
      sr += maskIcon.px[i]; sg += maskIcon.px[i + 1]; sb += maskIcon.px[i + 2]; n++;
    }
  }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  report.maskableEdgeColor = `#${hex(sr)}${hex(sg)}${hex(sb)}`;
  console.log('maskable borde =', report.maskableEdgeColor);
}

// ---------------- 5) pantalla del mockup (telefono): fondo sin logo ----------------
const rightStart = Math.floor(master.w / 2) + 1;
const sRowN = new Int32Array(master.h), sColN = new Int32Array(master.w);
for (let y = 0; y < master.h; y++) {
  let n = 0;
  for (let x = rightStart; x < master.w; x++) { const [r, g, b] = rgbaAt(master, x, y); if (isGreen(r, g, b)) n++; }
  sRowN[y] = n;
}
for (let x = rightStart; x < master.w; x++) {
  let n = 0;
  for (let y = 0; y < master.h; y++) { const [r, g, b] = rgbaAt(master, x, y); if (isGreen(r, g, b)) n++; }
  sColN[x] = n;
}
let sTop = -1, sBot = -1, sLeft = -1, sRight = -1;
for (let y = 0; y < master.h; y++) if (sRowN[y] >= 20) { if (sTop < 0) sTop = y; sBot = y; }
for (let x = rightStart; x < master.w; x++) if (sColN[x] >= 20) { if (sLeft < 0) sLeft = x; sRight = x; }
const INSET = 13;
const sx0 = sLeft + INSET, sy0 = sTop + INSET;
const sw = sRight - sLeft + 1 - 2 * INSET, sh = sBot - sTop + 1 - 2 * INSET;
console.log(`pantalla x=${sLeft}..${sRight} y=${sTop}..${sBot} -> crop ${sw}x${sh} en (${sx0},${sy0})`);
const screen = subImage(master, sx0, sy0, sw, sh);

// mascara por contraste local: la marca/rotulo son nitidos, el resplandor es suave
const R = new Float32Array(sw * sh), G = new Float32Array(sw * sh), B = new Float32Array(sw * sh);
for (let i = 0; i < sw * sh; i++) { R[i] = screen.px[i * 4]; G[i] = screen.px[i * 4 + 1]; B[i] = screen.px[i * 4 + 2]; }
function boxBlur(src, w, h, rad) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const win = 2 * rad + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += src[y * w + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win;
      sum -= src[y * w + clamp(x - rad, 0, w - 1)];
      sum += src[y * w + clamp(x + rad + 1, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum -= tmp[clamp(y - rad, 0, h - 1) * w + x];
      sum += tmp[clamp(y + rad + 1, 0, h - 1) * w + x];
    }
  }
  return out;
}
const br = boxBlur(R, sw, sh, 8), bg = boxBlur(G, sw, sh, 8), bb = boxBlur(B, sw, sh, 8);
const EDGE = 14;    // margen lateral: fuera queda el bisel y las esquinas negras
const TOPCUT = 70;  // arriba queda la muesca del telefono (negro), que no es arte
const cand = new Uint8Array(sw * sh);
for (let y = TOPCUT; y < sh - EDGE; y++) {
  for (let x = EDGE; x < sw - EDGE; x++) {
    const i = y * sw + x;
    if ((R[i] + G[i] + B[i]) / 3 < 60) continue; // negro del bisel/muesca: no es arte
    const d = Math.max(Math.abs(R[i] - br[i]), Math.abs(G[i] - bg[i]), Math.abs(B[i] - bb[i]));
    if (d > 24) cand[i] = 1;
  }
}
// dilatar (cubre sombras y huecos internos de la marca)
function dilateMask(src, rad) {
  const dst = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (!src[y * sw + x]) continue;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= sh) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= sw) continue;
          dst[yy * sw + xx] = 1;
        }
      }
    }
  }
  return dst;
}
const mask = dilateMask(cand, 12);      // para tapar (cubre la sombra de la marca)
const maskTight = dilateMask(cand, 3);  // para medir (cajas ajustadas)
// bisel, esquinas del telefono y muesca: negro rotundo pegado al borde del recorte -> se tapa y se rellena
for (let y = 0; y < sh; y++) {
  for (let x = 0; x < sw; x++) {
    const i = y * sw + x;
    if ((R[i] + G[i] + B[i]) / 3 >= 50) continue;
    const borde = y < 78 || y >= sh - 6 || x < 8 || x >= sw - 8;
    if (borde) mask[i] = 1;
  }
}
// clusters de la mascara -> rectangulos de marca y rotulo (para las fracciones del CSS)
const DEBUG = !!process.env.BRAND_DEBUG;
if (DEBUG) {
  const cnt = new Int32Array(sh);
  for (let y = 0; y < sh; y++) { let n = 0; for (let x = 0; x < sw; x++) if (mask[y * sw + x]) n++; cnt[y] = n; }
  let line = '';
  for (let y = 0; y < sh; y++) line += (y % 5 === 0 ? `\n${String(y).padStart(3)}: ` : '') + cnt[y].toString().padStart(3) + ' ';
  console.log('perfil de filas de la mascara:', line);
}
// marca = el grupo mas grande; rotulo = la banda fina y ancha que queda por debajo
const mclusters = rowClusters(maskTight, screen, 6, 40).map(([a, b]) => {
  const box = clusterBox(maskTight, screen, a, b);
  let n = 0;
  for (let y = a; y <= b; y++) for (let x = 0; x < sw; x++) if (maskTight[y * sw + x]) n++;
  return { ...box, n };
});
console.log('grupos medidos:', mclusters.map((c) => `y=${c.y0}..${c.y1} x=${c.x0}..${c.x1} n=${c.n}`).join(' | '));
const screenMark = mclusters.slice().sort((a, b) => b.n - a.n)[0];
const screenLabel = mclusters.filter((c) => c.y0 > screenMark.y1 && c.h <= 40).sort((a, b) => b.w - a.w)[0] || null;
report.screen = { w: sw, h: sh };
report.mark = {
  cx: +(((screenMark.x0 + screenMark.x1) / 2) / sw).toFixed(4),
  cy: +(((screenMark.y0 + screenMark.y1) / 2) / sh).toFixed(4),
  w: +((screenMark.w / sw)).toFixed(4),
};
if (screenLabel) {
  report.label = {
    cx: +(((screenLabel.x0 + screenLabel.x1) / 2) / sw).toFixed(4),
    cy: +(((screenLabel.y0 + screenLabel.y1) / 2) / sh).toFixed(4),
    w: +((screenLabel.w / sw)).toFixed(4),
  };
}
console.log('fracciones marca', JSON.stringify(report.mark), 'rotulo', JSON.stringify(report.label || null));

// relleno por Shepard (1/d^2) desde el anillo de pixeles que rodea la mascara:
// el relleno se pega al color del borde y queda un degradado suave, sin placas planas.
const ring = [];
for (let y = 1; y < sh - 1; y++) {
  for (let x = 1; x < sw - 1; x++) {
    const i = y * sw + x;
    if (mask[i]) continue;
    if (!(mask[i - 1] || mask[i + 1] || mask[i - sw] || mask[i + sw])) continue;
    ring.push(x, y, R[i], G[i], B[i]);
  }
}
function sampleGrid(x, y) {
  let sr = 0, sg = 0, sb = 0, wsum = 0;
  for (let k = 0; k < ring.length; k += 5) {
    const dx = ring[k] - x, dy = ring[k + 1] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 120 * 120) continue;
    const wgt = 1 / (d2 + 1);
    sr += ring[k + 2] * wgt; sg += ring[k + 3] * wgt; sb += ring[k + 4] * wgt; wsum += wgt;
  }
  if (!wsum) return [R[y * sw + x], G[y * sw + x], B[y * sw + x]];
  return [sr / wsum, sg / wsum, sb / wsum];
}
// distancia aproximada a la mascara (3 dilataciones) -> pluma
const d1 = new Uint8Array(sw * sh), d2 = new Uint8Array(sw * sh), d3 = new Uint8Array(sw * sh);
d1.set(mask);
for (const [src, dst, rad] of [[mask, d1, 2], [d1, d2, 4], [d2, d3, 8]]) { const o = dilateMask(src, rad); dst.set(o); }
const bgOnly = { w: sw, h: sh, px: new Uint8Array(sw * sh * 4) };
for (let y = 0; y < sh; y++) {
  for (let x = 0; x < sw; x++) {
    const i = y * sw + x, o = i * 4;
    const [rr, gg, bb2] = sampleGrid(x, y);
    let a = 0;
    if (mask[i]) a = 1; else if (d1[i]) a = 0.70; else if (d2[i]) a = 0.40; else if (d3[i]) a = 0.16;
    bgOnly.px[o] = Math.round(rr * a + screen.px[o] * (1 - a));
    bgOnly.px[o + 1] = Math.round(gg * a + screen.px[o + 1] * (1 - a));
    bgOnly.px[o + 2] = Math.round(bb2 * a + screen.px[o + 2] * (1 - a));
    bgOnly.px[o + 3] = 255;
  }
}
// suavizado leve: saca el grano del JPEG del master (mejor compresion y degradado limpio)
const smooth = { w: sw, h: sh, px: new Uint8Array(sw * sh * 4) };
for (let c = 0; c < 3; c++) {
  const ch = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) ch[i] = bgOnly.px[i * 4 + c];
  const bl = boxBlur(ch, sw, sh, 2);
  for (let i = 0; i < sw * sh; i++) smooth.px[i * 4 + c] = Math.round(bl[i]);
}
for (let i = 0; i < sw * sh; i++) smooth.px[i * 4 + 3] = 255;

// fondo del splash para la app (2.5x, nitido y liviano)
const webBg = resample(smooth, Math.round(sw * 2), Math.round(sh * 2));
savePng(path.join(PUB, 'splash-bg.png'), webBg.w, webBg.h, webBg.px);

// ---------------- 6) splash-real.png 1080x1920 (iOS / respaldo) ----------------
const SW = 1080, SH = 1920;
const splash = resample(smooth, SW, SH);
const k = SW / sw; // escala de la pantalla del mockup al lienzo del splash
const markScaled = resample(markImg, Math.round(screenMark.w * k), Math.round(screenMark.h * k));
blit(splash, markScaled, Math.round((screenMark.x0 + screenMark.x1) / 2 * k - markScaled.w / 2), Math.round((screenMark.y0 + screenMark.y1) / 2 * k - markScaled.h / 2));
if (screenLabel) {
  // el rotulo real del tile mantiene la nitidez; se ubica donde el mockup lo muestra
  const labelScaled = resample(labelImg, Math.round(screenLabel.w * k), Math.round(screenLabel.w * k * labelImg.h / labelImg.w));
  blit(splash, labelScaled, Math.round((screenLabel.x0 + screenLabel.x1) / 2 * k - labelScaled.w / 2), Math.round((screenLabel.y0 + screenLabel.y1) / 2 * k - labelScaled.h / 2));
}
savePng(path.join(PUB, 'splash-real.png'), SW, SH, splash.px);

fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'brand-report.json'), JSON.stringify(report, null, 2));
console.log('REPORT', JSON.stringify(report));
