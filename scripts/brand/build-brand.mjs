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
//   public/mark-real.png  label-real.png                      marca y rótulo con alfa, exportados a
//                                                            resolucion de pantalla de celular (1080 / 1200)
//   public/splash-bg.png                                      fondo del splash, degradado liso generado desde
//                                                            la pantalla del mockup (sin bloques del JPEG)
//   public/splash-real.png                                    splash completo (fondo + marca + rótulo)
//
// Ajustes por variable de entorno (para probar variantes):
//   MARK_W, LABEL_W (ancho de export), BG_W (ancho del fondo), SPLASH_W (ancho del splash completo),
//   FIELD_W (detalle del degradado de fondo: mas alto = mas fiel), BG_DITHER=0 (sin dithering).
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
// Filtro de PNG por fila (se elige el que menos bits ocupa): con esto la marca y el fondo
// pesan la mitad y se puede exportar a resolucion de pantalla sin inflar la descarga.
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function encodePng(w, h, rgba) {
  const BPP = 4, stride = w * BPP;
  const raw = Buffer.alloc((stride + 1) * h);
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    cur.set(Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= BPP ? cur[i - BPP] : 0, b = prev[i], c = i >= BPP ? prev[i - BPP] : 0, x = cur[i];
      cand[0][i] = x;
      cand[1][i] = (x - a) & 255;
      cand[2][i] = (x - b) & 255;
      cand[3][i] = (x - ((a + b) >> 1)) & 255;
      cand[4][i] = (x - paeth(a, b, c)) & 255;
    }
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let s = 0;
      const c = cand[f];
      for (let i = 0; i < stride; i++) { const v = c[i]; s += v < 128 ? v : 256 - v; }
      if (s < bestScore) { bestScore = s; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
    prev.set(cur);
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
// Luz lineal (sRGB <-> lineal): interpolar y promediar en lineal es lo que hace que al agrandar
// o reducir no se oscurezcan los bordes ni aparezcan franjas.
const TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const v = i / 255; TO_LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
const toLin = (v) => TO_LIN[v < 0 ? 0 : v > 255 ? 255 : v | 0];
function linToSrgb(l) {
  if (!(l > 0)) return 0;
  const v = l >= 1 ? 1 : l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return clamp(Math.round(v * 255), 0, 255);
}
// Mosaico Bayer 8x8 (dithering ordenado): rompe los escalones de color del degradado sin verse.
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
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
// Saca el ruido de bloques del JPEG sin tocar los bordes: si el pixel no se diferencia de sus
// vecinos (zona plana) se promedia; si hay contraste (borde de la marca) se deja intacto.
function deblock(img, tol = 14) {
  const out = { w: img.w, h: img.h, px: new Uint8Array(img.px) };
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const here = img.px[i + c];
        let s = 0, n = 0, mx = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= img.h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= img.w) continue;
            const v = img.px[(yy * img.w + xx) * 4 + c];
            s += v; n++;
            const d = Math.abs(v - here); if (d > mx) mx = d;
          }
        }
        out.px[i + c] = mx <= tol ? Math.round(s / n) : here;
      }
    }
  }
  return out;
}
// Mapa del verde que hay DETRAS de la marca: promedio de los pixeles verdes del tile con un
// desenfoque grande, normalizado por la cantidad de verdes de cada zona. El fondo es un
// degradado suave, asi que esto reconstruye el verde real que tapa la marca.
function bgMap(img, radius = 48) {
  const n = img.w * img.h;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let gr = 0, gg = 0, gb = 0, gn = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      const [r, g, b] = rgbaAt(img, x, y);
      if (!isGreen(r, g, b)) continue;
      ch[0][i] = r; ch[1][i] = g; ch[2][i] = b; ch[3][i] = 1;
      gr += r; gg += g; gb += b; gn++;
    }
  }
  const bl = ch.map((c) => boxBlur(c, img.w, img.h, radius));
  const fr = gn ? gr / gn : 90, fg = gn ? gg / gn : 120, fb = gn ? gb / gn : 80;
  const out = { w: img.w, h: img.h, px: new Uint8Array(n * 3) };
  for (let i = 0; i < n; i++) {
    const wsum = bl[3][i];
    const ok = wsum > 1e-3;
    out.px[i * 3] = ok ? clamp(Math.round(bl[0][i] / wsum), 0, 255) : Math.round(fr);
    out.px[i * 3 + 1] = ok ? clamp(Math.round(bl[1][i] / wsum), 0, 255) : Math.round(fg);
    out.px[i * 3 + 2] = ok ? clamp(Math.round(bl[2][i] / wsum), 0, 255) : Math.round(fb);
  }
  return out;
}
// Reescalado de alta calidad para exportar el arte a resolucion de pantalla:
// Lanczos-3 (bordes definidos al agrandar) + mascara de enfoque suave.
function resampleHQ(img, dw, dh, opts = {}) {
  const a = 3;
  const lanczos = (x) => {
    x = Math.abs(x);
    if (x < 1e-6) return 1;
    if (x >= a) return 0;
    const px = Math.PI * x;
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
  };
  const out = { w: dw, h: dh, px: new Uint8Array(dw * dh * 4) };
  const sx = img.w / dw, sy = img.h / dh;
  const tmp = new Float32Array(dw * img.h * 4);
  // Se interpola en luz lineal y con ALFA PREMULTIPLICADO: asi un pixel casi transparente no
  // aporta su color (que es una mezcla con el verde del fondo) y el borde sale limpio, sin el
  // halo grisaceo/verdoso que dejaba el filtro clasico al agrandar la marca.
  const lin = new Float32Array(img.w * img.h * 3), alp = new Float32Array(img.w * img.h);
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.px[i * 4 + 3] / 255;
    alp[i] = a;
    lin[i * 3] = toLin(img.px[i * 4]) * a;
    lin[i * 3 + 1] = toLin(img.px[i * 4 + 1]) * a;
    lin[i * 3 + 2] = toLin(img.px[i * 4 + 2]) * a;
  }
  // horizontal
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const ix = Math.floor(fx);
      let acc = [0, 0, 0, 0], wsum = 0;
      for (let k = ix - a + 1; k <= ix + a; k++) {
        const w = lanczos(fx - k);
        if (w === 0) continue;
        const xx = clamp(k, 0, img.w - 1), i = (y * img.w + xx) * 3, p = y * img.w + xx;
        acc[0] += lin[i] * w; acc[1] += lin[i + 1] * w; acc[2] += lin[i + 2] * w; acc[3] += alp[p] * w;
        wsum += w;
      }
      for (let c = 0; c < 4; c++) tmp[(y * dw + x) * 4 + c] = acc[c] / wsum;
    }
  }
  // vertical
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const iy = Math.floor(fy);
    for (let x = 0; x < dw; x++) {
      let acc = [0, 0, 0, 0], wsum = 0;
      for (let k = iy - a + 1; k <= iy + a; k++) {
        const w = lanczos(fy - k);
        if (w === 0) continue;
        const yy = clamp(k, 0, img.h - 1), t = (yy * dw + x) * 4;
        acc[0] += tmp[t] * w; acc[1] += tmp[t + 1] * w; acc[2] += tmp[t + 2] * w; acc[3] += tmp[t + 3] * w;
        wsum += w;
      }
      const o = (y * dw + x) * 4;
      const A = wsum !== 0 ? acc[3] / wsum : 0;
      if (A <= 1e-4 || acc[3] <= 1e-9) {
        out.px[o] = 0; out.px[o + 1] = 0; out.px[o + 2] = 0; out.px[o + 3] = 0;
      } else {
        // se des-premultiplica: el color vuelve a ser el de la marca, sin la mezcla del fondo
        out.px[o] = linToSrgb(acc[0] / acc[3]);
        out.px[o + 1] = linToSrgb(acc[1] / acc[3]);
        out.px[o + 2] = linToSrgb(acc[2] / acc[3]);
        out.px[o + 3] = clamp(Math.round(A * 255), 0, 255);
      }
    }
  }
  // mascara de enfoque (sobre el color; el alfa se deja suave para no cortar el antialias)
  const amount = opts.sharpen ?? 0;
  if (amount <= 0) return out;
  const gauss = { w: dw, h: dh, px: new Uint8Array(dw * dh * 4) };
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(dw * dh);
    for (let i = 0; i < dw * dh; i++) ch[i] = out.px[i * 4 + c];
    const bl = boxBlur(ch, dw, dh, Math.max(1, Math.round(opts.radius || 1)));
    for (let i = 0; i < dw * dh; i++) gauss.px[i * 4 + c] = clamp(Math.round(bl[i]), 0, 255);
  }
  for (let i = 0; i < dw * dh; i++) {
    for (let c = 0; c < 3; c++) {
      const v = out.px[i * 4 + c] + amount * (out.px[i * 4 + c] - gauss.px[i * 4 + c]);
      out.px[i * 4 + c] = clamp(Math.round(v), 0, 255);
    }
  }
  return out;
}

