// Cuentas de usuario de procrastin-out: usuario + PIN (hash scrypt, nunca en claro).
// Módulo puro (sin E/S) para poder probarlo aislado. server.js lo conectará después.
const crypto = require('crypto');

const USERNAME = /^[a-z0-9_]{3,24}$/;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function makeUser({ username, pin, role = 'user', id }) {
  const name = String(username || '').trim().toLowerCase();
  if (!USERNAME.test(name)) throw new Error('El usuario debe tener 3-24 caracteres (a-z, 0-9, _)');
  const p = String(pin || '');
  if (p.length < 4 || p.length > 64) throw new Error('El PIN debe tener al menos 4 caracteres');
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: id || crypto.randomBytes(8).toString('hex'),
    username: name,
    role,
    salt,
    pinHash: hashPin(p, salt),
    createdAt: new Date().toISOString(),
  };
}

function checkPin(user, pin) {
  if (!user || !user.pinHash || pin == null) return false;
  const x = Buffer.from(hashPin(pin, user.salt), 'hex');
  const y = Buffer.from(user.pinHash, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function findByUsername(users, username) {
  const name = String(username || '').trim().toLowerCase();
  return users.find((u) => u.username === name) || null;
}

// Migra el auth.json de un solo PIN ({pinHash, salt}) a una lista de usuarios.
// Si ya es una lista (o está vacío), devuelve la lista tal cual.
function migrateLegacyAuth(auth) {
  if (Array.isArray(auth?.users)) return auth.users;
  if (auth && auth.pinHash && auth.salt) {
    return [{
      id: 'admin',
      username: 'admin',
      role: 'admin',
      salt: auth.salt,
      pinHash: auth.pinHash,
      createdAt: auth.createdAt || new Date().toISOString(),
    }];
  }
  return [];
}

module.exports = { makeUser, checkPin, findByUsername, migrateLegacyAuth, USERNAME };
