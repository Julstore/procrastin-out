const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadUserData, saveUserData, migrateLegacyData, userFile } = require('../lib/user-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pout-store-'));
}

test('migrateLegacyData copia vida.json a la cuenta admin y conserva el original', () => {
  const dir = tmpDir();
  const legacy = { tasks: [{ id: 't1', title: 'mía' }] };
  fs.writeFileSync(path.join(dir, 'vida.json'), JSON.stringify(legacy));
  assert.equal(migrateLegacyData(dir, 'admin'), true);
  assert.deepEqual(loadUserData(dir, 'admin'), legacy);
  assert.ok(fs.existsSync(path.join(dir, 'vida.json')), 'el original no se borra');
});

test('migrateLegacyData no pisa datos que ya existen', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'vida.json'), JSON.stringify({ tasks: [{ id: 'viejo' }] }));
  saveUserData(dir, 'admin', { tasks: [{ id: 'nuevo' }] });
  assert.equal(migrateLegacyData(dir, 'admin'), false);
  assert.equal(loadUserData(dir, 'admin').tasks[0].id, 'nuevo');
});

test('cada cuenta guarda y lee solo sus datos', () => {
  const dir = tmpDir();
  saveUserData(dir, 'admin', { tasks: [{ id: 'a' }] });
  saveUserData(dir, 'amigo1', { tasks: [] });
  assert.equal(loadUserData(dir, 'admin').tasks.length, 1);
  assert.equal(loadUserData(dir, 'amigo1').tasks.length, 0);
  assert.equal(loadUserData(dir, 'nadie'), null);
});

test('saveUserData no deja archivos temporales', () => {
  const dir = tmpDir();
  saveUserData(dir, 'admin', { ok: true });
  const files = fs.readdirSync(path.join(dir, 'users'));
  assert.deepEqual(files, ['admin.json']);
});

test('ids de usuario con ruta o caracteres raros se rechazan', () => {
  const dir = tmpDir();
  assert.throws(() => userFile(dir, '../vida'), /inválido/);
  assert.throws(() => userFile(dir, 'a/b'), /inválido/);
});
