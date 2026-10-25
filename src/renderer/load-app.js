/**
 * Carrega o renderer principal.
 * Dev: scripts legíveis (mesma ordem do index.html).
 * Produção: app.jsc (bytecode).
 */
const fs = require('fs');
const path = require('path');

const bytecodePath = path.join(__dirname, 'app.jsc');

function loadScript(src) {
  const script = document.createElement('script');
  script.src = src;
  document.body.appendChild(script);
}

if (fs.existsSync(bytecodePath)) {
  require('bytenode');
  require(bytecodePath);
} else {
  loadScript('../../src/renderer/modules/hotkey-handler.js');
  loadScript('../../src/renderer/modules/tab-navigation.js');
  loadScript('../../src/renderer/modules/keyboard-handler.js');
  loadScript('../../src/renderer/modules/version-diff.js');
  loadScript('../../src/renderer/modules/backup-sync.js');
  loadScript('../../src/renderer/modules/projection-mirror.js');
  loadScript('../../src/renderer/app.js');
}
