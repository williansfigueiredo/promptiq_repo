// ============================================================
// LicenseStorage.js
// ============================================================
// DESCRIÇÃO: Lê e grava o arquivo de licença local CIFRADO.
//
// SEGURANÇA:
//   - Cifrado com AES-256-GCM (algoritmo autenticado).
//   - A chave AES é derivada do FINGERPRINT da máquina via PBKDF2.
//   - Se o usuário copiar o arquivo de licença para outra máquina,
//     o fingerprint daquela máquina é diferente → a chave derivada
//     é diferente → o GCM falha na verificação de integridade →
//     a função retorna `null` → o app exige reativação.
//
//   - GCM também garante que ninguém possa adulterar o arquivo
//     manualmente sem que isso seja detectado.
//
// BYTENODE: Módulo puro, exporta funções clássicas.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const { LICENSE_FILE_NAME } = require('./license.config');

const ALGO = 'aes-256-gcm';
const SALT = 'promptiq.license.v1.salt';   // sal fixo para PBKDF2 (não é segredo)
const KDF_ITERATIONS = 100000;              // PBKDF2 — 100k rounds (rápido o suficiente)
const KEY_LENGTH = 32;                      // 256 bits para AES-256
const IV_LENGTH = 12;                       // 12 bytes é o padrão recomendado para GCM
const TAG_LENGTH = 16;                      // GCM auth tag

/**
 * deriveKey (PRIVADO)
 * --------------------
 * Deriva uma chave AES de 32 bytes a partir do fingerprint usando PBKDF2-SHA256.
 *
 * Por que PBKDF2 e não usar o hash direto? PBKDF2 adiciona iterações
 * que tornam ataques de força bruta computacionalmente caros, mesmo
 * que alguém saiba o algoritmo.
 */
function deriveKey(fingerprint) {
  return crypto.pbkdf2Sync(fingerprint, SALT, KDF_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * getLicenseFilePath (PRIVADO)
 * -----------------------------
 * Retorna o caminho absoluto do arquivo de licença.
 * Fica em userData (mesmo lugar de user-settings.json).
 *
 * IMPORTANTE: app.getPath('userData') só funciona DEPOIS de app.whenReady().
 * Por isso essa função é chamada lazy (não no topo do módulo).
 */
function getLicenseFilePath() {
  return path.join(app.getPath('userData'), LICENSE_FILE_NAME);
}

function getBackupFilePath() {
  return path.join(app.getPath('userData'), 'license.bak');
}

function getSealedFilePath() {
  return path.join(app.getPath('userData'), 'license.sec');
}

/**
 * saveLicense (PÚBLICO)
 * ----------------------
 * Cifra o objeto de licença e grava no disco.
 *
 * Formato binário do arquivo:
 *   [ IV (12 bytes) ][ AUTH TAG (16 bytes) ][ CIPHERTEXT (resto) ]
 *
 * @param {Object} licenseObj - { key, fingerprint, customer, activatedAt, ... }
 * @param {string} fingerprint - hash atual da máquina (usado para derivar a chave AES)
 */
function encryptLicense(licenseObj, fingerprint) {
  const key = deriveKey(fingerprint);
  const iv = crypto.randomBytes(IV_LENGTH);          // IV novo a cada gravação
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const plaintext = Buffer.from(JSON.stringify(licenseObj), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

// Grava em arquivo temporário e renomeia: um crash/queda de energia no meio
// da escrita nunca deixa o arquivo de licença truncado.
function writeFileAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, filePath);
}

function saveLicense(licenseObj, fingerprint, anchor) {
  writeFileAtomic(getLicenseFilePath(), encryptLicense(licenseObj, fingerprint));
  if (anchor) saveBackup(licenseObj, anchor);
  saveSealed(licenseObj);
}

/**
 * saveSealed / loadSealed (PÚBLICO)
 * ----------------------------------
 * Selo (license.sec) cifrado pelo DPAPI do Windows via safeStorage: só abre
 * nesta máquina/usuário do Windows e NÃO depende de ler o hardware. Permite
 * abrir o app sem recalcular o fingerprint a cada inicialização.
 */
function saveSealed(licenseObj) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    writeFileAtomic(getSealedFilePath(), safeStorage.encryptString(JSON.stringify(licenseObj)));
  } catch (_) { /* selo é best-effort */ }
}

function loadSealed() {
  try {
    const filePath = getSealedFilePath();
    if (!fs.existsSync(filePath) || !safeStorage.isEncryptionAvailable()) return null;
    const license = JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath)));
    return license && license.key ? license : null;
  } catch (_) {
    return null;
  }
}

/**
 * saveBackup / loadBackup (PÚBLICO)
 * ----------------------------------
 * Cópia de segurança (license.bak) cifrada com chave derivada apenas do
 * MachineGuid do Windows. Usada se o fingerprint completo não puder ser
 * reproduzido (ex.: falha transitória ao ler placa-mãe/CPU).
 */
function saveBackup(licenseObj, anchor) {
  try {
    writeFileAtomic(getBackupFilePath(), encryptLicense(licenseObj, anchor));
  } catch (_) { /* backup é best-effort */ }
}

function loadBackup(anchor) {
  return decryptFile(getBackupFilePath(), anchor);
}

/**
 * loadLicense (PÚBLICO)
 * ----------------------
 * Lê e decifra o arquivo de licença.
 *
 * CASOS QUE RETORNAM null:
 *   1) Arquivo não existe (primeira execução / desativado).
 *   2) Arquivo corrompido manualmente.
 *   3) Fingerprint não bate (copiou de outra máquina).
 *   4) JSON inválido após decifragem.
 *
 * @param {string} fingerprint - hash atual da máquina
 * @returns {Object|null} objeto de licença ou null se inválido
 */
function loadLicense(fingerprint) {
  return decryptFile(getLicenseFilePath(), fingerprint);
}

function licenseFilesExist() {
  return fs.existsSync(getLicenseFilePath()) || fs.existsSync(getBackupFilePath());
}

function decryptFile(filePath, fingerprint) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath);

    // Separa o arquivo nos 3 pedaços (IV | TAG | CIPHERTEXT)
    if (raw.length < IV_LENGTH + TAG_LENGTH + 1) return null;
    const iv = raw.slice(0, IV_LENGTH);
    const authTag = raw.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = raw.slice(IV_LENGTH + TAG_LENGTH);

    const key = deriveKey(fingerprint);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);

    // .final() lança erro se o authTag não bater (= máquina diferente / arquivo adulterado)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  } catch (err) {
    // Falha de decifragem (qualquer causa) → trata como ausência de licença
    return null;
  }
}

/**
 * deleteLicense (PÚBLICO)
 * ------------------------
 * Remove o arquivo de licença (usado por "desativar" / suporte).
 */
function deleteLicense() {
  for (const filePath of [getLicenseFilePath(), getBackupFilePath(), getSealedFilePath()]) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

module.exports = {
  saveLicense,
  loadLicense,
  saveBackup,
  loadBackup,
  saveSealed,
  loadSealed,
  licenseFilesExist,
  deleteLicense,
  getLicenseFilePath
};