// Recorte cuadrado redondeado (esquinas transparentes) desde un tile.
function roundCrop(img, size, radius, opts = {}) {
  const out = { w: size, h: size, px: new Uint8Array(size * size * 4) };
  const scaled = resampleHQ(img, size, size, opts);
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
// MATE SUAVE: el alfa sale de una confianza continua (blanco o cobre) en vez de un
// 0/255 duro. Así el borde queda con antialias y al agrandar no se ven escalones.
// El color se des-mezcla del verde del tile para que la marca salga limpia.
function softMatte(img, bg, opts = {}) {
  const w = img.w, h = img.h;
  const a = new Float32Array(w * h);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const [r, g, b] = rgbaAt(img, x, y);
      const lum = (r + g + b) / 3;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      // blanco del infinito: brillante y poco saturado
      const aw = clamp((lum - (opts.whiteFrom ?? 92)) / 108, 0, 1) * clamp((70 - sat) / 30, 0, 1);
      // cobre de las flechas: rojo dominante y con cuerpo
      const ac = clamp((r - g - 10) / 45, 0, 1) * clamp((r - (opts.copperFrom ?? 70)) / 70, 0, 1);
      let alpha = Math.max(aw, ac);
      if (isGreen(r, g, b)) alpha = 0; // fondo verde del tile
      a[i] = alpha;
      // Des-mezcla CONTRA EL VERDE REAL que hay detras (bg): el pixel es marca*alpha + fondo*(1-alpha),
      // asi que la marca sale limpia y el borde no arrastra color del fondo.
      const j = i * 3;
      const f = alpha > 0.02 ? 1 / alpha : 0;
      // Donde el alfa es bajo el des-mezclado se dispara (satura a rojo/negro segun el ruido del
      // JPEG). Se mezcla con el color real del pixel segun la confianza en el alfa: asi el borde
      // queda limpio y sin fleco.
      const t = clamp((alpha - 0.3) / 0.35, 0, 1);
      const unmix = (raw, bv) => clamp(Math.round(raw * (1 - t) + (raw - (1 - alpha) * bv) * f * t), 0, 255);
      rgb[j] = unmix(r, bg.px[j]);
      rgb[j + 1] = unmix(g, bg.px[j + 1]);
      rgb[j + 2] = unmix(b, bg.px[j + 2]);
    }
  }
  // suavizado del matte (no del color) para redondear el borde
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          s += a[yy * w + xx]; n++;
        }
      }
      blur[y * w + x] = s / n;
    }
  }
  const out = { w, h, px: new Uint8Array(w * h * 4) };
  for (let i = 0; i < w * h; i++) {
    out.px[i * 4] = rgb[i * 3];
    out.px[i * 4 + 1] = rgb[i * 3 + 1];
    out.px[i * 4 + 2] = rgb[i * 3 + 2];
    out.px[i * 4 + 3] = clamp(Math.round(blur[i] * 255), 0, 255);
  }
  return out;
}
// recorta respetando el alfa (sin volverlo binario)
function tightCrop(img, box, pad = 2) {
  const x0 = clamp(box.x0 - pad, 0, img.w - 1), y0 = clamp(box.y0 - pad, 0, img.h - 1);
  const x1 = clamp(box.x1 + pad, 0, img.w - 1), y1 = clamp(box.y1 + pad, 0, img.h - 1);
  return subImage(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
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
const tileClean = deblock(tile);            // sin ruido de bloques del JPEG (se ve enorme en el celu)
const tileBg = bgMap(tileClean, 48);        // el verde real que hay detras de la marca
const tmask = markMask(tileClean);                                   // marca: blanca o cobre
const labelMaskAll = markMask(tileClean, { minLum: 95, maxSat: 90, close: 2 }); // rótulo: letras con sombra suave
const tclusters = rowClusters(tmask, tileClean, 20, 40);
console.log('tile clusters (marca/rotulo):', tclusters.map((c) => `[${c[0]}..${c[1]}]`).join(' '));
const markRow = tclusters[0];
const labelRow = tclusters[1] || [tile.h - 1, tile.h - 1];
function clusterBox(mask, img, ya, yb) {
  let x0 = img.w, x1 = -1;
  for (let y = ya; y <= yb; y++) for (let x = 0; x < img.w; x++) if (mask[y * img.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  return { x0, x1, y0: ya, y1: yb, w: x1 - x0 + 1, h: yb - ya + 1 };
}
const tMarkBox = clusterBox(tmask, tileClean, markRow[0], markRow[1]);
const tLabelBox = clusterBox(labelMaskAll, tileClean, labelRow[0], labelRow[1]);
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
// Se exportan ya agrandados al tamaño en que se ven en pantalla (el celu no tiene que
// estirar una imagen chica): Lanczos-3 + enfoque suave.
const MARK_W = Number(process.env.MARK_W || 1080);
const LABEL_W = Number(process.env.LABEL_W || 1200);
const markSmall = tightCrop(softMatte(tileClean, tileBg), tMarkBox, 2);
// el rotulo es texto blanco sobre el verde del tile: se saca con un matte suave por luminancia
// (letras con antialias, sin poros) y se des-mezcla el verde para que quede blanco limpio.
function labelMatte(img, bg) {
  const out = { w: img.w, h: img.h, px: new Uint8Array(img.w * img.h * 4) };
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x, j = i * 3;
      const [r, g, b] = rgbaAt(img, x, y);
      const lum = (r + g + b) / 3;
      let a = Math.round((lum - 72) * 3.3);
      a = clamp(a, 0, 255);
      if (isGreen(r, g, b) && lum < 110) a = 0;
      const alpha = a / 255;
      const f = alpha > 0.02 ? 1 / alpha : 0;
      // el rotulo de la marca es blanco: se des-mezcla contra el verde real que hay detras y se
      // empuja hacia blanco limpio (asi el texto no queda translucido ni con fleco verdoso)
      const t = clamp((alpha - 0.3) / 0.35, 0, 1);
      const white = (v, bv) => clamp(Math.round((v * (1 - t) + (v - (1 - alpha) * bv) * f * t) * 0.72 + 255 * 0.28), 0, 255);
      const o = i * 4;
      out.px[o] = white(r, bg.px[j]);
      out.px[o + 1] = white(g, bg.px[j + 1]);
      out.px[o + 2] = white(b, bg.px[j + 2]);
      out.px[o + 3] = a;
    }
  }
  return out;
}
const labelMatteImg = labelMatte(tileClean, tileBg);
const labelSmall = (() => {
  const base = (() => {
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
  // mismo suavizado de alfa que la marca, para que el texto no muestre escalones
  const s = { w: base.w, h: base.h, px: new Uint8Array(base.w * base.h * 4) };
  const A = new Float32Array(base.w * base.h);
  for (let i = 0; i < base.w * base.h; i++) A[i] = base.px[i * 4 + 3] / 255;
  for (let y = 0; y < base.h; y++) {
    for (let x = 0; x < base.w; x++) {
      let acc = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= base.h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= base.w) continue;
          acc += A[yy * base.w + xx]; n++;
        }
      }
      const i = y * base.w + x;
      s.px[i * 4] = base.px[i * 4]; s.px[i * 4 + 1] = base.px[i * 4 + 1]; s.px[i * 4 + 2] = base.px[i * 4 + 2];
      s.px[i * 4 + 3] = clamp(Math.round((acc / n) * 255), 0, 255);
    }
  }
  return s;
})();
// El radio del enfoque crece con el agrandado (si no, se ve blando al mirarlo de cerca).
const markImg = resampleHQ(markSmall, MARK_W, Math.round(MARK_W * markSmall.h / markSmall.w), { sharpen: 0.7, radius: 2 });
const labelImg = resampleHQ(labelSmall, LABEL_W, Math.round(LABEL_W * labelSmall.h / labelSmall.w), { sharpen: 0.6, radius: 1 });
savePng(path.join(PUB, 'mark-real.png'), markImg.w, markImg.h, markImg.px);
savePng(path.join(PUB, 'label-real.png'), labelImg.w, labelImg.h, labelImg.px);

// ---------------- 3) iconos (tile completo, con esquinas redondeadas) ----------------
// el radio del mask va un pelo mas grande que el del tile: asi se recorta el filo oscuro
// que deja el JPEG del master en el borde del tile (sin cortar nada del contenido).
const radius512 = Math.round((radius + AIR + 2) * (512 / tile.w));
const icon512 = roundCrop(tileClean, 512, radius512, { sharpen: 0.35, radius: 1 });
savePng(path.join(PUB, 'icon-real-512.png'), 512, 512, icon512.px);
savePng(path.join(PUB, 'icon-512.png'), 512, 512, icon512.px);
for (const s of [192, 180]) {
  const r = Math.max(4, Math.round((radius + AIR + 2) * (s / tile.w)));
  const im = roundCrop(tileClean, s, r, { sharpen: 0.25, radius: 1 });
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
  const a = rgbaAt(tileClean, lx, sy), b = rgbaAt(tileClean, rx, sy);
  const rr = Math.round((a[0] + b[0]) / 2), gg = Math.round((a[1] + b[1]) / 2), bb = Math.round((a[2] + b[2]) / 2);
  for (let x = 0; x < maskSize; x++) {
    const i = (y * maskSize + x) * 4;
    maskIcon.px[i] = rr; maskIcon.px[i + 1] = gg; maskIcon.px[i + 2] = bb; maskIcon.px[i + 3] = 255;
  }
}
const contentScale = 0.80; // el contenido vive dentro de la zona segura del icono adaptativo
const innerSize = Math.round(maskSize * contentScale);
const tileScaled = roundCrop(tileClean, innerSize, Math.round((radius + AIR + 2) * (innerSize / tile.w)), { sharpen: 0.3, radius: 1 });
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
// El fondo del mockup ES un degradado suave (pantalla verde + halos). El grano y los bloques de
// 8x8 del JPEG son pura suciedad amplificada: por eso el splash se veia cuadriculado en el celu.
// Solucion: se resume el degradado en una grilla gruesa (promediar cada celda borra el bloque) y
// despues se reconstruye a la resolucion que haga falta interpolando la grilla. Sale liso
// SIEMPRE, sin importar cuanto se agrande. (Antes se estiraba la imagen con los bloques adentro.)
const BG_DITHER = process.env.BG_DITHER !== '0';
function coarseField(img, cw, chh) {
  const grid = new Float32Array(cw * chh * 3);
  for (let cy = 0; cy < chh; cy++) {
    const y0 = Math.floor((cy * img.h) / chh), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * img.h) / chh));
    for (let cx = 0; cx < cw; cx++) {
      const x0 = Math.floor((cx * img.w) / cw), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * img.w) / cw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.w + x) * 4;
          r += img.px[i]; g += img.px[i + 1]; b += img.px[i + 2]; n++;
        }
      }
      const k = (cy * cw + cx) * 3;
      // dithering ordenado de ±0,5 nivel sobre la grilla: se interpola junto al degradado (queda
      // suave, no ensucia la imagen) y evita que aparezcan escalones de color al agrandar.
      const d = BG_DITHER ? BAYER8[(cy & 7) * 8 + (cx & 7)] / 64 - 0.5 : 0;
      grid[k] = r / n + d; grid[k + 1] = g / n + d; grid[k + 2] = b / n + d;
    }
  }
  return grid;
}
function renderField(grid, cw, chh, W, H) {
  const out = { w: W, h: H, px: new Uint8Array(W * H * 4) };
  const cat = (t) => (t < 1 ? (1.5 * t - 2.5) * t * t + 1 : t < 2 ? ((-0.5 * t + 2.5) * t - 4) * t + 2 : 0);
  for (let y = 0; y < H; y++) {
    const fy = ((y + 0.5) / H) * chh - 0.5, iy = Math.floor(fy);
    for (let x = 0; x < W; x++) {
      const fx = ((x + 0.5) / W) * cw - 0.5, ix = Math.floor(fx);
      let acc = [0, 0, 0], ws = 0;
      for (let ky = -1; ky <= 2; ky++) {
        const wy = cat(Math.abs(fy - (iy + ky))); if (!wy) continue;
        const yy = clamp(iy + ky, 0, chh - 1);
        for (let kx = -1; kx <= 2; kx++) {
          const w = wy * cat(Math.abs(fx - (ix + kx))); if (!w) continue;
          const xx = clamp(ix + kx, 0, cw - 1), k = (yy * cw + xx) * 3;
          acc[0] += grid[k] * w; acc[1] += grid[k + 1] * w; acc[2] += grid[k + 2] * w; ws += w;
        }
      }
      const o = (y * W + x) * 4;
      out.px[o] = clamp(Math.round(acc[0] / ws), 0, 255);
      out.px[o + 1] = clamp(Math.round(acc[1] / ws), 0, 255);
      out.px[o + 2] = clamp(Math.round(acc[2] / ws), 0, 255);
      out.px[o + 3] = 255;
    }
  }
  return out;
}
const FIELD_W = Number(process.env.FIELD_W || 24);
const FIELD_H = Math.max(4, Math.round((FIELD_W * sh) / sw));
const field = coarseField(bgOnly, FIELD_W, FIELD_H);

