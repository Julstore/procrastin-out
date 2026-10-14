// Sube data/vida.json + data/auth.json locales a Postgres (DATABASE_URL).
// Uso (PowerShell):  $env:DATABASE_URL="postgresql://..."; npm run migrate
// Es seguro repetirlo: sobrescribe las claves 'data' y 'auth' en la nube.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ Falta DATABASE_URL en el entorno.'); process.exit(1); }
const root = process.argv[2] || path.join(process.cwd(), 'data');

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
await pool.query('CREATE TABLE IF NOT EXISTS pout_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
for (const [k, f] of [['data', 'vida.json'], ['auth', 'auth.json']]) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { console.log(`(omitido, no existe) ${f}`); continue; }
  const v = JSON.parse(fs.readFileSync(p, 'utf8'));
  await pool.query('INSERT INTO pout_kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, v]);
  console.log(`☁️ subido ${k} ← ${f}`);
}
await pool.end();
console.log('✅ Listo. Abre tu URL pública y entra con tu PIN de siempre.');
