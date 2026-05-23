/**
 * Pipeline de bytecode para produção (npm run dist):
 *  1) gate.jsc       — licenciamento (esbuild + bytenode)
 *  2) main.jsc       — processo principal
 *  3) app.jsc         — renderer principal (app + módulos do index)
 *
 * Compila com o V8 do Electron do projeto (electron: true).
 * Após compilar, remove os .cjs intermediários.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const bytenode = require('bytenode');

const root = path.join(__dirname, '..');

const targets = [
  {
    label: 'license-gate',
    entry: path.join(root, 'src/main/license/license-handlers.js'),
    outCjs: path.join(root, 'src/main/license-dist/gate.cjs'),
    outJsc: path.join(root, 'src/main/license-dist/gate.jsc'),
    esbuild: {
      external: ['electron'],
      minify: true
    }
  },
  {
    label: 'main',
    entry: path.join(root, 'src/main/main.js'),
    outCjs: path.join(root, 'src/main/main.cjs'),
    outJsc: path.join(root, 'src/main/main.jsc'),
    esbuild: {
      external: ['electron', 'bytenode'],
      minify: false
    }
  },
  {
    label: 'app',
    entry: path.join(root, 'src/renderer/app-bundle-entry.js'),
    outCjs: path.join(root, 'src/renderer/app.cjs'),
    outJsc: path.join(root, 'src/renderer/app.jsc'),
    esbuild: {
      external: ['electron'],
      minify: false,
      platform: 'browser'
    }
  }
];

async function compileTarget(target) {
  await fs.promises.mkdir(path.dirname(target.outCjs), { recursive: true });

  await esbuild.build({
    entryPoints: [target.entry],
    bundle: true,
    format: 'cjs',
    outfile: target.outCjs,
    legalComments: 'none',
    logLevel: 'info',
    platform: target.esbuild.platform || 'node',
    external: target.esbuild.external,
    minify: target.esbuild.minify === true
  });
  console.log(`[bundle-production] ${target.label} bundle OK →`, target.outCjs);

  await bytenode.compileFile({
    filename: target.outCjs,
    output: target.outJsc,
    compileAsModule: true,
    electron: true
  });
  console.log(`[bundle-production] ${target.label} bytecode OK →`, target.outJsc);

  await fs.promises.unlink(target.outCjs);
  console.log(`[bundle-production] ${target.label} .cjs removido`);
}

async function main() {
  for (const target of targets) {
    await compileTarget(target);
  }
  console.log('[bundle-production] concluído — main.jsc + app.jsc + gate.jsc prontos');
}

main().catch((err) => {
  console.error('[bundle-production] FALHOU:', err);
  process.exit(1);
});
