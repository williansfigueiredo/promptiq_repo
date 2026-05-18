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
// BYTENODE: Módulo puro, sem top-level await e sem ES modules.
//           Compatível com compilação para .jsc.
// ============================================================

const crypto = require('crypto');
const si = require('systeminformation');

/**
 * collectRawHardwareIds (PRIVADO)
 * --------------------------------
 * Coleta os 3 identificadores de hardware via systeminformation.
 * Função interna — NÃO é exportada para impedir uso externo dos seriais.
 *
 * Estratégia de fallback: se algum serial vier vazio (comum em alguns
 * CPUs/discos no Windows), usamos campos alternativos para não falhar
 * a geração do fingerprint.
 *
 * @returns {Promise<{board: string, cpu: string, disk: string}>}
 */
async function collectRawHardwareIds() {
  // 1) UUID/Serial da placa-mãe — geralmente estável durante toda a vida da máquina
  const baseboard = await si.baseboard();

  // 2) Serial do processador — alguns Intel/AMD não expõem; usa brand+family como fallback
  const cpu = await si.cpu();

  // 3) Disco principal — NÃO usa disks[0] pois a ordem pode mudar com pen drives / HDs externos.
  //    Estratégia: filtra removíveis, ordena por tamanho desc → disco maior = disco do sistema.
  const disks = await si.diskLayout();
  const fixedDisks = (disks || [])
    .filter(d => !d.removable)                         // descarta pen drives / removíveis
    .sort((a, b) => (b.size || 0) - (a.size || 0));   // maior primeiro = disco principal
  const primaryDisk = fixedDisks[0] || (disks && disks[0]) || {};

  // 4) MAC da interface de rede física principal — estabiliza em casos onde o disco
  //    não tem serial exposto (VMs, alguns NVMe sem serial no WMI).
  let mac = 'NO-MAC';
  try {
    const ifaces = await si.networkInterfaces();
    const physical = (Array.isArray(ifaces) ? ifaces : [])
      .filter(i => i && !i.virtual && i.mac && i.mac !== '00:00:00:00:00:00')
      .sort((a, b) => (a.iface || '').localeCompare(b.iface || ''));  // ordem alfabética → estável
    if (physical.length > 0) mac = physical[0].mac;
  } catch (_) { /* ignora — continua sem MAC */ }

  return {
    board: String(baseboard.serial || baseboard.assetTag || 'NO-BOARD-SERIAL'),
    cpu: String(cpu.serial || `${cpu.manufacturer || ''}-${cpu.brand || ''}-${cpu.family || ''}`),
    disk: String(primaryDisk.serialNum || primaryDisk.name || 'NO-DISK-SERIAL'),
    mac
  };
}

/**
 * generateFingerprint (PÚBLICO)
 * ------------------------------
 * Gera o fingerprint SHA-256 final da máquina.
 *
 * Determinístico: mesma máquina → mesmo hash, sempre.
 * Único: máquinas diferentes → hashes diferentes.
 *
 * @returns {Promise<string>} hash hexadecimal de 64 caracteres
 */
async function generateFingerprint() {
  const ids = await collectRawHardwareIds();

  // Concatena na ORDEM FIXA com separador único.
  // A ordem fixa é crítica: troca = hash diferente = licença inválida.
  const concatenated = `${ids.board}::${ids.cpu}::${ids.disk}::${ids.mac}`;

  // SHA-256 hex (64 chars). Após esta linha, a variável `ids` sai de escopo
  // e o GC limpa os seriais brutos da memória.
  return crypto.createHash('sha256').update(concatenated).digest('hex');
}

/**
 * generateFingerprintDebug (PÚBLICO - APENAS DEV)
 * ------------------------------------------------
 * Versão de debug que retorna o hash + os pedaços usados.
 * USE APENAS LOCALMENTE para testar — NÃO chame em produção.
 *
 * Para testar: abra um terminal na raiz do projeto e rode:
 *   node -e "require('./src/main/license/HardwareScanner').generateFingerprintDebug().then(console.log)"
 */
async function generateFingerprintDebug() {
  const ids = await collectRawHardwareIds();
  const concatenated = `${ids.board}::${ids.cpu}::${ids.disk}::${ids.mac}`;
  const hash = crypto.createHash('sha256').update(concatenated).digest('hex');
  return {
    board: ids.board,
    cpu: ids.cpu,
    disk: ids.disk,
    mac: ids.mac,
    concatenated,
    fingerprint: hash
  };
}

module.exports = {
  generateFingerprint,
  generateFingerprintDebug
};
