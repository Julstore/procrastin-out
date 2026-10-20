const fs = require('fs');
const path = require('path');
const root = process.cwd();
const pub = path.join(root, 'public');
const files = [
  'splash-bg.png',
  'mark-real.png',
  'label-real.png',
  'icon-192.png',
  'splash-real.png',
  'icon-512.png',
  'icon-180.png',
  'icon-maskable-512.png',
];
function md5head(buf) {
  let h = 0;
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    const mp = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
    h = Math.imul(h + mp, 31) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
for (const f of files) {
  const file = path.join(pub, f);
  if (!fs.existsSync(file)) { console.log(`MISSING ${f}`); continue; }
  const buf = fs.readFileSync(file);
  console.log(`${f}\t${buf.length}\t${(buf.length / 1024).toFixed(1)}KB\t${md5head(buf)}`);
}
