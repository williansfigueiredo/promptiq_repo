// ============================================================
// LicenseClient.js
// ============================================================
// Cliente HTTP para o servidor de licenças (POST JSON).
// Usa fetch + AbortController para timeout confiável no Electron
// (https.request com options.timeout costuma não abortar connect/TLS).
// ============================================================

const { URL } = require('url');
const {
  LICENSE_API_URL,
  REQUEST_TIMEOUT_MS,
  APP_VERSION
} = require('./license.config');

/**
 * @param {string} licenseKey
 * @param {string} fingerprint
 * @returns {Promise<{ok: boolean, license?: Object, error?: string}>}
 */
async function activateOnline(licenseKey, fingerprint) {
  try {
    new URL(LICENSE_API_URL);
  } catch (e) {
    return { ok: false, error: 'Endpoint configurado é inválido.' };
  }

  const payload = JSON.stringify({
    key: licenseKey,
    fingerprint,
    appVersion: APP_VERSION,
    platform: process.platform,
    arch: process.arch
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(LICENSE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Promptiq/${APP_VERSION}`,
        Accept: 'application/json'
      },
      body: payload,
      signal: controller.signal
    });

    const body = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        error: `Servidor retornou status ${res.status}.`
      };
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return { ok: false, error: 'Resposta do servidor não é JSON válido.' };
    }

    if (!data.valid) {
      return {
        ok: false,
        error: data.message || 'Chave de licença inválida.'
      };
    }

    return {
      ok: true,
      license: {
        key: licenseKey,
        fingerprint,
        customer: data.customer || null,
        activatedAt: new Date().toISOString(),
        serverToken: data.token || null,
        meta: data.meta || {}
      }
    };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, error: 'Tempo esgotado ao contatar o ERP.' };
    }
    return {
      ok: false,
      error: `Falha de conexão com o ERP: ${e && e.message ? e.message : String(e)}`
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  activateOnline
};
