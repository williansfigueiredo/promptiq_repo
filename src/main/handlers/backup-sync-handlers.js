// ============================================================
// backup-sync-handlers.js
// ============================================================
// DESCRIÇÃO: Espelhamento PRIMARY → BACKUP entre dois PromptIQ.
// FUNÇÃO: Canal totalmente separado do servidor do roteirista (porta 3001 /
//         remote.html). Só o operador do software usa este canal:
//   - PRIMARY: abre um servidor Socket.IO (porta 3002) protegido por PIN e
//              repassa aos backups tudo o que o renderer enviar.
//   - BACKUP : conecta no PRIMARY por IP + PIN e entrega ao renderer cada
//              atualização recebida (somente leitura até "assumir").
// O fluxo é de mão única: o PRIMARY nunca aceita dados vindos do BACKUP.
// ============================================================

const { app, ipcMain } = require('electron');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

const DEFAULT_PORT = 3002;
const MAX_PIN_FAILURES = 5;
const LOCK_MS = 60 * 1000;
const TEST_TIMEOUT_MS = 5000;
const ALLOWED_TYPES = new Set(['full', 'doc', 'active', 'pos', 'test']);
const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;

// Placas virtuais (VPN de bancos, VMs, WSL, Docker, Bluetooth...) não servem para o backup conectar.
const VIRTUAL_ADAPTER = /loopback|virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|bluetooth|npcap|topaz|pseudo|teredo|isatap|tap-|tunnel|\btun\d*\b/i;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Endereços em que o outro PC realmente consegue conectar: Wi-Fi/Ethernet reais, em faixa
 * de rede privada. Se nada se encaixar, cai para qualquer IPv4 externo que não seja link-local.
 */
function listLocalAddresses() {
  const candidates = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family !== 'IPv4' || net.internal || net.address.startsWith('169.254.')) return;
      candidates.push({ name, ip: net.address });
    });
  });

  const preferred = candidates.filter((c) => !VIRTUAL_ADAPTER.test(c.name) && PRIVATE_IPV4.test(c.ip));
  if (preferred.length) return preferred;
  return candidates.filter((c) => !VIRTUAL_ADAPTER.test(c.name));
}

function cleanIp(address) {
  return String(address || '').replace(/^::ffff:/, '');
}

