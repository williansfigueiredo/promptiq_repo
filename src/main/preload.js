
// Removemos 'contextBridge' daqui e usamos a forma compatível.
const { ipcRenderer } = require('electron');
const path = require('path');

// ============================================================
// SPELLCHECKER: Usando apenas o nativo do Chromium
// ============================================================
// O Typo.js foi removido para melhorar performance.
// O spellchecker nativo do Electron/Chromium é suficiente.

console.log('[preload] Usando spellchecker NATIVO do Chromium (Typo.js desativado).');

// Exposição da API global diretamente no 'window'
// Mantemos a API compatível mas retornando valores padrão
window.cognito = {
  spell: {
    // API mantida para compatibilidade, mas não faz nada
    // O spellchecker nativo do Chromium cuida de tudo
    detectLanguage: () => 'pt-BR',
    run: () => [],
    check: () => true,
    suggestions: () => [],
  },

  ipc: {
    send: (channel, payload) => {
      if (typeof channel === 'string') ipcRenderer.send(channel, payload);
    },
    on: (channel, handler) => {
      if (typeof channel === 'string' && typeof handler === 'function') {
        ipcRenderer.removeAllListeners(channel);
        ipcRenderer.on(channel, (_evt, data) => handler(data));
      }
    },
  },

  paths: {
    appRoot: () => process.cwd(),
    dictionariesDir: () => path.join(process.cwd(), 'assets', 'dictionaries'),
  },
};

console.log('[preload] carregado e API exposta em window.cognito');

