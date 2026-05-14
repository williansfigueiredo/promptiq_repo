/**
 * Inicia o Electron com PROMPTIQ_ENFORCE_LICENSE=1 para testar o gate
 * de licença (splash → ativação ou licença válida) sem configurar variável na mão.
 *
 * Uso: npm run start:enforce
 */
const { spawn } = require('child_process');
const path = require('path');

const electronPath = require('electron');
const root = path.join(__dirname, '..');
const env = { ...process.env, PROMPTIQ_ENFORCE_LICENSE: '1' };

const child = spawn(electronPath, ['.'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: false
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code === null ? 0 : code);
});
