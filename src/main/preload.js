
// Removemos 'contextBridge' daqui e usamos a forma compatível.
const { ipcRenderer } = require('electron');
const path = require('path');
let spellchecker = null;

// Tenta carregar o módulo sem quebrar a aplicação
try {
  spellchecker = require(path.join(__dirname, '../renderer/services/spellchecker-service'));
  console.log('[preload] spellchecker carregado com sucesso.');
} catch (err) {
  console.error('[preload] Erro ao carregar spellchecker:', err);
}

// Função para chamadas seguras (não quebra o app se falhar)
function safeCall(fn, fallback = null) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.catch(err => {
        console.error('[safeCall] Erro na Promise:', err);
        return fallback;
      });
    }
    return result;
  } catch (err) {
    console.error('[preload] erro:', err.message, err);
    return fallback;
  }
}

// Exposição da API global diretamente no 'window'
window.cognito = {
  spell: {
    // Detecta o idioma (sempre retorna pt-BR por enquanto)
    detectLanguage: (text) =>
      safeCall(() => spellchecker?.detectLanguage(text || ''), 'pt-BR'),

    // Roda a verificação ortográfica
    run: (text, autoDetect = true, langCode = null) =>
      safeCall(() => spellchecker?.runSpellCheck(text || '', autoDetect, langCode), []),

    // Sugestões de correção para uma palavra
 suggestions: (word, langCode = null) =>
  safeCall(() => {
    // 🔹 Se langCode não foi informado, detecta antes
    const detectedLang = langCode || spellchecker?.detectLanguage(word || '');
    const result = spellchecker?.getSuggestions(word || '', detectedLang);
    console.log(`[preload] Sugestões solicitadas para "${word}" (${detectedLang})`);
    return Array.isArray(result) ? result : [];
  }, []),
  
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

