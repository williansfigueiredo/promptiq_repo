// ============================================================
// HardwareScanner.js
// ============================================================
// DESCRIÇÃO: Coleta seriais de hardware da máquina e gera um
//            fingerprint SHA-256 único e estável.
//
// SEGURANÇA: Os seriais brutos NUNCA saem deste módulo. Eles são
//            concatenados internamente em uma variável local e
//            imediatamente transformados em hash. Após a função
//            retornar, o Garbage Collector descarta os valores.
//
// ESTRATÉGIA v2 (estabilidade máxima):
//   - Componente principal: MachineGuid do Windows
//     (HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography\MachineGuid)
//     Esse valor é único por instalação do Windows e só muda quando o
//     SO é reinstalado. NÃO é afetado por pen drives, placas de rede,
//     mudança de cabo, sleep, etc.
//   - Componente de reforço: serial da placa-mãe (se disponível)
//   - Componente de reforço: marca/modelo da CPU
//   - NÃO usa mais: serial de disco, MAC. Esses variam demais.
//
// MIGRAÇÃO: a função `generateLegacyFingerprint` recria o algoritmo
// antigo (board+cpu+disk+mac) para permitir migração transparente da
// licença gravada em versões anteriores. Veja LicenseManager.js.
//
// BYTENODE: Módulo puro, sem top-level await e sem ES modules.
// ============================================================

const crypto = require('crypto');
const si = require('systeminformation');
const { execSync } = require('child_process');

// ------------------------------------------------------------
// Leitura do MachineGuid do Windows (super estável)
// ------------------------------------------------------------
function readWindowsMachineGuid() {
  try {
    // reg.exe sai sempre 0 se a chave existir. Usa /v MachineGuid /t REG_SZ.
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: 'utf-8', windowsHide: true, timeout: 4000 }
    );
    // Linha relevante: "    MachineGuid    REG_SZ    xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    const match = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    if (match && match[1]) return match[1].trim();
  } catch (_) { /* ignora — cai no fallback */ }
  return null;
}

// ------------------------------------------------------------
// Coleta enxuta dos componentes ESTÁVEIS (novo algoritmo)
// ------------------------------------------------------------
async function collectStableIds() {
  const baseboard = await si.baseboard().catch(() => ({}));
  const cpu = await si.cpu().catch(() => ({}));

  return {
    // Componente principal — só muda se o Windows for reinstalado
    winGuid: readWindowsMachineGuid() || 'NO-WIN-GUID',
    // Serial da placa-mãe — estável durante a vida útil da máquina
    board: String(baseboard.serial || baseboard.assetTag || 'NO-BOARD-SERIAL'),
    // Identificação da CPU (marca/modelo/family) — estável
    cpu: String(cpu.serial || `${cpu.manufacturer || ''}-${cpu.brand || ''}-${cpu.family || ''}`)
  };
}

// ------------------------------------------------------------
// FINGERPRINT NOVO (estável)
// ------------------------------------------------------------
async function generateFingerprint() {
  const ids = await collectStableIds();
  const concatenated = `v2::${ids.winGuid}::${ids.board}::${ids.cpu}`;
  return crypto.createHash('sha256').update(concatenated).digest('hex');
}

// ------------------------------------------------------------
// FINGERPRINT LEGACY (para migração de licenças antigas)
// ------------------------------------------------------------
// Replica o algoritmo das versões 1.3.4 → 1.3.9 (board+cpu+disk+mac).
// É usado APENAS para tentar abrir o license.dat de instalações antigas;
// se conseguir, o LicenseManager re-criptografa com o fingerprint NOVO.
async function generateLegacyFingerprint() {
  const baseboard = await si.baseboard().catch(() => ({}));
  const cpu = await si.cpu().catch(() => ({}));
  const disks = await si.diskLayout().catch(() => []);
  const fixedDisks = (disks || [])
    .filter(d => !d.removable)
    .sort((a, b) => (b.size || 0) - (a.size || 0));
  const primaryDisk = fixedDisks[0] || (disks && disks[0]) || {};

  let mac = 'NO-MAC';
  try {
    const ifaces = await si.networkInterfaces();
    const physical = (Array.isArray(ifaces) ? ifaces : [])
      .filter(i => i && !i.virtual && i.mac && i.mac !== '00:00:00:00:00:00')
      .sort((a, b) => (a.iface || '').localeCompare(b.iface || ''));
    if (physical.length > 0) mac = physical[0].mac;
  } catch (_) { /* ignora */ }

  const board = String(baseboard.serial || baseboard.assetTag || 'NO-BOARD-SERIAL');
  const cpuId = String(cpu.serial || `${cpu.manufacturer || ''}-${cpu.brand || ''}-${cpu.family || ''}`);
  const disk = String(primaryDisk.serialNum || primaryDisk.name || 'NO-DISK-SERIAL');

  const concatenated = `${board}::${cpuId}::${disk}::${mac}`;
  return crypto.createHash('sha256').update(concatenated).digest('hex');
}

// ------------------------------------------------------------
// Debug
// ------------------------------------------------------------
async function generateFingerprintDebug() {
  const ids = await collectStableIds();
  const concatenated = `v2::${ids.winGuid}::${ids.board}::${ids.cpu}`;
  const hash = crypto.createHash('sha256').update(concatenated).digest('hex');
  return {
    algorithm: 'v2',
    winGuid: ids.winGuid,
    board: ids.board,
    cpu: ids.cpu,
    concatenated,
    fingerprint: hash
  };
}

module.exports = {
  generateFingerprint,
  generateLegacyFingerprint,
  generateFingerprintDebug
};
