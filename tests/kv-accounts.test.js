const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryKv } = require('../lib/kv');

// Misma regla que server.js: una clave por cuenta, y la fila antigua `data` es del admin.
const keyFor = (id) => 'data:' + id;

async function loadAdmin(kv) {
  const own = await kv.get(keyFor('admin'));
  return own || (await kv.get('data')) || null;
}

test('cada cuenta guarda en su propia clave y no pisa a otra', async () => {
  const kv = memoryKv();
  await kv.set(keyFor('admin'), { tasks: [{ id: 'mia' }] });
  await kv.set(keyFor('amigo1'), { tasks: [] });
  assert.equal((await kv.get(keyFor('admin'))).tasks[0].id, 'mia');
  assert.deepEqual((await kv.get(keyFor('amigo1'))).tasks, []);
  assert.deepEqual(kv._keys().sort(), ['data:admin', 'data:amigo1']);
});

test('la fila antigua `data` pasa a la cuenta admin cuando no tiene la suya', async () => {
  const kv = memoryKv();
  const legacy = { tasks: [{ id: 'vieja' }] };
  await kv.set('data', legacy);
  const admin = await loadAdmin(kv);
  assert.deepEqual(admin, legacy);
});

test('si la cuenta admin ya tiene su fila, no se toma la antigua', async () => {
  const kv = memoryKv();
  await kv.set('data', { tasks: [{ id: 'vieja' }] });
  await kv.set(keyFor('admin'), { tasks: [{ id: 'nueva' }] });
  assert.equal((await loadAdmin(kv)).tasks[0].id, 'nueva');
});

test('un amigo sin datos empieza vacío y no hereda los del admin', async () => {
  const kv = memoryKv();
  await kv.set(keyFor('admin'), { tasks: [{ id: 'del-admin' }] });
  assert.equal(await kv.get(keyFor('amigo1')), null);
});
