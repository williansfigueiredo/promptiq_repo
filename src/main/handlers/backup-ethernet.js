// ============================================================
// backup-ethernet.js
// ============================================================
// DESCRIÇÃO: Conexão direta PRIMARY ⇄ BACKUP por cabo de rede (RJ45), sem roteador, Wi-Fi ou
//            internet. É só uma camada de PREPARAÇÃO + DESCOBERTA na frente do Backup Sync: depois
//            de achar o PRIMARY, a comunicação é a mesma de sempre (Socket.IO na porta 3002 + PIN).
//
// O QUE FAZ:
//   1. Acha a placa Ethernet física e diz se o cabo está ligado (Windows: Get-NetAdapter).
//   2. Garante um endereço IPv4 na placa. Sem privilégio de administrador: espera o Windows atribuir
//      o endereço link-local (169.254.x.x). Só se isso não acontecer pede o UAC.
//   3. Garante a regra do Firewall do Windows (TCP da sincronização + UDP da descoberta), restrita
//      ao programa, a placas com fio e à sub-rede local. Pede o UAC uma única vez (a regra fica).
//   4. Descoberta: o BACKUP manda um "probe" UDP em broadcast (porta 3003) e o PRIMARY responde com
//      o nome e a porta TCP. O PIN nunca viaja nessa etapa.
//
// SEGURANÇA: o que roda elevado é um script fixo (-EncodedCommand, sem arquivo em disco) montado
//            só com valores validados (inteiros, IPv4 link-local, caminho do programa). Nada que
//            volta do processo elevado é considerado: o estado é sempre relido depois.
// ============================================================

'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const os = require('os');
const path = require('path');

const DISCOVERY_PORT = 3003;
const DEFAULT_TCP_PORT = 3002;
const FIREWALL_GROUP = 'PromptIQ Backup Sync';
const PROBE_MAGIC = 'promptiq-backup-probe';
const REPLY_MAGIC = 'promptiq-backup-here';
const PROTOCOL = 1;

const ADDRESS_WAIT_MS = 20000;       // espera pelo link-local do Windows antes de pedir o UAC
const DISCOVERY_FAST_MS = 6000;      // 1ª tentativa de descoberta, sem privilégios
const DISCOVERY_TOTAL_MS = 45000;
const PROBE_EVERY_MS = 1000;
const MIN_DETECT_GAP_MS = 2500;      // intervalo mínimo entre duas leituras completas do Windows
const SAFETY_POLL_MS = 30000;        // com a espera barata, ainda relê o Windows a cada 30 s por segurança
const DETECT_TIMEOUT_MS = 25000;
const UAC_TIMEOUT_MS = 120000;
const UAC_CANCELLED = 1223;
const MAX_PROBES_PER_SECOND = 20;

// Adaptadores que o Windows marca como físicos mas que não são uma placa de rede de verdade
const NOT_A_REAL_NIC = /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|bluetooth|loopback|npcap|tap-|tunnel|teredo|isatap|rndis|remote ndis|tether|android|iphone|apple mobile|vpn|miniport|pseudo|km-test/i;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// ------------------------------------------------------------
// IPv4
// ------------------------------------------------------------
function isIpv4(value) {
  const m = IPV4.exec(String(value || ''));
  return !!m && m.slice(1).every((part) => Number(part) <= 255);
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0) >>> 0;
}

function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function maskOf(prefix) {
  const p = Math.max(0, Math.min(32, Number(prefix) || 0));
  return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
}

function inSubnet(ip, networkIp, prefix) {
  if (!isIpv4(ip) || !isIpv4(networkIp)) return false;
  const mask = maskOf(prefix);
  return (ipToInt(ip) & mask) === (ipToInt(networkIp) & mask);
}

function broadcastOf(ip, prefix) {
  const mask = maskOf(prefix);
  return intToIp(((ipToInt(ip) & mask) | (~mask >>> 0)) >>> 0);
}

