// Almacenamiento de datos por cuenta: un archivo por usuario en <dataDir>/users/<id>.json.
// La migración copia (no mueve) data/vida.json a la cuenta admin, así el original queda como respaldo.
const fs = require('fs');
const path = require('path');

const ID = /^[a-z0-9]{1,32}$/;

function usersDir(dataDir) {
  return path.join(dataDir, 'users');
}

function userFile(dataDir, id) {
  if (!ID.test(String(id || ''))) throw new Error('id de usuario inválido');
  return path.join(usersDir(dataDir), id + '.json');
}

function loadUserData(dataDir, id) {
  const file = userFile(dataDir, id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveUserData(dataDir, id, data) {
  fs.mkdirSync(usersDir(dataDir), { recursive: true });
  const file = userFile(dataDir, id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file); // escritura atómica: no deja un JSON a medio escribir
}

// Copia vida.json a users/<adminId>.json si la cuenta aún no tiene datos.
// Devuelve true si copió, false si ya existía (no pisa datos de la cuenta).
function migrateLegacyData(dataDir, adminId) {
  const legacy = path.join(dataDir, 'vida.json');
  if (!fs.existsSync(legacy)) return false;
  if (fs.existsSync(userFile(dataDir, adminId))) return false;
  fs.mkdirSync(usersDir(dataDir), { recursive: true });
  fs.copyFileSync(legacy, userFile(dataDir, adminId));
  return true;
}

module.exports = { userFile, loadUserData, saveUserData, migrateLegacyData };
