/**
 * 1) esbuild → gate.cjs (bundle minificado)
 * 2) bytenode → gate.jsc (bytecode V8 **do mesmo Electron** do projeto)
 * 3) apaga gate.cjs — no instalador só entra o .jsc (menos superfície de leitura)
 *
 * Rode antes de electron-builder (npm run dist).
 * Limitação conhecida do Bytenode: arrow functions em alguns contextos podem causar
 * problemas raros; se crashar só no .exe, avise e ajustamos o target do esbuild.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const bytenode = require('bytenode');

const root = path.join(__dirname, '..');
const entry = path.join(root, 'src/main/license/license-handlers.js');
const outDir = path.join(root, 'src/main/license-dist');
const outCjs = path.join(outDir, 'gate.cjs');
const outJsc = path.join(outDir, 'gate.jsc');

async function main() {
  await fs.promises.mkdir(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: outCjs,
    external: ['electron'],
    minify: true,
    legalComments: 'none',
    logLevel: 'info'
  });
  // eslint-disable-next-line no-console
  console.log('[bundle-license-gate] bundle OK →', outCjs);

  await bytenode.compileFile({
    filename: outCjs,
    output: outJsc,
    compileAsModule: true,
    electron: true
  });
  // eslint-disable-next-line no-console
  console.log('[bundle-license-gate] bytecode OK →', outJsc);

  await fs.promises.unlink(outCjs);
  // eslint-disable-next-line no-console
  console.log('[bundle-license-gate] gate.cjs removido (artefato só .jsc)');
}

main().catch((err) => {
  console.error('[bundle-license-gate] FALHOU:', err);
  process.exit(1);
});