const isLinkLocal = (ip) => String(ip).startsWith('169.254.');

// Mesmo endereço link-local sempre para a mesma placa/PC (evita dois PCs escolherem o mesmo)
function linkLocalFor(mac, hostname) {
  const digest = crypto.createHash('sha256').update(`${mac}|${hostname}`).digest();
  return `169.254.${1 + (digest[0] % 254)}.${1 + (digest[1] % 254)}`;
}

// ------------------------------------------------------------
// PowerShell
// ------------------------------------------------------------
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runPowerShell(script, timeoutMs) {
  const prelude = '$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[Text.Encoding]::UTF8;';
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({
        ok: !error,
        code: error ? error.code : 0,
        timedOut: !!(error && error.killed),
        stdout: stdout || '',
        stderr: stderr || ''
      })
    );
  });
}

// Valor entre aspas simples do PowerShell: dobra a aspa; recusa aspas "inteligentes" e controles
function psQuote(value) {
  const text = String(value);
  if (/[\u2018\u2019\u201A\u201B\u0000-\u001f]/.test(text)) throw new Error('Unsafe value.');
  return `'${text.replace(/'/g, "''")}'`;
}

function isSafeProgramPath(program) {
  return typeof program === 'string' && /^[A-Za-z]:\\[^<>"|?*]+$/.test(program) &&
    !/[\u2018\u2019\u201A\u201B\u0000-\u001f]/.test(program);
}

const ruleName = (protocol, port) => `${FIREWALL_GROUP} - ${protocol} ${port}`;
const ruleDescription = (program) => `${FIREWALL_GROUP};${program}`;

// Lê placas/endereços (e, se pedido, as regras do firewall) direto do CIM do Windows: os cmdlets
// Get-Net* levam ~1-2 s cada só para carregar os módulos, o CIM responde em poucas centenas de ms.
function buildDetectScript({ tcpPort, program, withRules }) {
  const lines = [
    '$ns = "root/StandardCimv2"',
    '$out = @{ adapters = @(); rules = $null }'
  ];
  if (withRules) {
    const tcpName = ruleName('TCP', tcpPort);
    const udpName = ruleName('UDP', DISCOVERY_PORT);
    lines.push(
      `$tcpName = ${psQuote(tcpName)}; $udpName = ${psQuote(udpName)}; $want = ${psQuote(ruleDescription(program))}`,
      `$rules = @(Get-CimInstance -Namespace $ns -ClassName MSFT_NetFirewallRule -Filter ${psQuote(`DisplayName='${tcpName}' OR DisplayName='${udpName}'`)} -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 1 -and $_.Description -eq $want })`,
      '$out.rules = @{ tcp = [bool]($rules | Where-Object { $_.DisplayName -eq $tcpName }); udp = [bool]($rules | Where-Object { $_.DisplayName -eq $udpName }) }'
    );
  }
  lines.push(
    '$ips = @(Get-CimInstance -Namespace $ns -ClassName MSFT_NetIPAddress -Filter "AddressFamily=2" -ErrorAction SilentlyContinue)',
    'foreach ($a in @(Get-CimInstance -Namespace $ns -ClassName MSFT_NetAdapter -Filter "HardwareInterface=TRUE" -ErrorAction SilentlyContinue | Where-Object { $_.NdisPhysicalMedium -eq 14 })) {',
    '  $mine = @($ips | Where-Object { $_.InterfaceIndex -eq $a.InterfaceIndex } | ForEach-Object { @{ ip = [string]$_.IPAddress; prefix = [int]$_.PrefixLength; state = [int]$_.AddressState; origin = [int]$_.PrefixOrigin } })',
    '  $out.adapters += @{ name = [string]$a.Name; description = [string]$a.InterfaceDescription; index = [int]$a.InterfaceIndex; media = [int]$a.MediaConnectState; oper = [int]$a.InterfaceOperationalStatus; mac = [string]$a.PermanentAddress; speed = [double]$a.Speed; component = [string]$a.ComponentID; hardware = [bool]$a.HardwareInterface; addresses = $mine }',
    '}',
    'ConvertTo-Json -InputObject $out -Depth 6 -Compress'
  );
  return lines.join('\n');
}

const ADDRESS_STATE = { 1: 'Tentative', 2: 'Duplicate', 3: 'Deprecated', 4: 'Preferred' };
const PREFIX_ORIGIN = { 1: 'Manual', 2: 'WellKnown', 3: 'Dhcp', 4: 'RouterAdvertisement' };

function speedText(bps) {
  const n = Number(bps) || 0;
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10} Gbps`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} Mbps`;
  return '';
}

