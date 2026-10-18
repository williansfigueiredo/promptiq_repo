/**
 * Entrada do esbuild para gerar app.jsc (produção).
 * Ordem importa: módulos globais antes do app.js.
 */
require('./modules/hotkey-handler.js');
require('./modules/tab-navigation.js');
require('./modules/keyboard-handler.js');
require('./app.js');
