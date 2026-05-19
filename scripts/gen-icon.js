// Gera public/assets/icon.ico a partir de public/assets/icon.png
// com múltiplos tamanhos (16, 24, 32, 48, 64, 128, 256) para Windows.
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

const inputPng = path.join(__dirname, '..', 'public', 'assets', 'icon.png');
const outputIco = path.join(__dirname, '..', 'public', 'assets', 'icon.ico');

pngToIco(inputPng)
  .then((buf) => {
    fs.writeFileSync(outputIco, buf);
    console.log(`[gen-icon] icon.ico gerado: ${outputIco} (${buf.length} bytes)`);
  })
  .catch((err) => {
    console.error('[gen-icon] Erro ao gerar icon.ico:', err);
    process.exit(1);
  });