// Converte os códigos numéricos do CIM para os textos usados no resto do módulo
function normalizeAdapter(raw) {
  const status = raw.status || (raw.media === 1 && raw.oper === 1 ? 'Up' : (raw.media === 2 ? 'Disconnected' : 'Down'));
  return {
    name: raw.name,
    description: raw.description,
    index: raw.index,
    status,
    mac: raw.mac,
    speed: typeof raw.speed === 'string' ? raw.speed : speedText(raw.speed),
    component: raw.component,
    hardware: raw.hardware,
    addresses: asArray(raw.addresses).map((a) => ({
      ip: a.ip,
      prefix: a.prefix,
      state: typeof a.state === 'number' ? (ADDRESS_STATE[a.state] || 'Invalid') : a.state,
      origin: typeof a.origin === 'number' ? (PREFIX_ORIGIN[a.origin] || 'Other') : a.origin
    }))
  };
}

// Script que roda ELEVADO. Só recebe valores já validados.
function buildElevatedScript({ ifIndex, ip, rules, tcpPort, program }) {
  const lines = ['$ErrorActionPreference = "Stop"', 'try {'];
  if (ip) {
    if (!Number.isInteger(ifIndex) || !isIpv4(ip) || !isLinkLocal(ip)) throw new Error('Invalid address.');
    // ActiveStore: não persiste (some ao reiniciar/trocar o cabo) e não altera o IP/DHCP original
    lines.push(
      `if (-not (Get-NetIPAddress -InterfaceIndex ${ifIndex} -IPAddress ${psQuote(ip)} -ErrorAction SilentlyContinue)) {`,
      `  New-NetIPAddress -InterfaceIndex ${ifIndex} -IPAddress ${psQuote(ip)} -PrefixLength 16 -PolicyStore ActiveStore | Out-Null`,
      '}'
    );
  }
  if (rules) {
    if (!Number.isInteger(tcpPort) || tcpPort < 1024 || tcpPort > 65535 || !isSafeProgramPath(program)) {
      throw new Error('Invalid firewall rule.');
    }
    const description = psQuote(ruleDescription(program));
    const common = `-Group ${psQuote(FIREWALL_GROUP)} -Description ${description} -Direction Inbound -Action Allow -Profile Any -Program ${psQuote(program)} -RemoteAddress @('LocalSubnet','169.254.0.0/16') -InterfaceType Wired`;
    lines.push(
      `foreach ($n in @(${psQuote(ruleName('TCP', tcpPort))}, ${psQuote(ruleName('UDP', DISCOVERY_PORT))})) { Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule }`,
      `New-NetFirewallRule -DisplayName ${psQuote(ruleName('TCP', tcpPort))} ${common} -Protocol TCP -LocalPort ${tcpPort} | Out-Null`,
      `New-NetFirewallRule -DisplayName ${psQuote(ruleName('UDP', DISCOVERY_PORT))} ${common} -Protocol UDP -LocalPort ${DISCOVERY_PORT} | Out-Null`
    );
  }
  lines.push('exit 0', '} catch {', '  exit 2', '}');
  return lines.join('\n');
}

