// Doble de pruebas de un Pool de `pg` (solo la tabla pout_kv que usa lib/kv.js).
// Persiste en un archivo JSON: así simula una base que SOBREVIVE a reinicios del servidor.
// La ruta la fija POUT_TEST_PG_FILE (cada prueba usa la suya).
const fs = require('fs');

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

module.exports = function memoryPool() {
  const file = process.env.POUT_TEST_PG_FILE;
  if (!file) throw new Error('falta POUT_TEST_PG_FILE para el doble de pg');
  return {
    on() {},
    async query(sql, params = []) {
      const s = String(sql).trim();
      const store = load(file);
      if (s.startsWith('CREATE TABLE')) return { rows: [] };
      if (s.startsWith('SELECT v FROM pout_kv')) {
        const k = params[0];
        return { rows: k in store ? [{ v: store[k] }] : [] };
      }
      if (s.startsWith('INSERT INTO pout_kv')) {
        store[params[0]] = params[1];
        fs.writeFileSync(file, JSON.stringify(store), 'utf8');
        return { rows: [] };
      }
      throw new Error('consulta no soportada en el doble: ' + s.slice(0, 40));
    },
  };
};
