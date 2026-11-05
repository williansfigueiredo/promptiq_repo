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

const { generateFingerprint, generateFingerprintCandidates, generateLegacyFingerprint } = require('./HardwareScanner');
const {
  saveLicense,
  loadLicense,
  saveBackup,
  loadBackup,
  saveSealed,
  loadSealed,
  licenseFilesExist,
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
 *   1. Coleta o fingerprint da máquina e suas variações tolerantes a
 *      falhas transitórias de leitura de hardware.
 *   2. Tenta decifrar license.dat com cada uma; se falhar, usa license.bak
 *      (cifrada só com o MachineGuid).
 *   3. Se ainda falhar e existir licença gravada, repete até 3x antes de
 *      pedir ativação. Nenhum arquivo de licença é apagado automaticamente.
 *
 * @returns {Promise<{valid: boolean, reason?: string, license?: Object}>}
 */
async function checkLocalLicense() {
  // Caminho rápido: selo DPAPI já validado antes — não lê hardware nem decifra nada.
  const sealed = loadSealed();
  if (sealed) return { valid: true, license: sealed };

  // Só vale a pena insistir se já existe licença gravada (evita atrasar a 1ª ativação).
  const attempts = licenseFilesExist() ? 3 : 1;

  for (let i = 0; i < attempts; i++) {
    // Falhas transitórias de leitura do hardware (sistema sob carga) passam
    // sozinhas: espera um pouco e coleta de novo antes de pedir ativação.
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1500));

    const scan = await generateFingerprintCandidates();
    const found = openStoredLicense(scan);
    if (found) {
      healStoredLicense(found, scan);
      return { valid: true, license: found.license };
    }

    // MIGRAÇÃO automática: license.dat gravado pelo algoritmo v1
    // (board+cpu+disk+mac) é aberto com o fingerprint legacy e regravado no v2.
    try {
      const legacyFingerprint = i === 0 ? await generateLegacyFingerprint() : null;
      if (legacyFingerprint && !scan.candidates.includes(legacyFingerprint)) {
        const legacyLicense = loadLicense(legacyFingerprint);
        if (legacyLicense) {
          console.log('[License] Migrando licença para algoritmo de fingerprint v2…');
          const migrated = {
            ...legacyLicense,
            fingerprint: scan.primary,
            meta: {
              ...(legacyLicense.meta || {}),
              migratedFromLegacy: true,
              migratedAt: new Date().toISOString()
            }
          };
          saveLicense(migrated, scan.primary, scan.anchor);
          return { valid: true, license: migrated };
        }
      }
    } catch (err) {
      console.warn('[License] Falha ao tentar migração legacy:', err && err.message);
    }
  }

  return { valid: false, reason: 'no-license-or-fingerprint-mismatch' };
}

/** Abre license.dat com qualquer fingerprint candidato; senão tenta license.bak. */
function openStoredLicense(scan) {
  for (const fp of scan.candidates) {
    const license = loadLicense(fp);
    if (license) return { license, fromBackup: false };
  }
  if (scan.anchor) {
    const license = loadBackup(scan.anchor);
    if (license) {
      console.warn('[License] license.dat não abriu — usando cópia de segurança (license.bak).');
      return { license, fromBackup: true };
    }
  }
  return null;
}

/** Mantém license.dat e license.bak sempre presentes, sem nunca apagar nada. */
function healStoredLicense(found, scan) {
  try {
    saveSealed(found.license);
    if (found.fromBackup) {
      saveLicense(found.license, scan.primary, scan.anchor);
    } else if (scan.anchor && !loadBackup(scan.anchor)) {
      saveBackup(found.license, scan.anchor);
    }
  } catch (err) {
    console.warn('[License] Falha ao restaurar arquivos de licença:', err && err.message);
  }
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
    return { ok: false, error: 'Invalid key: too short.' };
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
      customer: 'Local dev (no ERP)',
      activatedAt: new Date().toISOString(),
      serverToken: null,
      meta: { devLocalActivation: true }
    };
    saveLicense(license, fingerprint, (await generateFingerprintCandidates()).anchor);
    console.log('[License] DEV: licença local gravada com chave', DEV_LOCAL_LICENSE_KEY);
    return { ok: true, license };
  }

  const fingerprint = await generateFingerprint();
  const result = await activateOnline(trimmed, fingerprint);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Grava o arquivo cifrado usando o fingerprint atual como chave AES
  saveLicense(result.license, fingerprint, (await generateFingerprintCandidates()).anchor);
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
