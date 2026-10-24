// ============================================================
// backup-sync.js
// ============================================================
// DESCRIÇÃO: Espelhamento PRIMARY → BACKUP (somente operador).
// FUNÇÃO:
//   PRIMARY: observa o editor (digitação local, edições do roteirista, troca/
//            abertura/fechamento de documentos, estilo e ponto de leitura) e
//            envia cada mudança ao main (canal separado, porta 3002).
//   BACKUP : recebe as atualizações, aplica nos documentos espelhados
//            (somente leitura) e mantém o prompter no mesmo ponto.
//            "Take over" destrava os documentos e vira o operador principal.
// Independente do servidor do roteirista (remote.html / porta 3001).
// ============================================================

(function () {
  const { ipcRenderer } = require('electron');

  const DEFAULT_PORT = 3002;
  const SEND_THROTTLE_MS = 250;
  const POSITION_POLL_MS = 300;
  const MAX_HTML_LENGTH = 20 * 1024 * 1024;
  const STORAGE_HOST = 'promptiq.backup.host';
  const STORAGE_PORT = 'promptiq.backup.port';

  const state = {
    role: 'off',        // 'off' | 'primary' | 'backup'
    link: 'off',        // estado reportado pelo main
    clients: 0,
    error: '',
    addresses: [],
    port: DEFAULT_PORT,
    pin: '',
    lastActivityAt: 0
  };

  const getBridge = () => window.PromptiqBackupBridge || null;
  const $ = (id) => document.getElementById(id);

  // ============================================================
  // PRIMARY — captura e envio
  // ============================================================
  let observer = null;
  let sendTimer = null;
  let positionTimer = null;
  let seq = 0;
  let lastSignature = '';
  let lastActiveId = null;
  let lastPositionKey = '';
  const lastDocHash = new Map();

  function readStyle(editor) {
    if (!editor) return {};
    const s = editor.style;
    return {
      fontSize: s.fontSize || '',
      fontFamily: s.fontFamily || '',
      lineHeight: s.lineHeight || '',
      textAlign: s.textAlign || ''
    };
  }

  function snapshotDoc(bridge, id) {
    const editor = bridge.getEditor(id);
    const style = readStyle(editor);
    const html = editor ? bridge.getCleanHtml(editor) : '';
    return { html, style, hash: `${style.fontSize}|${style.fontFamily}|${style.lineHeight}|${style.textAlign}|${html}` };
  }

  function pushToBackups(message) {
    message.seq = ++seq;
    message.ts = Date.now();
    ipcRenderer.send('backup-push', message);
    state.lastActivityAt = Date.now();
  }

  function buildFull(bridge) {
    const docs = bridge.listDocuments().map((d) => {
      const snap = snapshotDoc(bridge, d.id);
      lastDocHash.set(d.id, snap.hash);
      return { key: String(d.id), name: d.name, html: snap.html, style: snap.style };
    });
    const activeId = bridge.getActiveId();
    return {
      type: 'full',
      activeKey: activeId == null ? '' : String(activeId),
      docs
    };
  }

  function pushFull() {
    const bridge = getBridge();
    if (!bridge) return;
    lastDocHash.clear();
    const list = bridge.listDocuments();
    lastSignature = list.map((d) => `${d.id}:${d.name}`).join('|');
    lastActiveId = bridge.getActiveId();
    lastPositionKey = '';
    pushToBackups(buildFull(bridge));
  }

  function collectAndSend() {
    sendTimer = null;
    const bridge = getBridge();
    if (!bridge || state.role !== 'primary' || state.clients === 0) return;

    const list = bridge.listDocuments();
    const signature = list.map((d) => `${d.id}:${d.name}`).join('|');
    if (signature !== lastSignature) {
      pushFull();
      return;
    }

    const activeId = bridge.getActiveId();
    if (activeId !== lastActiveId) {
      lastActiveId = activeId;
      lastPositionKey = '';
      pushToBackups({ type: 'active', key: activeId == null ? '' : String(activeId) });
    }
    if (activeId == null) return;

    const snap = snapshotDoc(bridge, activeId);
    if (lastDocHash.get(activeId) === snap.hash) return;
    lastDocHash.set(activeId, snap.hash);

    const doc = list.find((d) => d.id === activeId);
    pushToBackups({
      type: 'doc',
      key: String(activeId),
      name: doc ? doc.name : '',
      activeKey: String(activeId),
      html: snap.html,
      style: snap.style
    });
  }

  function scheduleSend() {
    if (sendTimer || state.role !== 'primary' || state.clients === 0) return;
    sendTimer = setTimeout(collectAndSend, SEND_THROTTLE_MS);
  }

  function pollPosition() {
    if (state.role !== 'primary' || state.clients === 0) return;
    const bridge = getBridge();
    const container = document.querySelector('.prompter-in-control');
    if (!bridge || !container || !container.clientHeight) return;

    const engine = window.ScrollEngine;
    const key = `${Math.round(container.scrollTop)}|${Math.round((engine && engine.decimalScroll) || 0)}`;
    if (key === lastPositionKey) return;

    const anchor = window.PromptiqReadAnchor ? window.PromptiqReadAnchor.capture() : null;
    if (!anchor) return;
    lastPositionKey = key;

    const activeId = bridge.getActiveId();
    pushToBackups({ type: 'pos', key: activeId == null ? '' : String(activeId), anchor });
  }

  function startPrimaryWatch() {
    stopPrimaryWatch();
    const container = $('document-content-container');
    const tabs = $('document-tabs-bar');
    observer = new MutationObserver(scheduleSend);
    const options = {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    };
    if (container) observer.observe(container, options);
    if (tabs) observer.observe(tabs, { childList: true, characterData: true, subtree: true });
    positionTimer = setInterval(pollPosition, POSITION_POLL_MS);
  }

  function stopPrimaryWatch() {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(sendTimer);
    sendTimer = null;
    clearInterval(positionTimer);
    positionTimer = null;
    lastDocHash.clear();
  }

  // ============================================================
  // BACKUP — recepção e aplicação
  // ============================================================
  const mirror = new Map(); // key do PRIMARY -> { localId, hash }
  let lastPosition = null;

  // O app roda com nodeIntegration: nada vindo da rede pode virar script no editor.
  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    tpl.content
      .querySelectorAll('script, iframe, frame, frameset, object, embed, applet, link, meta, base, style')
      .forEach((el) => el.remove());
    tpl.content.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = attr.value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
        const dangerousUrl =
          /^(javascript|vbscript|data:text\/html)/.test(value) &&
          ['href', 'src', 'xlink:href', 'action', 'formaction', 'srcdoc'].includes(name);
        if (name.startsWith('on') || name === 'srcdoc' || dangerousUrl) el.removeAttribute(attr.name);
      });
    });
    return tpl.innerHTML;
  }

  function sanitizeStyle(style) {
    const clean = {};
    ['fontSize', 'fontFamily', 'lineHeight', 'textAlign'].forEach((k) => {
      const v = style && style[k];
      clean[k] = typeof v === 'string' && v.length <= 200 ? v : '';
    });
    return clean;
  }

  function sanitizeName(name) {
    return String(name || 'Untitled').replace(/[<>]/g, '').slice(0, 200);
  }

  function upsertDoc(bridge, doc, force = false) {
    if (!doc || typeof doc.key !== 'string' || typeof doc.html !== 'string') return null;
    if (doc.html.length > MAX_HTML_LENGTH) return null;

    const html = sanitizeHtml(doc.html);
    const style = sanitizeStyle(doc.style);
    const name = sanitizeName(doc.name);
    const hash = `${style.fontSize}|${style.fontFamily}|${style.lineHeight}|${style.textAlign}|${html}`;

    let entry = mirror.get(doc.key);
    if (!entry || !bridge.hasDocument(entry.localId)) {
      const created = bridge.createDocument(html, name);
      entry = { localId: created.id, hash: null, style };
      mirror.set(doc.key, entry);
      bridge.setMirrorMode(created.id, true);
    } else if (doc.name) {
      bridge.renameDocument(entry.localId, name);
    }
    entry.style = style;

    // Em reenvios completos (conexão/divergência) reaplica sempre: o cache de hash não enxerga
    // alterações feitas no editor do backup depois da última aplicação.
    if (force || entry.hash !== hash) {
      bridge.applyContent(entry.localId, html, style);
      entry.hash = hash;
    }
    return entry;
  }

  function applyFull(bridge, message) {
    if (!Array.isArray(message.docs)) return;
    const present = new Set();

    message.docs.forEach((doc) => {
      if (upsertDoc(bridge, doc, true)) present.add(doc.key);
    });

    Array.from(mirror.keys()).forEach((key) => {
      if (present.has(key)) return;
      const entry = mirror.get(key);
      mirror.delete(key);
      if (bridge.hasDocument(entry.localId)) bridge.removeDocument(entry.localId);
    });

    activateKey(bridge, message.activeKey);
    bridge.syncPrompter();
  }

  function activateKey(bridge, key) {
    const entry = mirror.get(key);
    if (!entry || !bridge.hasDocument(entry.localId)) return;
    bridge.activateDocument(entry.localId);
    // O tamanho/fonte globais do app seguem o documento ativo.
    bridge.applyContent(entry.localId, null, entry.style);
  }

  function activeMirrorKey(bridge) {
    const activeId = bridge.getActiveId();
    for (const [key, entry] of mirror) {
      if (entry.localId === activeId) return key;
    }
    return null;
  }

  function applyPosition() {
    const bridge = getBridge();
    if (!bridge || !lastPosition || !window.PromptiqReadAnchor) return;
    if (document.body.classList.contains('operator-edit-mode')) return;
    if (activeMirrorKey(bridge) !== lastPosition.key) return;
    window.PromptiqReadAnchor.restore(lastPosition.anchor);
  }

  function handleIncoming(message) {
    const bridge = getBridge();
    if (!bridge || state.role !== 'backup' || !message) return;

    try {
      switch (message.type) {
        case 'full':
          applyFull(bridge, message);
          break;
        case 'doc': {
          const entry = upsertDoc(bridge, message);
          if (entry) {
            if (message.activeKey) activateKey(bridge, message.activeKey);
            bridge.syncPrompter();
          }
          break;
        }
        case 'active':
          activateKey(bridge, message.key);
          bridge.syncPrompter();
          break;
        case 'pos':
          if (message.anchor && typeof message.anchor === 'object') {
            lastPosition = { key: String(message.key), anchor: message.anchor };
            applyPosition();
          }
          return;
        case 'test':
          if (typeof message.id === 'string') answerProbe(message);
          return;
        default:
          return;
      }
      state.lastActivityAt = Date.now();
      applyPosition();
    } catch (err) {
      console.warn('[BackupSync] Falha ao aplicar atualização, pedindo reenvio completo', err);
      ipcRenderer.send('backup-request-resync');
    }
  }

  function unlockMirrors() {
    const bridge = getBridge();
    if (bridge) {
      mirror.forEach((entry) => {
        if (bridge.hasDocument(entry.localId)) bridge.setMirrorMode(entry.localId, false);
      });
    }
    mirror.clear();
    lastPosition = null;
  }

  // ============================================================
  // Teste de comunicação
  // ============================================================
  // Impressão digital do TEXTO (não do HTML): independe de normalizações de marcação.
  function textFingerprint(editor) {
    const text = ((editor && editor.textContent) || '').replace(/\s+/g, ' ').trim();
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`;
  }

  function buildProbe() {
    const bridge = getBridge();
    if (!bridge) return { docCount: 0, activeName: '', textHash: '' };
    const list = bridge.listDocuments();
    const activeId = bridge.getActiveId();
    const active = list.find((d) => d.id === activeId);
    return {
      docCount: list.length,
      activeName: active ? active.name : '',
      textHash: textFingerprint(activeId == null ? null : bridge.getEditor(activeId))
    };
  }

  function answerProbe(message) {
    const bridge = getBridge();
    const probe = message.probe || {};
    const mine = buildProbe();
    const inSync = !!bridge &&
      mine.docCount === probe.docCount &&
      mine.activeName === sanitizeName(probe.activeName) &&
      mine.textHash === probe.textHash;
    ipcRenderer.send('backup-test-reply', {
      id: message.id,
      inSync,
      docs: mine.docCount,
      activeName: mine.activeName
    });
  }

  function showTestResult(lines, level) {
    const box = $('backup-test-result');
    if (!box) return;
    box.className = `alert alert-${level} small mt-2 mb-0`;
    box.innerHTML = '';
    lines.forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      box.appendChild(div);
    });
  }

  async function runPrimaryTest() {
    showTestResult(['Testing…'], 'secondary');
    const result = await ipcRenderer.invoke('backup-run-test', buildProbe());
    if (!result.ok) {
      showTestResult([result.error], 'danger');
      return;
    }

    const lines = result.results.map((r) =>
      `${r.inSync ? '✔' : '⚠'} Backup ${r.ip} — ${r.rttMs} ms — ${r.docs} document${r.docs === 1 ? '' : 's'}` +
      `${r.inSync ? ' — content identical' : ' — content DIFFERS (resending everything)'}`
    );
    const missing = result.expected - result.results.length;
    if (missing > 0) lines.push(`✖ ${missing} backup${missing > 1 ? 's' : ''} did not answer in time.`);

    const diverged = result.results.some((r) => !r.inSync);
    if (diverged) pushFull();
    const ok = !missing && !diverged && result.results.length > 0;
    showTestResult(lines, ok ? 'success' : (missing ? 'danger' : 'warning'));
  }

  async function runBackupPing() {
    showTestResult(['Testing…'], 'secondary');
    const result = await ipcRenderer.invoke('backup-ping');
    showTestResult(
      result.ok ? [`✔ Primary reachable — ${result.rttMs} ms`] : [`✖ ${result.error}`],
      result.ok ? 'success' : 'danger'
    );
  }

  // ============================================================
  // Papéis (start / stop)
  // ============================================================
  async function startPrimary() {
    const result = await ipcRenderer.invoke('backup-start-primary', {
      port: Number(($('backup-primary-port') || {}).value) || DEFAULT_PORT
    });
    if (!result.ok) {
      state.error = result.error;
      render();
      return;
    }
    state.role = 'primary';
    state.addresses = result.addresses;
    state.port = result.port;
    state.pin = result.pin;
    state.link = 'listening';
    state.error = '';
    startPrimaryWatch();
    render();
    // Um backup pode ter conectado antes de este retorno chegar.
    if (state.clients > 0) pushFull();
  }

  async function startBackup() {
    const host = ($('backup-host').value || '').trim();
    const port = Number($('backup-port').value) || DEFAULT_PORT;
    const pin = ($('backup-pin').value || '').trim();

    const result = await ipcRenderer.invoke('backup-connect', { host, port, pin });
    if (!result.ok) {
      state.error = result.error;
      render();
      return;
    }
    localStorage.setItem(STORAGE_HOST, host);
    localStorage.setItem(STORAGE_PORT, String(port));
    state.role = 'backup';
    state.link = 'connecting';
    state.error = '';
    render();
  }

  async function stopRole() {
    stopPrimaryWatch();
    await ipcRenderer.invoke('backup-stop');
    if (state.role === 'backup') unlockMirrors();
    state.role = 'off';
    state.link = 'off';
    state.clients = 0;
    state.pin = '';
    state.error = '';
    render();
  }

  async function takeOver() {
    await stopRole();
    const modalEl = $('backupSyncModal');
    const modal = modalEl && window.bootstrap ? window.bootstrap.Modal.getInstance(modalEl) : null;
    if (modal) modal.hide();
  }

  // ============================================================
  // Interface
  // ============================================================
  function linkLabel() {
    if (state.role === 'primary') {
      return state.clients > 0
        ? { text: `Live · ${state.clients} backup${state.clients > 1 ? 's' : ''}`, cls: 'success' }
        : { text: 'Waiting for backup', cls: 'warning' };
    }
    if (state.role === 'backup') {
      switch (state.link) {
        case 'connected': return { text: 'Live · mirroring', cls: 'success' };
        case 'connecting': return { text: 'Connecting…', cls: 'warning' };
        case 'reconnecting': return { text: 'Reconnecting…', cls: 'warning' };
        case 'auth-failed': return { text: 'Not authorized', cls: 'danger' };
        default: return { text: 'Disconnected', cls: 'danger' };
      }
    }
    return { text: 'OFF', cls: 'danger' };
  }

  function formatAge(ts) {
    if (!ts) return 'no updates yet';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 2 ? 'just now' : `${s}s ago`;
  }

  function render() {
    const label = linkLabel();
    const active = state.role !== 'off';

    const badge = $('backup-sync-badge');
    if (badge) {
      badge.className = `badge bg-${label.cls} app-no-drag ms-2 ${active ? '' : 'd-none'}`;
      badge.style.cursor = 'pointer';
      badge.textContent = `${state.role === 'primary' ? 'PRIMARY' : 'BACKUP'} · ${label.text}`;
    }

    const statusText = $('backup-status-text');
    if (!statusText) return;
    statusText.textContent = active ? `${state.role.toUpperCase()} — ${label.text}` : 'OFF';
    $('backup-status-dot').className = `bi bi-circle-fill text-${label.cls}`;

    $('backup-role-primary').disabled = active;
    $('backup-role-backup').disabled = active;
    const asPrimary = active ? state.role === 'primary' : $('backup-role-primary').checked;
    if (active) {
      $('backup-role-primary').checked = state.role === 'primary';
      $('backup-role-backup').checked = state.role === 'backup';
    }
    $('backup-primary-panel').classList.toggle('d-none', !asPrimary);
    $('backup-backup-panel').classList.toggle('d-none', asPrimary);

    // PRIMARY
    const primaryOn = state.role === 'primary';
    $('backup-primary-info').classList.toggle('d-none', !primaryOn);
    $('backup-primary-port').disabled = primaryOn;
    $('backup-primary-toggle').innerHTML = primaryOn
      ? '<i class="bi bi-stop-circle me-1"></i> Stop sharing'
      : '<i class="bi bi-broadcast me-1"></i> Start sharing';
    $('backup-primary-toggle').className = `btn btn-sm ${primaryOn ? 'btn-danger' : 'btn-primary'}`;
    if (primaryOn) {
      $('backup-primary-addresses').textContent =
        state.addresses.map((a) => `${a.name}: ${a.ip}:${state.port}`).join('\n');
      $('backup-primary-pin').textContent = state.pin;
      $('backup-primary-clients').textContent =
        `${state.clients} connected · last update sent ${formatAge(state.lastActivityAt)}`;
    }

    // BACKUP
    const backupOn = state.role === 'backup';
    ['backup-host', 'backup-port', 'backup-pin'].forEach((id) => { $(id).disabled = backupOn; });
    $('backup-connect-toggle').innerHTML = backupOn
      ? '<i class="bi bi-plug me-1"></i> Disconnect'
      : '<i class="bi bi-plug-fill me-1"></i> Connect';
    $('backup-connect-toggle').className = `btn btn-sm ${backupOn ? 'btn-outline-danger' : 'btn-primary'}`;
    $('backup-takeover-btn').classList.toggle('d-none', !backupOn);
    $('backup-ping-btn').classList.toggle('d-none', !backupOn);
    $('backup-backup-info').classList.toggle('d-none', !backupOn);
    if (backupOn) {
      $('backup-backup-info').textContent = `Documents are read-only while mirroring · last update ${formatAge(state.lastActivityAt)}`;
    }

    const error = $('backup-error');
    error.textContent = state.error;
    error.classList.toggle('d-none', !state.error);
    if (!active) $('backup-test-result').className = 'd-none';
  }

  function openModal() {
    const modalEl = $('backupSyncModal');
    if (!modalEl || !window.bootstrap) return;
    render();
    window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }

  function init() {
    if (!$('backupSyncModal')) return;

    $('backup-host').value = localStorage.getItem(STORAGE_HOST) || '';
    $('backup-port').value = localStorage.getItem(STORAGE_PORT) || String(DEFAULT_PORT);
    $('backup-primary-port').value = String(DEFAULT_PORT);

    document.querySelectorAll('.menu-item[data-action="backup-sync"]').forEach((item) => {
      item.addEventListener('click', openModal);
    });
    const badge = $('backup-sync-badge');
    if (badge) badge.addEventListener('click', openModal);

    ['backup-role-primary', 'backup-role-backup'].forEach((id) => $(id).addEventListener('change', render));
    $('backup-primary-toggle').addEventListener('click', () => {
      state.error = '';
      (state.role === 'primary' ? stopRole() : startPrimary()).catch(console.error);
    });
    $('backup-connect-toggle').addEventListener('click', () => {
      state.error = '';
      (state.role === 'backup' ? stopRole() : startBackup()).catch(console.error);
    });
    $('backup-takeover-btn').addEventListener('click', () => takeOver().catch(console.error));
    $('backup-test-btn').addEventListener('click', () => runPrimaryTest().catch(console.error));
    $('backup-ping-btn').addEventListener('click', () => runBackupPing().catch(console.error));
    $('backup-copy-pin').addEventListener('click', () => {
      if (state.pin) navigator.clipboard.writeText(state.pin).catch(() => { });
    });

    ipcRenderer.on('backup:status', (_event, status) => {
      if (!status) return;
      if (status.state === 'auth-failed' && state.role === 'backup') {
        const reason = status.error;
        stopRole().then(() => {
          state.error = reason;
          render();
        });
        return;
      }
      state.link = status.state;
      state.clients = status.clients || 0;
      // O main encerrou o papel (ex.: janela fechada).
      if (status.role === 'off' && state.role !== 'off') {
        stopPrimaryWatch();
        if (state.role === 'backup') unlockMirrors();
        state.role = 'off';
      }
      render();
    });

    ipcRenderer.on('backup:request-full', () => {
      if (state.role === 'primary') pushFull();
    });
    ipcRenderer.on('backup:incoming', (_event, message) => handleIncoming(message));

    // Ao voltar para a aba/modo Operator no BACKUP, reaplica o último ponto de leitura.
    const operatorTab = $('operator-tab');
    if (operatorTab) operatorTab.addEventListener('shown.bs.tab', () => setTimeout(applyPosition, 120));
    window.addEventListener('operator-edit-mode-changed', () => setTimeout(applyPosition, 120));

    setInterval(() => {
      if (state.role !== 'off') render();
    }, 1000);

    // Começa sempre do zero: um recarregamento da janela não pode deixar o main com um papel antigo.
    ipcRenderer.invoke('backup-stop', { ownerOnly: true }).catch(() => { });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