// Fondo del splash para la app: se genera ya al tamaño de pantalla del celular (~3x la pantalla
// del mockup), asi el navegador casi no tiene que estirar nada.
const BG_W = Number(process.env.BG_W || Math.round(sw * 3));
const webBg = renderField(field, FIELD_W, FIELD_H, BG_W, Math.round((BG_W * sh) / sw));
savePng(path.join(PUB, 'splash-bg.png'), webBg.w, webBg.h, webBg.px);

// ---------------- 6) splash-real.png (iOS / respaldo) ----------------
// Mismo fondo liso + marca y rotulo reales, ubicados por FRACCIONES del lienzo: asi el arte no
// se deforma al cambiar el tamaño y la composicion queda igual en cualquier relacion de aspecto.
const SW = Number(process.env.SPLASH_W || 1080), SH = Math.round((SW * sh) / sw);
const splash = renderField(field, FIELD_W, FIELD_H, SW, SH);
const place = (img, frac) =>
  blit(splash, img, Math.round(frac.cx * SW - img.w / 2), Math.round(frac.cy * SH - img.h / 2));
const markInSplash = resampleHQ(markSmall, Math.round(report.mark.w * SW), Math.round((report.mark.w * SW * markSmall.h) / markSmall.w), { sharpen: 0.7, radius: 2 });
place(markInSplash, report.mark);
if (screenLabel && report.label) {
  const lw = Math.round(report.label.w * SW);
  place(resampleHQ(labelSmall, lw, Math.round((lw * labelSmall.h) / labelSmall.w), { sharpen: 0.6, radius: 1 }), report.label);
}
savePng(path.join(PUB, 'splash-real.png'), SW, SH, splash.px);

fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'brand-report.json'), JSON.stringify(report, null, 2));
console.log('REPORT', JSON.stringify(report));
