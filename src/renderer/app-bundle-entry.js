/**
 * Entrada do esbuild para gerar app.jsc (produção).
 * Ordem importa: módulos globais antes do app.js.
 */
require('./modules/hotkey-handler.js');
require('./modules/tab-navigation.js');
require('./modules/keyboard-handler.js');
require('./modules/version-diff.js');
require('./modules/paste-sanitizer.js');
require('./modules/backup-sync.js');
require('./modules/projection-mirror.js');
require('./app.js');
