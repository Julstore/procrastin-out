// Acceso clave-valor de la nube (tabla pout_kv). En producción usa Postgres;
// `memoryKv()` es el mismo contrato para probar la lógica sin una base real.
function pgKv(pool) {
  return {
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS pout_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
    },
    async get(key) {
      const { rows } = await pool.query('SELECT v FROM pout_kv WHERE k = $1', [key]);
      return rows.length ? rows[0].v : null;
    },
    async set(key, val) {
      await pool.query(
        'INSERT INTO pout_kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v',
        [key, val],
      );
    },
    async del(key) {
      await pool.query('DELETE FROM pout_kv WHERE k = $1', [key]);
    },
  };
}

function memoryKv() {
  const store = new Map();
  return {
    async init() {},
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async set(key, val) { store.set(key, JSON.stringify(val)); },
    async del(key) { store.delete(key); },
    _keys() { return [...store.keys()]; },
  };
}

module.exports = { pgKv, memoryKv };
