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
const { app } = require('electron');
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
function saveLicense(licenseObj, fingerprint) {
  const key = deriveKey(fingerprint);
  const iv = crypto.randomBytes(IV_LENGTH);          // IV novo a cada gravação
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const plaintext = Buffer.from(JSON.stringify(licenseObj), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, authTag, encrypted]);
  fs.writeFileSync(getLicenseFilePath(), payload);
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
  const filePath = getLicenseFilePath();
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
  const filePath = getLicenseFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

module.exports = {
  saveLicense,
  loadLicense,
  deleteLicense,
  getLicenseFilePath
};