function initBackupSyncHandlers() {
  let role = 'off';          // 'off' | 'primary' | 'backup'
  let hostContents = null;   // webContents que "possui" o papel atual

  // PRIMARY
  let httpServer = null;
  let io = null;
  let pin = '';
  let connectedClients = 0;
  const failures = new Map(); // ip -> { count, until }

  // BACKUP
  let client = null;
  let reconnectTimer = null;

  // Testes de comunicação em andamento (PRIMARY): id -> { expected, results, resolve, timer }
  const pendingTests = new Map();

  let status = { role: 'off', state: 'off', clients: 0, host: '', port: 0, error: '' };

  function sendToRenderer(channel, payload) {
    if (hostContents && !hostContents.isDestroyed()) {
      hostContents.send(channel, payload);
    }
  }

  function publishStatus(patch = {}) {
    status = { ...status, role, ...patch };
    sendToRenderer('backup:status', status);
  }

  function pinMatches(given) {
    const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
    return crypto.timingSafeEqual(digest(given), digest(pin));
  }

  function isLocked(ip) {
    const entry = failures.get(ip);
    return !!entry && entry.until > Date.now();
  }

  function registerFailure(ip) {
    const entry = failures.get(ip) || { count: 0, until: 0 };
    if (entry.until && entry.until <= Date.now()) {
      entry.count = 0;
      entry.until = 0;
    }
    entry.count += 1;
    if (entry.count >= MAX_PIN_FAILURES) {
      entry.until = Date.now() + LOCK_MS;
      entry.count = 0;
    }
    failures.set(ip, entry);
  }

  function finishTest(id, error) {
    const test = pendingTests.get(id);
    if (!test) return;
    clearTimeout(test.timer);
    pendingTests.delete(id);
    test.resolve(error
      ? { ok: false, error }
      : { ok: true, expected: test.expected, results: test.results });
  }

  function stopAll() {
    Array.from(pendingTests.keys()).forEach((id) => finishTest(id, 'Sharing was stopped.'));
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      client.removeAllListeners();
      client.disconnect();
      client = null;
    }
    if (io) {
      io.close();
      io = null;
    }
    httpServer = null;
    pin = '';
    connectedClients = 0;
    failures.clear();
    role = 'off';
    publishStatus({ state: 'off', clients: 0, host: '', port: 0, error: '' });
    hostContents = null;
  }

  function bindHost(sender) {
    if (hostContents && hostContents !== sender) stopAll();
    if (hostContents === sender) return;
    hostContents = sender;
    sender.once('destroyed', () => {
      if (hostContents === sender) stopAll();
    });
  }

  // ============================================================
  // PRIMARY: inicia o servidor de espelhamento
  // ============================================================
  ipcMain.handle('backup-start-primary', async (event, options) => {
    stopAll();
    bindHost(event.sender);

    const requestedPort = Number(options && options.port);
    const port = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535
      ? requestedPort
      : DEFAULT_PORT;

    const addresses = listLocalAddresses();
    if (!addresses.length) {
      stopAll();
      return { ok: false, error: 'No active Wi-Fi or Ethernet network detected.' };
    }

    pin = String(crypto.randomInt(100000, 1000000));

    try {
      httpServer = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
      });

      io = new Server(httpServer, {
        perMessageDeflate: { threshold: 1024 },
        maxHttpBufferSize: 50 * 1024 * 1024,
        pingInterval: 3000,
        pingTimeout: 4000
      });

      io.use((socket, next) => {
        const ip = socket.handshake.address;
        if (isLocked(ip)) return next(new Error('locked'));
        const given = socket.handshake.auth && socket.handshake.auth.pin;
        if (!pinMatches(given)) {
          registerFailure(ip);
          return next(new Error('bad-pin'));
        }
        failures.delete(ip);
        next();
      });

      io.on('connection', (socket) => {
        connectedClients += 1;
        role = 'primary';
        publishStatus({ state: 'listening', clients: connectedClients });
        sendToRenderer('backup:request-full');

        // O backup só pode pedir reenvio, responder a testes e checar a conexão;
        // nunca escreve conteúdo no PRIMARY.
        socket.on('resync', () => sendToRenderer('backup:request-full'));

        socket.on('ping-test', (ack) => {
          if (typeof ack === 'function') ack();
        });

        socket.on('test-pong', (reply) => {
          const test = reply && pendingTests.get(reply.id);
          if (!test) return;
          test.results.push({
            ip: cleanIp(socket.handshake.address),
            rttMs: Date.now() - test.startedAt,
            inSync: reply.inSync === true,
            docs: Number(reply.docs) || 0,
            activeName: String(reply.activeName || '').slice(0, 120)
          });
          if (test.results.length >= test.expected) finishTest(reply.id);
        });

        socket.on('disconnect', () => {
          connectedClients = Math.max(0, connectedClients - 1);
          publishStatus({ clients: connectedClients });
        });
      });

      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '0.0.0.0', resolve);
      });

      role = 'primary';
      publishStatus({ state: 'listening', clients: 0, port, error: '' });
      return { ok: true, addresses, port, pin };
    } catch (err) {
      const message = err && err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use.`
        : (err && err.message) || 'Could not start the backup server.';
      stopAll();
      return { ok: false, error: message };
    }
  });

  // Renderer do PRIMARY → todos os backups conectados
  ipcMain.on('backup-push', (event, message) => {
    if (role !== 'primary' || !io || event.sender !== hostContents) return;
    if (!message || typeof message !== 'object' || message.type === 'test' || !ALLOWED_TYPES.has(message.type)) return;

    io.emit('sync', message);
  });

  // Teste de comunicação (PRIMARY): envia uma sonda pelo mesmo caminho do conteúdo e espera
  // cada backup responder, medindo o tempo de ida e volta e se o texto chegou igual.
  ipcMain.handle('backup-run-test', async (event, probe) => {
    if (role !== 'primary' || !io || event.sender !== hostContents) {
      return { ok: false, error: 'Sharing is not active.' };
    }
    if (connectedClients === 0) return { ok: false, error: 'No backup is connected.' };

    const id = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      pendingTests.set(id, {
        expected: connectedClients,
        results: [],
        startedAt: Date.now(),
        resolve,
        timer: setTimeout(() => finishTest(id), TEST_TIMEOUT_MS)
      });
      io.emit('sync', {
        type: 'test',
        id,
        probe: {
          docCount: Number(probe && probe.docCount) || 0,
          activeName: String((probe && probe.activeName) || '').slice(0, 120),
          textHash: String((probe && probe.textHash) || '')
        }
      });
    });
  });

  // ============================================================
  // BACKUP: conecta no PRIMARY
  // ============================================================
  ipcMain.handle('backup-connect', async (event, options) => {
    stopAll();

    const host = String((options && options.host) || '').trim();
    const port = Number(options && options.port);
    const givenPin = String((options && options.pin) || '').trim();

    if (!HOST_PATTERN.test(host)) return { ok: false, error: 'Invalid IP or host name.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Invalid port.' };
    if (!/^\d{6}$/.test(givenPin)) return { ok: false, error: 'The PIN has 6 digits.' };

    bindHost(event.sender);
    role = 'backup';
    publishStatus({ state: 'connecting', host, port, clients: 0, error: '' });

    client = ioClient(`http://${host}:${port}`, {
      auth: { pin: givenPin },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 5000
    });

    client.on('connect', () => publishStatus({ state: 'connected', error: '' }));

    client.on('sync', (message) => {
      if (message && typeof message === 'object' && ALLOWED_TYPES.has(message.type)) {
        sendToRenderer('backup:incoming', message);
      }
    });

    client.on('disconnect', (reason) => {
      publishStatus({ state: 'reconnecting', error: reason });
      // Se o PRIMARY encerrou o servidor, o Socket.IO não religa sozinho.
      if (reason === 'io server disconnect' && client) {
        reconnectTimer = setTimeout(() => {
          if (client) client.connect();
        }, 2000);
      }
    });

    client.on('connect_error', (err) => {
      if (err && (err.message === 'bad-pin' || err.message === 'locked')) {
        const reason = err.message === 'locked'
          ? 'Too many wrong PINs. Try again in 1 minute.'
          : 'Wrong PIN.';
        if (client) client.disconnect();
        publishStatus({ state: 'auth-failed', error: reason });
      } else {
        publishStatus({ state: 'reconnecting', error: (err && err.message) || 'Connection error' });
      }
    });

    return { ok: true };
  });

  // BACKUP pede um novo envio completo ao PRIMARY (ex.: ao detectar divergência)
  ipcMain.on('backup-request-resync', (event) => {
    if (role === 'backup' && client && client.connected && event.sender === hostContents) {
      client.emit('resync');
    }
  });

  // BACKUP responde à sonda do PRIMARY (o renderer já comparou o conteúdo)
  ipcMain.on('backup-test-reply', (event, reply) => {
    if (role !== 'backup' || !client || !client.connected || event.sender !== hostContents) return;
    if (!reply || typeof reply.id !== 'string') return;
    client.emit('test-pong', {
      id: reply.id,
      inSync: reply.inSync === true,
      docs: Number(reply.docs) || 0,
      activeName: String(reply.activeName || '').slice(0, 120)
    });
  });

  // BACKUP checa se o PRIMARY está alcançável e mede a latência
  ipcMain.handle('backup-ping', async (event) => {
    if (role !== 'backup' || !client || !client.connected || event.sender !== hostContents) {
      return { ok: false, error: 'Not connected to the primary.' };
    }
    const startedAt = Date.now();
    return new Promise((resolve) => {
      client.timeout(3000).emit('ping-test', (err) => {
        resolve(err ? { ok: false, error: 'The primary did not answer.' } : { ok: true, rttMs: Date.now() - startedAt });
      });
    });
  });

  ipcMain.handle('backup-stop', async (event, options) => {
    // Janelas que não são donas do papel não podem derrubá-lo (ex.: "New Window").
    if (options && options.ownerOnly && event.sender !== hostContents) return { ok: true };
    stopAll();
    return { ok: true };
  });

  ipcMain.handle('backup-status', async () => status);

  app.on('before-quit', stopAll);
}

module.exports = { initBackupSyncHandlers };
