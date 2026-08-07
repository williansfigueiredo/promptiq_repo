// ============================================================
// license-handlers.js
// ============================================================
// DESCRIÇÃO: Handlers IPC do módulo de licenciamento.
// PADRÃO:    Segue o mesmo formato dos outros handlers do projeto
//            (initFileHandlers, initSettingsHandlers) — função
//            factory initLicenseHandlers() que registra os canais.
//
// CANAIS IPC EXPOSTOS:
//   - 'license:status'      → renderer pede status atual
//   - 'license:activate'    → renderer envia a chave para ativar
//   - 'license:fingerprint' → renderer pede o fingerprint atual (debug/suporte)
//   - 'license:deactivate'  → renderer pede para remover licença local
//
// BYTENODE: módulo CommonJS clássico.
// ============================================================

const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const LicenseManager = require('./LicenseManager');

/**
 * initLicenseHandlers (PÚBLICO)
 * ------------------------------
 * Registra todos os handlers IPC do módulo de licença.
 * Chame UMA vez no main.js, antes de createSplashWindow().
 */
function initLicenseHandlers() {

  // ----------------------------------------------------------
  // STATUS: renderer pede o estado atual da licença
  //   const s = await ipcRenderer.invoke('license:status')
  // ----------------------------------------------------------
  ipcMain.handle('license:status', async () => {
    return await LicenseManager.getStatus();
  });

  // ----------------------------------------------------------
  // ACTIVATE: renderer envia a chave digitada pelo usuário
  //   const r = await ipcRenderer.invoke('license:activate', 'XXXX-...')
  // ----------------------------------------------------------
  ipcMain.handle('license:activate', async (event, licenseKey) => {
    try {
      return await LicenseManager.activate(licenseKey);
    } catch (e) {
      console.error('[License] activate handler:', e);
      return {
        ok: false,
        error: e && e.message ? e.message : 'Internal error during activation.'
      };
    }
  });

  // ----------------------------------------------------------
  // FINGERPRINT: renderer pede o hash atual (útil para suporte)
  //   const fp = await ipcRenderer.invoke('license:fingerprint')
  // ----------------------------------------------------------
  ipcMain.handle('license:fingerprint', async () => {
    return await LicenseManager.generateFingerprint();
  });

  // ----------------------------------------------------------
  // DEACTIVATE: renderer pede para remover licença local
  //   const r = await ipcRenderer.invoke('license:deactivate')
  // ----------------------------------------------------------
  ipcMain.handle('license:deactivate', async () => {
    LicenseManager.deactivate();
    return { ok: true };
  });
}

/**
 * LicenseGate (PÚBLICO)
 * ----------------------
 * Objeto chamado no boot do app. Faz a verificação OFFLINE e,
 * se não houver licença válida, abre a janela de ativação e
 * espera o usuário ativar.
 *
 * Retorna uma Promise<boolean>:
 *   - true  → pode chamar initializeApp() normalmente
 *   - false → usuário fechou sem ativar (app já foi encerrado)
 *
 * USO em main.js:
 *   const ok = await LicenseGate.ensureValid(APP_ICON);
 *   if (ok) initializeApp();
 */
const LicenseGate = {
  /**
   * @param {string} APP_ICON - ícone da janela
   * @param {Electron.BrowserWindow|null} splashRef - splash a ocultar durante o gate (evita segunda janela clicável)
   * @param {string|null} activationHtmlPath - caminho absoluto para activation.html (main process)
   */
  async ensureValid(APP_ICON, splashRef = null, activationHtmlPath = null) {
    // ------------------------------------------------------------------
    // DEV: não bloquear o desenvolvedor em `npm start` (app não empacotado).
    // Em produção (electron-builder), app.isPackaged === true → sempre exige.
    // Para testar o fluxo completo de licença: PROMPTIQ_ENFORCE_LICENSE=1
    // ------------------------------------------------------------------
    if (!app.isPackaged && process.env.PROMPTIQ_ENFORCE_LICENSE !== '1') {
      console.log('[License] DEV: gate desativado (app não empacotado). Para exigir licença: PROMPTIQ_ENFORCE_LICENSE=1');
      return true;
    }

    const check = await LicenseManager.checkLocalLicense();

    if (check.valid) {
      console.log('[License] OK — máquina autorizada.');
      return true;
    }

    console.log(`[License] Bloqueio: ${check.reason}. Abrindo janela de ativação...`);
    return await openActivationWindow(APP_ICON, splashRef, activationHtmlPath);
  }
};

/**
 * openActivationWindow (PRIVADO)
 * -------------------------------
 * Abre a janela de ativação como modal isolada e retorna uma
 * Promise que resolve TRUE quando o usuário ativa com sucesso,
 * ou FALSE se ele fechar sem ativar (e nesse caso o app é encerrado).
 */
function hardenActivationWebContents(wc) {
  if (!app.isPackaged) return;

  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  wc.on('will-navigate', (event, url) => {
    if (url && /^https?:/i.test(url)) {
      event.preventDefault();
    }
  });

  wc.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    if (key === 'f12' || key === 'f5') {
      event.preventDefault();
      return;
    }
    if (mod && input.shift && (key === 'i' || key === 'j' || key === 'c')) {
      event.preventDefault();
      return;
    }
    if (mod && key === 'u') {
      event.preventDefault();
    }
  });
}

function openActivationWindow(APP_ICON, splashRef, activationHtmlPath) {
  return new Promise((resolve) => {
    // Evita que o splash fique por baixo como "segunda superfície" enquanto o gate roda.
    if (splashRef && !splashRef.isDestroyed()) {
      try {
        splashRef.hide();
      } catch (_) { /* ignore */ }
    }

    const htmlPath = activationHtmlPath
      || path.join(__dirname, '../../../public/html/activation.html');

    const packaged = app.isPackaged;

    const win = new BrowserWindow({
      width: 480,
      height: 580,
      title: 'Promptiq — Activate License',
      icon: APP_ICON,
      frame: false,
      titleBarStyle: 'hidden',
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      minimizable: false,
      alwaysOnTop: true,
      center: true,
      focusable: true,
      backgroundColor: '#1a1a1a',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        v8CacheOptions: 'none',
        devTools: !packaged,
        spellcheck: false
      }
    });

    hardenActivationWebContents(win.webContents);

    win.setMenuBarVisibility(false);
    win.removeMenu();
    win.loadFile(htmlPath);

    let activatedOk = false;

    // O renderer envia 'license:activated-ok' quando a ativação dá certo.
    // Usamos ipcMain.once para escutar apenas UMA vez.
    const onActivated = () => {
      activatedOk = true;
      if (!win.isDestroyed()) win.close();
    };
    ipcMain.once('license:activated-ok', onActivated);

    win.on('closed', () => {
      // Garante a remoção do listener mesmo se o usuário fechou no X
      ipcMain.removeListener('license:activated-ok', onActivated);
      resolve(activatedOk);

      if (!activatedOk) {
        // Usuário fechou a janela sem ativar → encerra o app inteiro
        console.log('[License] Janela de ativação fechada sem ativar — encerrando app.');
        app.quit();
      }
    });
  });
}

module.exports = {
  initLicenseHandlers,
  LicenseGate
};
