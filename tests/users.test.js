const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeUser, checkPin, findByUsername, migrateLegacyAuth } = require('../lib/users');

test('makeUser normaliza el usuario y guarda el PIN hasheado', () => {
  const u = makeUser({ username: '  Skapero ', pin: '1234' });
  assert.equal(u.username, 'skapero');
  assert.notEqual(u.pinHash, '1234');
  assert.equal(u.role, 'user');
});

test('makeUser rechaza usuarios y PIN inválidos', () => {
  assert.throws(() => makeUser({ username: 'ab', pin: '1234' }), /usuario/);
  assert.throws(() => makeUser({ username: 'valido', pin: '12' }), /PIN/);
});

test('checkPin acepta el PIN correcto y rechaza otro', () => {
  const u = makeUser({ username: 'amigo1', pin: 'abcd' });
  assert.equal(checkPin(u, 'abcd'), true);
  assert.equal(checkPin(u, 'abce'), false);
  assert.equal(checkPin(u, null), false);
});

test('findByUsername ignora mayúsculas', () => {
  const users = [makeUser({ username: 'amigo1', pin: '1234' })];
  assert.equal(findByUsername(users, 'AMIGO1').username, 'amigo1');
  assert.equal(findByUsername(users, 'nadie'), null);
});

test('migrateLegacyAuth convierte el PIN único en usuario admin con el mismo PIN', () => {
  const legacy = makeUser({ username: 'tmp', pin: '9876' });
  const { pinHash, salt } = legacy;
  const users = migrateLegacyAuth({ pinHash, salt });
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'admin');
  assert.equal(checkPin(users[0], '9876'), true);
});

test('migrateLegacyAuth no toca una lista que ya existe', () => {
  const list = [makeUser({ username: 'amigo1', pin: '1234' })];
  assert.equal(migrateLegacyAuth({ users: list }), list);
  assert.deepEqual(migrateLegacyAuth({}), []);
});