// Abre o UAC e roda o script elevado. Resultado: { ok, cancelled }
async function runElevated(innerScript) {
  const encoded = Buffer.from(innerScript, 'utf16le').toString('base64');
  const outer = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(PS_EXE)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`,
    '  exit $p.ExitCode',
    '} catch {',
    `  $e = $_.Exception; if ($e.NativeErrorCode -eq ${UAC_CANCELLED} -or ($e.InnerException -and $e.InnerException.NativeErrorCode -eq ${UAC_CANCELLED})) { exit ${UAC_CANCELLED} }`,
    '  exit 1',
    '}'
  ].join('\n');
  const result = await runPowerShell(outer, UAC_TIMEOUT_MS);
  return { ok: result.ok, cancelled: result.code === UAC_CANCELLED };
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
async function sleep(ms, token) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (token && token.cancelled) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, end - Date.now())));
  }
}

const asArray = (value) => (Array.isArray(value) ? value : (value ? [value] : []));

// Espera BARATA (sem PowerShell): o Node só lista as placas com cabo ligado, então dá para saber de
// graça quando o cabo entra e quando surge um IPv4. Cada leitura completa do Windows custa ~0,5 s de
// CPU; por isso ela só roda quando algo mudou (ou, como rede de segurança, a cada SAFETY_POLL_MS).
async function waitForChange({ names, needIpv4, token, minMs, cheap }) {
  await sleep(minMs, token);
  if (!cheap) return;
  const end = Date.now() + SAFETY_POLL_MS;
  while (Date.now() < end && !token.cancelled) {
    const live = os.networkInterfaces();
    const changed = names.some((name) => live[name] && (!needIpv4 || live[name].some((a) => a.family === 'IPv4')));
    if (changed) return;
    await sleep(1000, token);
  }
}

// Endereços utilizáveis agora: só os "Preferred" (um 169.254 antigo de cabo desligado fica "Tentative")
function usableAddresses(adapter) {
  return asArray(adapter.addresses)
    .filter((a) => a && a.state === 'Preferred' && isIpv4(a.ip) && a.ip !== '0.0.0.0')
    .map((a) => ({ ip: a.ip, prefix: Number(a.prefix) || 24, origin: String(a.origin || '') }));
}

// Com mais de uma placa com cabo, prefere a que já tem endereço link-local (cabo direto entre PCs)
function pickAdapter(upAdapters) {
  const score = (a) => (usableAddresses(a).some((x) => isLinkLocal(x.ip)) ? 1 : 0);
  return upAdapters.slice().sort((a, b) => score(b) - score(a))[0];
}

// ------------------------------------------------------------
// Fábrica
// ------------------------------------------------------------
function createEthernetLink(options = {}) {
  const isPackaged = options.isPackaged === true;
  const program = options.execPath || process.execPath;

  // Só em desenvolvimento: simula placas/regras para testar sem cabo nem administrador.
  function fakeDetection() {
    if (isPackaged || !process.env.PROMPTIQ_ETH_FAKE) return null;
    try {
      return JSON.parse(process.env.PROMPTIQ_ETH_FAKE);
    } catch (_) {
      return null;
    }
  }

  // rules só é preenchido com withRules (consultar o firewall é a parte mais lenta)
  async function detect(tcpPort, withRules = false) {
    const fake = fakeDetection();
    if (fake) {
      return { ok: true, adapters: asArray(fake.adapters).map(normalizeAdapter), rules: withRules ? (fake.rules || { tcp: true, udp: true }) : null };
    }

    if (!isSafeProgramPath(program)) return { ok: false, error: 'Could not determine the application path.' };
    const result = await runPowerShell(buildDetectScript({ tcpPort, program, withRules }), DETECT_TIMEOUT_MS);
    if (!result.ok) {
      return { ok: false, error: result.timedOut ? 'Windows took too long to report the network adapters.' : 'Could not read the network adapters.' };
    }
    try {
      const data = JSON.parse(result.stdout.trim());
      const adapters = asArray(data.adapters).map(normalizeAdapter).filter((a) =>
        a.hardware === true && !String(a.component || '').startsWith('*') &&
        !/^root\\/i.test(String(a.component || '')) &&
        !NOT_A_REAL_NIC.test(`${a.name} ${a.description}`));
      return { ok: true, adapters, rules: withRules ? (data.rules || { tcp: false, udp: false }) : null };
    } catch (_) {
      return { ok: false, error: 'Could not read the network adapters.' };
    }
  }

  async function elevate(plan) {
    if (fakeDetection()) return { ok: true, cancelled: false };
    try {
      return await runElevated(buildElevatedScript({ ...plan, program }));
    } catch (_) {
      return { ok: false, cancelled: false };
    }
  }

  function describeLink(adapter, addresses) {
    return {
      adapter: adapter.name,
      description: adapter.description,
      speed: adapter.speed || '',
      ip: addresses.length ? addresses[0].ip : '',
      addresses: addresses.map((a) => ({ ip: a.ip, prefix: a.prefix }))
    };
  }

  /**
   * Deixa a placa Ethernet pronta: cabo ligado, endereço IPv4 e (PRIMARY) regra do firewall.
   * Resolve { ok, link, warning } | { ok:false, error } | { ok:false, cancelled:true }.
   */
  async function prepareLink({ role, tcpPort, token, onProgress }) {
    const progress = (text, step) => { if (onProgress) onProgress({ text, step }); };
    const fail = (error) => ({ ok: false, error });

    if (process.platform !== 'win32' && !fakeDetection()) return fail('The cable connection is only available on Windows.');

    const tried = { rules: false, ip: false };
    let warning = '';
    let addressWaitSince = 0;
    let rulesOk = role !== 'primary'; // o backup só precisa da regra se a descoberta falhar

    progress('Looking for the network cable…', 'detect');
    for (;;) {
      if (token.cancelled) return { ok: false, cancelled: true };

      const checkRules = !rulesOk && !tried.rules;
      const found = await detect(tcpPort, checkRules);
      if (token.cancelled) return { ok: false, cancelled: true };
      if (!found.ok) return fail(found.error);
      if (!found.adapters.length) return fail('No Ethernet network adapter was found on this PC.');

      const up = found.adapters.filter((a) => a.status === 'Up');
      if (!up.length) {
        progress('Waiting for the network cable to be connected…', 'cable');
        await waitForChange({ names: found.adapters.map((a) => a.name), needIpv4: false, token, minMs: 1000, cheap: !fakeDetection() });
        continue;
      }

      const adapter = pickAdapter(up);
      const addresses = usableAddresses(adapter);
      if (checkRules && found.rules) rulesOk = found.rules.tcp === true && found.rules.udp === true;
      const hasLinkLocal = addresses.some((a) => isLinkLocal(a.ip));
      const onlyStatic = addresses.length > 0 && !hasLinkLocal && addresses.every((a) => a.origin === 'Manual');

      if (addresses.length) addressWaitSince = 0;
      else if (!addressWaitSince) addressWaitSince = Date.now();

      // Sem administrador primeiro: o Windows costuma atribuir o 169.254.x.x sozinho.
      const wantRules = role === 'primary' && !rulesOk && !tried.rules;
      const wantIp = !tried.ip && (
        (!addresses.length && Date.now() - addressWaitSince > ADDRESS_WAIT_MS) ||
        (role === 'primary' && onlyStatic)
      );

      if (wantRules || wantIp) {
        progress('Waiting for administrator approval (look for the Windows permission window)…', 'admin');
        const plannedIp = wantIp ? linkLocalFor(adapter.mac, os.hostname()) : null;
        const result = await elevate({ ifIndex: adapter.index, ip: plannedIp, rules: wantRules, tcpPort });
        if (token.cancelled) return { ok: false, cancelled: true };
        if (wantRules) tried.rules = true;
        if (wantIp) tried.ip = true;

        // Nada do processo elevado é aceito às cegas: relê o que ele devia ter feito.
        const verify = await detect(tcpPort, wantRules);
        const checked = verify.ok ? verify.adapters.find((a) => a.index === adapter.index) : null;
        const rulesApplied = !wantRules || !!(verify.ok && verify.rules && verify.rules.tcp && verify.rules.udp);
        const ipApplied = !wantIp || !!(checked && checked.addresses.some((a) => a.ip === plannedIp));
        if (wantRules && rulesApplied) rulesOk = true;

        if (!rulesApplied || !ipApplied) {
          const needed = wantIp && !ipApplied && !addresses.length;
          const reason = result.cancelled
            ? 'Administrator permission was declined.'
            : 'Windows could not apply the network settings.';
          if (needed) return fail(`${reason} It is needed to give the network cable an address.`);
          if (!rulesApplied) warning = `${reason} Windows Firewall may block the cable connection.`;
        }
        continue;
      }

      if (!addresses.length) {
        progress('Cable connected. Waiting for Windows to assign an address…', 'address');
        await waitForChange({ names: [adapter.name], needIpv4: true, token, minMs: MIN_DETECT_GAP_MS, cheap: !fakeDetection() });
        continue;
      }

      return { ok: true, link: describeLink(adapter, addresses), adapterIndex: adapter.index, warning };
    }
  }

  // ----------------------------------------------------------
  // PRIMARY: responde à descoberta
  // ----------------------------------------------------------
  function startResponder({ tcpPort, getAddresses }) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      let windowStart = 0;
      let windowCount = 0;

      socket.on('message', (message, remote) => {
        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          windowCount = 0;
        }
        if (++windowCount > MAX_PROBES_PER_SECOND || message.length > 512) return;

        let data;
        try {
          data = JSON.parse(message.toString('utf8'));
        } catch (_) {
          return;
        }
        if (!data || data.t !== PROBE_MAGIC || data.v !== PROTOCOL || typeof data.id !== 'string' || data.id.length > 64) return;
        // Só responde a quem está na sub-rede do cabo
        if (!getAddresses().some((a) => inSubnet(remote.address, a.ip, a.prefix))) return;

        const reply = Buffer.from(JSON.stringify({
          t: REPLY_MAGIC,
          v: PROTOCOL,
          id: data.id,
          port: tcpPort,
          name: os.hostname().slice(0, 64)
        }));
        socket.send(reply, remote.port, remote.address, () => { });
      });

      socket.once('error', (err) => {
        try { socket.close(); } catch (_) { /* já fechado */ }
        const error = new Error(err && err.code === 'EADDRINUSE'
          ? `The discovery port (${DISCOVERY_PORT}) is already in use.`
          : 'Could not start the cable discovery.');
        error.code = 'DISCOVERY_FAILED';
        reject(error);
      });

      socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
        socket.removeAllListeners('error');
        socket.on('error', () => { });
        resolve({ stop() { try { socket.close(); } catch (_) { /* já fechado */ } } });
      });
    });
  }

  // ----------------------------------------------------------
  // BACKUP: procura o PRIMARY
  // ----------------------------------------------------------
  function probeOnce({ addresses, token, timeoutMs }) {
    return new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      const probe = Buffer.from(JSON.stringify({ t: PROBE_MAGIC, v: PROTOCOL, id }));
      const sockets = [];
      let done = false;
      let sendTimer = null;
      let watchTimer = null;

      const finish = (peer) => {
        if (done) return;
        done = true;
        clearInterval(sendTimer);
        clearInterval(watchTimer);
        sockets.forEach((s) => { try { s.close(); } catch (_) { /* já fechado */ } });
        resolve(peer || null);
      };

      const sendAll = () => {
        addresses.forEach((a, index) => {
          const socket = sockets[index];
          if (!socket || !socket.bound) return;
          [broadcastOf(a.ip, a.prefix), '255.255.255.255'].forEach((target) => {
            try { socket.send(probe, DISCOVERY_PORT, target, () => { }); } catch (_) { /* tenta no próximo ciclo */ }
          });
        });
      };

      addresses.forEach((a, index) => {
        const socket = dgram.createSocket('udp4');
        sockets[index] = socket;
        socket.on('error', () => { });
        socket.on('message', (message, remote) => {
          if (message.length > 512) return;
          let data;
          try {
            data = JSON.parse(message.toString('utf8'));
          } catch (_) {
            return;
          }
          if (!data || data.t !== REPLY_MAGIC || data.v !== PROTOCOL || data.id !== id) return;
          const port = Number(data.port);
          if (!Number.isInteger(port) || port < 1024 || port > 65535 || !isIpv4(remote.address)) return;
          finish({ ip: remote.address, port, name: String(data.name || remote.address).replace(/[<>]/g, '').slice(0, 64) });
        });
        socket.bind({ address: a.ip, port: 0 }, () => {
          try {
            socket.setBroadcast(true);
            socket.bound = true;
            sendAll();
          } catch (_) { /* este endereço não serve */ }
        });
      });

      sendTimer = setInterval(sendAll, PROBE_EVERY_MS);
      const endAt = Date.now() + timeoutMs;
      watchTimer = setInterval(() => {
        if (token.cancelled || Date.now() >= endAt) finish(null);
      }, 200);
    });
  }

  /**
   * Procura o PRIMARY pelo cabo. Sem administrador primeiro; se não achar e faltar a regra do
   * firewall (ou o endereço link-local, com IP fixo na placa), pede o UAC e tenta de novo.
   */
  async function findPrimary({ link, adapterIndex, tcpPort, token, onProgress }) {
    const progress = (text, step) => { if (onProgress) onProgress({ text, step }); };
    const started = Date.now();
    let addresses = link.addresses;

    progress('Looking for the primary PC…', 'search');
    let peer = await probeOnce({ addresses, token, timeoutMs: DISCOVERY_FAST_MS });
    if (peer || token.cancelled) return peer ? { ok: true, peer } : { ok: false, cancelled: true };

    const found = await detect(tcpPort, true);
    const adapter = found.ok ? found.adapters.find((a) => a.index === adapterIndex) : null;
    if (adapter) {
      const current = usableAddresses(adapter);
      const wantRules = !(found.rules && found.rules.udp === true);
      const wantIp = !current.some((a) => isLinkLocal(a.ip)) && current.every((a) => a.origin === 'Manual');
      if (wantRules || wantIp) {
        progress('Primary not found yet. Waiting for administrator approval (look for the Windows permission window)…', 'admin');
        await elevate({
          ifIndex: adapter.index,
          ip: wantIp ? linkLocalFor(adapter.mac, os.hostname()) : null,
          rules: wantRules,
          tcpPort
        });
        if (token.cancelled) return { ok: false, cancelled: true };
        await sleep(1500, token);
        const again = await detect(tcpPort);
        const refreshed = again.ok ? again.adapters.find((a) => a.index === adapterIndex) : null;
        if (refreshed && usableAddresses(refreshed).length) addresses = usableAddresses(refreshed);
      }
    }

    progress('Looking for the primary PC…', 'search');
    peer = await probeOnce({ addresses, token, timeoutMs: Math.max(5000, DISCOVERY_TOTAL_MS - (Date.now() - started)) });
    if (token.cancelled) return { ok: false, cancelled: true };
    if (!peer) {
      return {
        ok: false,
        error: 'The primary PC was not found. On the primary, choose "Ethernet cable" and click Start sharing, then check that the cable is plugged into both PCs.'
      };
    }
    return { ok: true, peer };
  }

  return { prepareLink, startResponder, findPrimary };
}

module.exports = {
  createEthernetLink,
  DISCOVERY_PORT,
  DEFAULT_TCP_PORT,
  // exportados para teste
  _internals: { inSubnet, broadcastOf, linkLocalFor, usableAddresses, buildElevatedScript, buildDetectScript, isSafeProgramPath, psQuote, runElevated, runPowerShell }
};
