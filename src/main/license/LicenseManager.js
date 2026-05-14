// ============================================================
// LicenseManager.js
// ============================================================
// DESCRIÇÃO: Orquestrador do sistema de licenciamento.
// FUNÇÃO:    Junta HardwareScanner + LicenseStorage + LicenseClient
//            e expõe as operações de alto nível:
//              - checkLocalLicense()  → validação OFFLINE (boot)
//              - activate(key)        → ativação ONLINE (1x)
//              - getStatus()          → status legível para UI
//              - deactivate()         → remove licença local
//              - generateFingerprint()→ re-export para UI mostrar
//
// BYTENODE: módulo CommonJS clássico, sem mágica.
// ============================================================

const { generateFingerprint } = require('./HardwareScanner');
const {
  saveLicense,
  loadLicense,
  deleteLicense
} = require('./LicenseStorage');
const { activateOnline } = require('./LicenseClient');
const { app } = require('electron');

function devLicenseOptional() {
  return !app.isPackaged && process.env.PROMPTIQ_ENFORCE_LICENSE !== '1';
}

/** Chave só para desenvolvimento: grava licença local sem chamar o ERP. */
const DEV_LOCAL_LICENSE_KEY = 'DEV-LOCAL-PROMPTIQ';

/**
 * checkLocalLicense (PÚBLICO)
 * ----------------------------
 * VALIDAÇÃO OFFLINE — chamada na inicialização do app.
 *
 * Fluxo:
 *   1. Gera o fingerprint da máquina ATUAL.
 *   2. Tenta ler/decifrar a licença local com esse fingerprint.
 *      Se a máquina mudou, a decifragem falha → null.
 *   3. Por segurança extra, ainda compara o fingerprint GRAVADO
 *      dentro da licença com o ATUAL (defesa em profundidade).
 *
 * @returns {Promise<{valid: boolean, reason?: string, license?: Object}>}
 */
async function checkLocalLicense() {
  const currentFingerprint = await generateFingerprint();
  const license = loadLicense(currentFingerprint);

  if (!license) {
    return { valid: false, reason: 'no-license-or-fingerprint-mismatch' };
  }

  // Defesa em profundidade: confere o fingerprint gravado vs. o atual
  if (license.fingerprint !== currentFingerprint) {
    return { valid: false, reason: 'fingerprint-mismatch' };
  }

  return { valid: true, license };
}

/**
 * activate (PÚBLICO)
 * -------------------
 * ATIVAÇÃO ONLINE — chamada quando o usuário digita a chave.
 *
 * Fluxo:
 *   1. Valida formato mínimo da chave.
 *   2. Gera fingerprint da máquina atual.
 *   3. POST no ERP com { key, fingerprint }.
 *   4. Se ok, grava a licença cifrada no disco.
 *
 * @param {string} licenseKey
 * @returns {Promise<{ok: boolean, error?: string, license?: Object}>}
 */
async function activate(licenseKey) {
  if (!licenseKey || typeof licenseKey !== 'string' || licenseKey.trim().length < 8) {
    return { ok: false, error: 'Chave inválida — muito curta.' };
  }

  const trimmed = licenseKey.trim();

  // ------------------------------------------------------------------
  // DEV: ativação local sem ERP (só quando não empacotado).
  // Útil com PROMPTIQ_ENFORCE_LICENSE=1 para testar fingerprint + arquivo
  // license.dat. No .exe empacotado esta chave NUNCA é aceita.
  // ------------------------------------------------------------------
  if (!app.isPackaged && trimmed === DEV_LOCAL_LICENSE_KEY) {
    const fingerprint = await generateFingerprint();
    const license = {
      key: trimmed,
      fingerprint,
      customer: 'Dev local (sem ERP)',
      activatedAt: new Date().toISOString(),
      serverToken: null,
      meta: { devLocalActivation: true }
    };
    saveLicense(license, fingerprint);
    console.log('[License] DEV: licença local gravada com chave', DEV_LOCAL_LICENSE_KEY);
    return { ok: true, license };
  }

  const fingerprint = await generateFingerprint();
  const result = await activateOnline(trimmed, fingerprint);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Grava o arquivo cifrado usando o fingerprint atual como chave AES
  saveLicense(result.license, fingerprint);
  return { ok: true, license: result.license };
}

/**
 * getStatus (PÚBLICO)
 * --------------------
 * Status amigável para mostrar na UI (aba License nas Preferences,
 * janela de "Sobre", etc.). Nunca retorna a chave completa.
 */
async function getStatus() {
  const optional = devLicenseOptional();
  const check = await checkLocalLicense();
  if (!check.valid) {
    return { activated: false, reason: check.reason, devLicenseOptional: optional };
  }
  return {
    activated: true,
    customer: check.license.customer,
    activatedAt: check.license.activatedAt,
    keyMasked: maskKey(check.license.key),
    devLicenseOptional: optional
  };
}

/**
 * maskKey (PRIVADO)
 * ------------------
 * Mascara a chave para exibição: PROM-****-****-1234
 */
function maskKey(key) {
  if (!key || key.length < 8) return '****';
  return key.substring(0, 4) + '-****-****-' + key.substring(key.length - 4);
}

/**
 * deactivate (PÚBLICO)
 * ---------------------
 * Remove a licença local. Próxima inicialização vai exigir
 * nova ativação. Útil para suporte (troca de máquina).
 */
function deactivate() {
  deleteLicense();
}

module.exports = {
  checkLocalLicense,
  activate,
  getStatus,
  deactivate,
  generateFingerprint   // re-exportado por conveniência
};
