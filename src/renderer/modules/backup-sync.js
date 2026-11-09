// ============================================================
// backup-sync.js
// ============================================================
// DESCRIÇÃO: Espelhamento PRIMARY ⇄ BACKUP (somente operador).
// FUNÇÃO:
//   PRIMARY: observa o editor (digitação local, edições do roteirista, troca/
//            abertura/fechamento de documentos, estilo e ponto de leitura) e
//            envia cada mudança ao main (canal separado, porta 3002). Também recebe, valida e
//            aplica as edições de texto que um backup enviar (duas vias).
//   BACKUP : recebe as atualizações, aplica nos documentos espelhados
//            (somente leitura) e mantém o prompter no mesmo ponto.
//            "Unlock editing" libera a edição; com "duas vias" o que se edita aqui também vai ao
//            PRIMARY (em conflito o PRIMARY vence e o texto do backup fica guardado em arquivo).
//            "Take over" destrava os documentos e vira o operador principal.
// Independente do servidor do roteirista (remote.html / porta 3001).
// ============================================================

(function () {
  const { ipcRenderer } = require('electron');

  const DEFAULT_PORT = 3002;
  const SEND_THROTTLE_MS = 250;
  const PROMPTER_SYNC_MS = 400;
  const PROMPTER_SYNC_EXTRA_MAX_MS = 1200;  // espera extra em roteiros grandes
  const PROMPTER_SYNC_MAX_WAIT_MS = 3000;   // mesmo digitando sem parar, o prompter atualiza a cada 3 s
  const SCROLL_POLL_MS = 100;
  const SCROLL_KEYFRAME_MS = 800;   // correção periódica enquanto o PRIMARY rola
  const DRIFT_HARD_PX = 150;          // acima disso o BACKUP salta para o ponto certo
  const DRIFT_DEADZONE_PX = 2;        // abaixo disso não corrige
  const DRIFT_CATCHUP_SECONDS = 1.5;  // tempo para absorver um desvio pequeno acelerando/freando
  const MAX_HTML_LENGTH = 20 * 1024 * 1024;
  const STORAGE_HOST = 'promptiq.backup.host';
  const STORAGE_PORT = 'promptiq.backup.port';
  const STORAGE_ACCEPT_EDITS = 'promptiq.backup.acceptEdits';
  const STORAGE_TWO_WAY = 'promptiq.backup.twoWay';
  const STORAGE_TRANSPORT = 'promptiq.backup.transport';

  const state = {
    role: 'off',        // 'off' | 'primary' | 'backup'
    link: 'off',        // estado reportado pelo main
    // Como os PCs se ligam: 'network' (Wi-Fi/LAN, digitando o IP) ou 'ethernet' (cabo direto, automático)
    transport: localStorage.getItem(STORAGE_TRANSPORT) === 'ethernet' ? 'ethernet' : 'network',
    preparing: false,   // cabo: detectando placa/endereço/permissão ou procurando o primary
    progress: '',       // texto do andamento da preparação
    step: 0,            // cabo: etapa atual do passo-a-passo (0 = cabo, 1 = endereço, ...)
    ethLink: null,      // cabo: { adapter, ip, speed, peer? }
    ethWarning: '',     // cabo: aviso (ex.: permissão de administrador recusada)
    clients: 0,
    error: '',
    addresses: [],
    port: DEFAULT_PORT,
    pin: '',
    editing: false,     // BACKUP com o espelhamento pausado para permitir edição local
    // Duas vias: o PRIMARY aceita edições vindas do backup; o BACKUP envia as suas (com a edição liberada)
    acceptEdits: localStorage.getItem(STORAGE_ACCEPT_EDITS) !== '0',
    twoWay: localStorage.getItem(STORAGE_TWO_WAY) !== '0',
    editBlocked: false, // o PRIMARY recusou receber edições: as do backup ficam só neste PC
    editsAccepted: 0,   // PRIMARY: edições de backup aplicadas
    editsRejected: 0,   // PRIMARY: edições de backup recusadas (conflito etc.)
    lastEditAt: 0,      // PRIMARY: última edição de backup aplicada
    lastActivityAt: 0
  };

  // BACKUP com a edição liberada e o envio de edições ao PRIMARY ligado e aceito
  const twoWayActive = () => state.role === 'backup' && state.editing && state.twoWay && !state.editBlocked;
  // Há alguém para receber o que este PC observa no editor?
  const canSend = () => (state.role === 'primary' && state.clients > 0) || twoWayActive();

  const getBridge = () => window.PromptiqBackupBridge || null;
  const $ = (id) => document.getElementById(id);

  // ============================================================
  // PRIMARY — captura e envio
  // ============================================================
  let observer = null;
  let sendTimer = null;
  let scrollTimer = null;
  let seq = 0;
  let lastSignature = '';
  let lastActiveId = null;
  let lastScrollState = '';
  let lastScrollPx = 0;
  let lastScrollSentAt = 0;
  // Linha de base por documento = o que o BACKUP já tem. Só as diferenças viajam pela rede,
  // então digitar num roteiro grande custa o mesmo que num pequeno.
  const baselines = new Map(); // docId -> { sigs: string[], textLen, styleHash, pure }

  // Parágrafos que o observador viu mudar desde o último envio. Com poucas mudanças dentro de
  // parágrafos já conhecidos (digitação), só eles são comparados, sem reler o roteiro inteiro.
  const MAX_DIRTY_NODES = 40;
  const dirtyNodes = new Set();
  let needsFullScan = true;

  function noteMutations(records) {
    if (needsFullScan) return;
    const bridge = getBridge();
    const activeId = bridge ? bridge.getActiveId() : null;
    const editor = activeId == null ? null : bridge.getEditor(activeId);
    if (!editor || !canSend()) {
      needsFullScan = true;
      return;
    }
    for (const record of records) {
      let node = record.target;
      while (node && node.parentNode !== editor) node = node.parentNode;
      // Mudança no próprio editor (estrutura/estilo) ou fora dele (abas, outros documentos).
      if (!node || record.target === editor) {
        needsFullScan = true;
        return;
      }
      dirtyNodes.add(node);
      if (dirtyNodes.size > MAX_DIRTY_NODES) {
        needsFullScan = true;
        return;
      }
    }
  }

  function resetDirtyTracking() {
    dirtyNodes.clear();
    needsFullScan = false;
  }

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

  const styleHashOf = (s) => `${s.fontSize}|${s.fontFamily}|${s.lineHeight}|${s.textAlign}`;

  // Unidades de nível superior do editor. Textos adjacentes viram uma só (como ao reinterpretar
  // o HTML no BACKUP) e textos vazios são ignorados, para as contagens dos dois lados baterem.
  function topLevelUnits(editor) {
    const groups = [];
    const sigs = [];
    editor.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        if (!n.data) return;
        const last = groups.length - 1;
        if (last >= 0 && groups[last][0].nodeType === 3) {
          groups[last].push(n);
          sigs[last] += n.data;
          return;
        }
        groups.push([n]);
        sigs.push('#' + n.data);
        return;
      }
      groups.push([n]);
      sigs.push(n.nodeType === 1 ? n.outerHTML : '<!--' + n.data);
    });
    return { groups, sigs };
  }

  function groupsToHtml(bridge, groups) {
    const box = document.createElement('div');
    groups.forEach((group) => group.forEach((n) => box.appendChild(n.cloneNode(true))));
    return bridge.getCleanHtml(box); // mesma limpeza usada em todo o app (sem marcações de busca/leitura)
  }

  // Impressão digital (FNV-1a) do texto exato do documento. Os patches carregam a do texto-base: só
  // são aplicados se o texto de quem recebe for idêntico. A contagem de parágrafos + tamanho do
  // texto sozinhos podem coincidir por acaso quando os dois lados editam (ex.: trocar uma palavra
  // por outra do mesmo tamanho).
  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  // "pure": todo nível superior é um elemento (o caso normal: <p>/<div>). Só assim o índice da
  // unidade é o índice do nó, o que permite comparar apenas os parágrafos alterados.
  function makeBaseline(editor, style) {
    const { groups, sigs } = topLevelUnits(editor);
    const text = editor.textContent || '';
    return {
      sigs,
      textLen: text.length,
      textHash: hashText(text),
      styleHash: styleHashOf(style),
      pure: groups.every((g) => g.length === 1 && g[0].nodeType === 1)
    };
  }

  function pushToBackups(message, exceptSocketId) {
    message.seq = ++seq;
    message.ts = Date.now();
    ipcRenderer.send('backup-push', message, exceptSocketId || '');
    state.lastActivityAt = Date.now();
  }

  function buildFull(bridge) {
    baselines.clear();
    const docs = bridge.listDocuments().map((d) => {
      const editor = bridge.getEditor(d.id);
      const style = readStyle(editor);
      if (editor) baselines.set(d.id, makeBaseline(editor, style));
      return { key: String(d.id), name: d.name, html: editor ? bridge.getCleanHtml(editor) : '', style };
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
    const list = bridge.listDocuments();
    lastSignature = list.map((d) => `${d.id}:${d.name}`).join('|');
    lastActiveId = bridge.getActiveId();
    lastScrollState = '';
    pushToBackups(buildFull(bridge));
    resetDirtyTracking();
  }

  function makePatch(id, name, base, change) {
    return {
      type: 'patch',
      key: String(id),
      name,
      activeKey: String(id),
      baseCount: base.sigs.length,
      baseLen: base.textLen,
      baseHash: base.textHash,
      start: change.start,
      remove: change.remove,
      count: change.count,
      html: change.html,
      style: change.style
    };
  }

  // Caminho rápido: só compara os parágrafos marcados pelo observador. Devolve null (nada mudou),
  // undefined (não dá para usar o caminho rápido) ou o patch.
  function buildPatchFast(bridge, id, name, editor, base) {
    if (needsFullScan || !base.pure || editor.childNodes.length !== base.sigs.length) return undefined;
    const style = readStyle(editor);
    if (styleHashOf(style) !== base.styleHash) return undefined;

    const changed = new Map(); // índice -> nova assinatura
    for (const node of dirtyNodes) {
      if (node.nodeType !== 1 || node.parentNode !== editor) return undefined;
      const index = Array.prototype.indexOf.call(editor.childNodes, node);
      if (index < 0) return undefined;
      const sig = node.outerHTML;
      if (sig !== base.sigs[index]) changed.set(index, sig);
    }
    if (!changed.size) return null;

    const indexes = Array.from(changed.keys());
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    const groups = [];
    for (let i = first; i <= last; i++) groups.push([editor.childNodes[i]]);

    const patch = makePatch(id, name, base, {
      start: first,
      remove: last - first + 1,
      count: base.sigs.length,
      html: groupsToHtml(bridge, groups),
      style
    });
    changed.forEach((sig, index) => { base.sigs[index] = sig; });
    const text = editor.textContent || '';
    base.textLen = text.length;
    base.textHash = hashText(text);
    return patch;
  }

  // Caminho completo: compara todas as unidades (estrutura mudou, estilo, texto solto...).
  function buildPatchFull(bridge, id, name, editor, base) {
    const { groups, sigs } = topLevelUnits(editor);
    const style = readStyle(editor);
    const styleHash = styleHashOf(style);

    const max = Math.min(base.sigs.length, sigs.length);
    let start = 0;
    while (start < max && base.sigs[start] === sigs[start]) start++;
    let tail = 0;
    while (tail < max - start &&
      base.sigs[base.sigs.length - 1 - tail] === sigs[sigs.length - 1 - tail]) tail++;

    const removed = base.sigs.length - start - tail;
    const added = sigs.length - start - tail;
    if (!removed && !added && styleHash === base.styleHash) return null;

    const patch = makePatch(id, name, base, {
      start,
      remove: removed,
      count: sigs.length,
      html: groupsToHtml(bridge, groups.slice(start, start + added)),
      style
    });
    baselines.set(id, makeBaseline(editor, style));
    return patch;
  }

  // null = nada mudou; undefined = sem linha de base (precisa de reenvio completo).
  function buildPatch(bridge, id, name) {
    const editor = bridge.getEditor(id);
    const base = baselines.get(id);
    if (!editor || !base) return undefined;

    const fast = buildPatchFast(bridge, id, name, editor, base);
    return fast !== undefined ? fast : buildPatchFull(bridge, id, name, editor, base);
  }

  function collectAndSend() {
    sendTimer = null;
    if (state.role === 'backup') {
      collectAndSendEdit();
      return;
    }
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
      lastScrollState = '';
      needsFullScan = true;
      pushToBackups({ type: 'active', key: activeId == null ? '' : String(activeId) });
    }
    if (activeId == null) return;

    const doc = list.find((d) => d.id === activeId);
    const patch = buildPatch(bridge, activeId, doc ? doc.name : '');
    if (patch === undefined) {
      pushFull();
      return;
    }
    resetDirtyTracking();
    if (patch) pushToBackups(patch);
  }

  function scheduleSend() {
    if (sendTimer || !canSend()) return;
    sendTimer = setTimeout(collectAndSend, SEND_THROTTLE_MS);
  }

  // Rolagem: o PRIMARY informa só "está rodando? a que velocidade? onde está?". O BACKUP roda o
  // próprio motor na mesma velocidade (suave, 60 fps) e usa estas mensagens apenas para corrigir
  // desvios, em vez de saltar para cada posição recebida.
  function pollScroll() {
    if (state.role !== 'primary' || state.clients === 0) return;
    const bridge = getBridge();
    const engine = window.ScrollEngine;
    const container = document.querySelector('.prompter-in-control');
    const control = document.getElementById('prompterText-control');
    if (!bridge || !engine || !container || !control || !container.clientHeight) return;

    const running = !!engine.isRunning;
    const speed = engine.speed || 0;
    const px = running ? (engine.decimalScroll || 0) : (container.scrollTop || 0);
    const stateKey = `${running}|${speed}`;
    const now = Date.now();

    const stateChanged = stateKey !== lastScrollState;
    const keyframeDue = running && now - lastScrollSentAt >= SCROLL_KEYFRAME_MS;
    const movedManually = !running && Math.abs(px - lastScrollPx) >= 1;
    if (!stateChanged && !keyframeDue && !movedManually) return;

    lastScrollState = stateKey;
    lastScrollPx = px;
    lastScrollSentAt = now;

    const contentHeight = control.offsetHeight || 1;
    const activeId = bridge.getActiveId();
    pushToBackups({
      type: 'scroll',
      key: activeId == null ? '' : String(activeId),
      running,
      speed,
      ratio: px / contentHeight,
      contentHeight,
      anchor: window.PromptiqReadAnchor ? window.PromptiqReadAnchor.capture() : null
    });
  }

  function startPrimaryWatch(withScroll = true) {
    stopPrimaryWatch();
    const container = $('document-content-container');
    const tabs = $('document-tabs-bar');
    observer = new MutationObserver((records) => {
      noteMutations(records);
      scheduleSend();
    });
    const options = { childList: true, characterData: true, subtree: true, attributes: true };
    if (container) observer.observe(container, options);
    if (tabs) observer.observe(tabs, { childList: true, characterData: true, subtree: true });
    if (withScroll) scrollTimer = setInterval(pollScroll, SCROLL_POLL_MS);
  }

  function stopPrimaryWatch() {
    if (observer) observer.disconnect();
    observer = null;
    needsFullScan = true;
    dirtyNodes.clear();
    clearTimeout(sendTimer);
    sendTimer = null;
    clearInterval(scrollTimer);
    scrollTimer = null;
    baselines.clear();
  }

  // ============================================================
  // PRIMARY — edições vindas do backup (duas vias)
  // ============================================================
  // O backup (com a edição liberada) envia as alterações de texto como patches por parágrafo. O
  // PRIMARY só aplica se a base do patch for exatamente o texto que ele tem agora (nada de
  // "última escrita vence" às cegas): em caso de conflito o texto do PRIMARY prevalece e o backup
  // guarda o que digitou como cópia. Estilo (fonte, tamanho) nunca é aceito do backup.
  let editSyncTimer = null;

  function scheduleEditSync(bridge, docId) {
    clearTimeout(editSyncTimer);
    editSyncTimer = setTimeout(() => {
      editSyncTimer = null;
      if (state.role === 'primary' && bridge.getActiveId() === docId) bridge.syncPrompter(true);
    }, PROMPTER_SYNC_MS);
  }

  function handleIncomingEdit(info) {
    const bridge = getBridge();
    if (!bridge || state.role !== 'primary' || !info || !info.message) return;
    const socketId = String(info.socketId || '');
    const message = info.message;

    const reject = (reason, resync = true) => {
      state.editsRejected += 1;
      ipcRenderer.send('backup-reject-edit', { socketId, key: message.key, reason });
      // O backup volta ao texto do PRIMARY (o que ele digitou fica guardado como cópia)
      if (resync) pushFull();
    };

    if (!state.acceptEdits) return reject('disabled', false);

    const whole = (v) => Number.isInteger(v) && v >= 0;
    if (message.type !== 'patch' || typeof message.key !== 'string' || typeof message.html !== 'string' ||
      message.html.length > MAX_HTML_LENGTH ||
      !whole(message.baseCount) || !whole(message.baseLen) || !whole(message.start) ||
      !whole(message.remove) || !whole(message.count)) {
      return reject('invalid');
    }

    const doc = bridge.listDocuments().find((d) => String(d.id) === message.key);
    if (!doc) return reject('missing');

    // O que este PC ainda não mandou aos backups sai ANTES: a edição recebida é aplicada sobre o
    // estado que os backups já conhecem.
    if (sendTimer) {
      clearTimeout(sendTimer);
      collectAndSend();
    }

    // O texto-base do backup precisa ser exatamente o que este PC tem agora
    const current = bridge.getEditor(doc.id);
    if (typeof message.baseHash !== 'number' || !current || hashText(current.textContent || '') !== message.baseHash) {
      return reject('conflict');
    }

    const applied = bridge.patchEditorNodes(doc.id, {
      baseCount: message.baseCount,
      baseLen: message.baseLen,
      start: message.start,
      remove: message.remove,
      count: message.count,
      nodes: Array.from(sanitizeFragment(message.html).content.childNodes)
    });
    if (!applied) return reject('conflict');

    // A edição já é conhecida por todos os backups (o que a enviou a tem; os demais recebem o
    // repasse abaixo): é a nova linha de base e não gera um segundo envio.
    const editor = bridge.getEditor(doc.id);
    const style = readStyle(editor);
    baselines.set(doc.id, makeBaseline(editor, style));
    needsFullScan = true;

    bridge.markModified(doc.id);
    state.editsAccepted += 1;
    state.lastEditAt = Date.now();
    scheduleEditSync(bridge, doc.id);

    const activeId = bridge.getActiveId();
    pushToBackups({
      type: 'patch',
      key: message.key,
      name: doc.name,
      activeKey: activeId == null ? '' : String(activeId),
      baseCount: message.baseCount,
      baseLen: message.baseLen,
      baseHash: message.baseHash,
      start: message.start,
      remove: message.remove,
      count: message.count,
      html: message.html,
      style
    }, socketId);
  }

  // ============================================================
  // BACKUP — envio das edições ao PRIMARY (duas vias)
  // ============================================================
  const editedLocalIds = new Set(); // documentos em que o usuário digitou desde o último envio

  function keyOfLocalDoc(localId) {
    for (const [key, entry] of mirror) {
      if (entry.localId === localId) return key;
    }
    return null;
  }

  // Linha de base = o texto que o PRIMARY tem. Só as diferenças em relação a ela viajam.
  function rebaselineMirrorDoc(bridge, localId) {
    const editor = bridge.getEditor(localId);
    if (editor) baselines.set(localId, makeBaseline(editor, readStyle(editor)));
  }

  function rebaselineAllMirrors(bridge) {
    mirror.forEach((entry) => {
      if (bridge.hasDocument(entry.localId)) rebaselineMirrorDoc(bridge, entry.localId);
    });
    needsFullScan = true;
  }

  function collectAndSendEdit() {
    sendTimer = null;
    const bridge = getBridge();
    if (!bridge || !twoWayActive()) return;

    const ids = new Set(editedLocalIds);
    editedLocalIds.clear();
    const activeId = bridge.getActiveId();
    if (activeId != null) ids.add(activeId);
    const names = new Map(bridge.listDocuments().map((d) => [d.id, d.name]));

    ids.forEach((localId) => {
      const key = keyOfLocalDoc(localId);
      if (!key || !bridge.hasDocument(localId)) return;
      const patch = buildPatch(bridge, localId, names.get(localId) || '');
      if (patch === undefined) {
        rebaselineMirrorDoc(bridge, localId); // sem linha de base (documento novo): começa daqui
        return;
      }
      if (!patch) return;
      patch.key = key;
      patch.activeKey = key;
      ipcRenderer.send('backup-send-edit', patch);
      state.lastActivityAt = Date.now();
    });
    resetDirtyTracking();
  }

  // Envia já o que estiver pendente (antes de aplicar algo do PRIMARY, de retomar o espelho...)
  function flushPendingEdits() {
    if (!twoWayActive()) return;
    clearTimeout(sendTimer);
    sendTimer = null;
    collectAndSendEdit();
  }

  // ============================================================
  // BACKUP — recepção e aplicação
  // ============================================================
  const mirror = new Map(); // key do PRIMARY -> { localId, hash }
  let lastScroll = null;    // { msg, receivedAt } — última mensagem de rolagem recebida

  // O app roda com nodeIntegration: nada vindo da rede pode virar script no editor.
  function sanitizeFragment(html) {
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
    return tpl;
  }

  const sanitizeHtml = (html) => sanitizeFragment(html).innerHTML;

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
      bridge.setMirrorMode(created.id, !state.editing); // com a edição liberada, o novo documento também é editável
    } else if (doc.name) {
      bridge.renameDocument(entry.localId, name);
    }
    entry.style = style;

    // Em reenvios completos (conexão/divergência) reaplica sempre: o cache de hash não enxerga
    // alterações feitas no editor do backup depois da última aplicação. Editando, só se o texto
    // daqui realmente difere (reaplicar derrubaria o cursor e o desfazer sem necessidade).
    if (force || entry.hash !== hash) {
      const editorNow = state.editing ? bridge.getEditor(entry.localId) : null;
      const same = editorNow && (bridge.getCleanHtml(editorNow) || '').trim() === html.trim();
      if (same) {
        bridge.applyContent(entry.localId, null, style);
      } else {
        bridge.applyContent(entry.localId, html, style);
      }
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
    if (twoWayActive()) rebaselineAllMirrors(bridge);
  }

  function activateKey(bridge, key) {
    // Editando, quem escolhe o documento da tela é o usuário (o do PRIMARY não "puxa" a aba)
    if (state.editing) return;
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

  function sanitizeScroll(message) {
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const a = message.anchor;
    const anchor = a && typeof a === 'object' && Number.isFinite(a.idx) && Number.isFinite(a.fraction)
      ? {
        idx: a.idx,
        totalBlocks: num(a.totalBlocks, 0),
        fraction: Math.max(0, Math.min(1, a.fraction)),
        text: typeof a.text === 'string' ? a.text.slice(0, 120) : '',
        prevText: typeof a.prevText === 'string' ? a.prevText.slice(0, 120) : '',
        nextText: typeof a.nextText === 'string' ? a.nextText.slice(0, 120) : ''
      }
      : null;
    return {
      key: String(message.key),
      running: message.running === true,
      speed: Math.max(-100, Math.min(100, Math.round(num(message.speed, 0)))),
      ratio: Math.max(0, num(message.ratio, 0)),
      contentHeight: Math.max(1, num(message.contentHeight, 1)),
      anchor
    };
  }

  function setScrollPx(container, control, px) {
    const engine = window.ScrollEngine;
    engine.decimalScroll = px;
    if (engine.isRunning) {
      control.style.transform = `translate3d(0, ${-px}px, 0)`;
    } else {
      control.style.transform = 'none';
      container.style.overflowY = 'auto';
      container.scrollTop = px;
    }
    ipcRenderer.send('sync-scroll-position', {
      textPercent: Math.min(1, Math.max(0, px / (control.offsetHeight || 1)))
    });
  }

  function setMirroredSpeed(speed) {
    const engine = window.ScrollEngine;
    if (engine.speed === speed) return;
    engine.setSpeed(speed);
    ipcRenderer.send('control-prompter', { command: 'speed', value: speed });
  }

  // Para a rolagem que o espelhamento iniciou e devolve o motor ao comportamento normal.
  function releaseMirroredScroll() {
    const engine = window.ScrollEngine;
    if (!engine) return;
    engine.speedScale = 1;
    if (engine.isRunning) {
      engine.pause();
      ipcRenderer.send('control-prompter', 'pause');
    }
  }

  function mirrorScroll() {
    const bridge = getBridge();
    const engine = window.ScrollEngine;
    if (!bridge || !engine || !lastScroll || state.editing) return;

    const { msg, receivedAt } = lastScroll;
    if (activeMirrorKey(bridge) !== msg.key) return;
    if (document.body.classList.contains('operator-edit-mode')) return;

    const container = document.querySelector('.prompter-in-control');
    const control = document.getElementById('prompterText-control');
    if (!container || !control || !container.clientHeight) return; // prompter oculto: reaplica ao voltar

    // Janelas/fontes diferentes geram alturas diferentes: a velocidade acompanha a proporção.
    const contentHeight = control.offsetHeight || 1;
    const scale = Math.max(0.2, Math.min(5, contentHeight / msg.contentHeight));
    const ageMs = Date.now() - receivedAt;

    let target = bridge.anchorScrollTarget ? bridge.anchorScrollTarget(msg.anchor) : null;
    if (target == null) target = msg.ratio * contentHeight;
    if (msg.running) target += (msg.speed * 3 * scale * ageMs) / 1000;
    target = Math.max(0, target);

    if (!msg.running) {
      releaseMirroredScroll();
      setMirroredSpeed(msg.speed);
      setScrollPx(container, control, target);
      return;
    }

    engine.speedScale = scale;
    setMirroredSpeed(msg.speed);

    if (!engine.isRunning) {
      setScrollPx(container, control, target);
      engine.start();
      ipcRenderer.send('control-prompter', 'play');
      return;
    }

    const drift = target - engine.decimalScroll;
    if (Math.abs(drift) > DRIFT_HARD_PX) {
      setScrollPx(container, control, target);
      return;
    }

    // Desvio pequeno: acelera/freia de leve até alcançar, sem nenhum salto visível.
    const pxPerSecond = msg.speed * 3 * scale;
    if (pxPerSecond !== 0 && Math.abs(drift) > DRIFT_DEADZONE_PX) {
      const correction = (drift / DRIFT_CATCHUP_SECONDS) / pxPerSecond;
      engine.speedScale = scale * (1 + Math.max(-0.3, Math.min(0.3, correction)));
    }
  }

  // Aplica só o trecho que mudou no PRIMARY. Qualquer incoerência pede um reenvio completo.
  function applyPatch(bridge, message) {
    const entry = mirror.get(message.key);
    const whole = (v) => Number.isInteger(v) && v >= 0;
    if (!entry || !bridge.hasDocument(entry.localId) || typeof message.html !== 'string' ||
      message.html.length > MAX_HTML_LENGTH ||
      !whole(message.baseCount) || !whole(message.baseLen) || !whole(message.start) ||
      !whole(message.remove) || !whole(message.count)) {
      requestResync();
      return;
    }

    // O texto-base do PRIMARY precisa ser idêntico ao daqui (contagem + tamanho podem coincidir
    // por acaso quando os dois lados editam)
    const current = bridge.getEditor(entry.localId);
    if (typeof message.baseHash === 'number' && current && hashText(current.textContent || '') !== message.baseHash) {
      requestResync();
      return;
    }

    const ok = bridge.patchEditorNodes(entry.localId, {
      baseCount: message.baseCount,
      baseLen: message.baseLen,
      start: message.start,
      remove: message.remove,
      count: message.count,
      nodes: Array.from(sanitizeFragment(message.html).content.childNodes)
    });
    if (!ok) {
      requestResync();
      return;
    }

    const style = sanitizeStyle(message.style);
    if (JSON.stringify(style) !== JSON.stringify(entry.style)) {
      bridge.applyContent(entry.localId, null, style);
      entry.style = style;
    }
    if (message.name) bridge.renameDocument(entry.localId, sanitizeName(message.name));
    entry.hash = null; // o conteúdo mudou: o cache do último "doc" completo não vale mais
    if (twoWayActive()) rebaselineMirrorDoc(bridge, entry.localId); // o que veio do PRIMARY não é "edição minha"
    if (message.activeKey && activeMirrorKey(bridge) !== message.activeKey) activateKey(bridge, message.activeKey);
    schedulePrompterSync(message.baseLen);
  }

  let lastResyncAt = 0;
  function requestResync() {
    const now = Date.now();
    if (now - lastResyncAt < 1000) return;
    lastResyncAt = now;
    ipcRenderer.send('backup-request-resync');
  }

  // O prompter do backup é refeito só quando o PRIMARY dá uma pausa na digitação (ou após um teto
  // de espera), com espera proporcional ao tamanho do roteiro. Refazer o prompter é a parte mais
  // cara (~100 ms num roteiro de 3000 parágrafos) e não precisa acompanhar cada tecla.
  let prompterSyncTimer = null;
  let prompterSyncFirstAt = 0;
  function schedulePrompterSync(textLength = 0) {
    const now = Date.now();
    if (!prompterSyncTimer) prompterSyncFirstAt = now;
    clearTimeout(prompterSyncTimer);
    const wanted = PROMPTER_SYNC_MS + Math.min(PROMPTER_SYNC_EXTRA_MAX_MS, textLength / 200);
    const delay = Math.max(0, Math.min(wanted, prompterSyncFirstAt + PROMPTER_SYNC_MAX_WAIT_MS - now));
    prompterSyncTimer = setTimeout(() => {
      prompterSyncTimer = null;
      const bridge = getBridge();
      if (bridge && state.role === 'backup' && !(state.editing && !twoWayActive())) bridge.syncPrompter();
    }, delay);
  }

  function handleIncoming(message) {
    const bridge = getBridge();
    if (!bridge || state.role !== 'backup' || !message) return;
    // Edição liberada SEM duas vias: nada do PRIMARY sobrescreve o texto daqui (exceto o teste).
    if (state.editing && !twoWayActive() && message.type !== 'test') return;

    // Duas vias: o que foi digitado aqui e ainda não saiu vai ANTES de qualquer mudança vinda do
    // PRIMARY; num reenvio completo, uma cópia do que há aqui é guardada antes de ele valer.
    if (twoWayActive() && (message.type === 'full' || message.type === 'doc' || message.type === 'patch')) {
      flushPendingEdits();
      if (message.type === 'full') saveConflictCopies(bridge, message);
    }

    try {
      switch (message.type) {
        case 'full':
          applyFull(bridge, message);
          scheduleCopySave(800);
          break;
        case 'doc': {
          const entry = upsertDoc(bridge, message);
          if (entry) {
            if (message.activeKey) activateKey(bridge, message.activeKey);
            bridge.syncPrompter();
            if (twoWayActive()) rebaselineMirrorDoc(bridge, entry.localId);
            scheduleCopySave(800);
          }
          break;
        }
        case 'patch':
          applyPatch(bridge, message);
          state.lastActivityAt = Date.now();
          scheduleCopySave();
          return;
        case 'active':
          activateKey(bridge, message.key);
          bridge.syncPrompter();
          break;
        case 'scroll':
          if (typeof message.ratio === 'number' && Number.isFinite(message.ratio)) {
            lastScroll = { msg: sanitizeScroll(message), receivedAt: Date.now() };
            mirrorScroll();
          }
          return;
        case 'test':
          if (typeof message.id === 'string') answerProbe(message);
          return;
        default:
          return;
      }
      state.lastActivityAt = Date.now();
      mirrorScroll();
    } catch (err) {
      console.warn('[BackupSync] Falha ao aplicar atualização, pedindo reenvio completo', err);
      requestResync();
    }
  }

  // ============================================================
  // BACKUP — cópia local em arquivo
  // ============================================================
  // Cada documento recebido também é gravado em disco neste PC (ver backup-copy-store.js), para que
  // uma falha/fechamento do app aqui não perca o roteiro. O que for EDITADO neste PC vai para uma
  // cópia separada ("Edited on backup") e nunca é sobrescrito pelo espelho.
  const COPY_DEBOUNCE_MS = 3000;
  const COPY_MAX_WAIT_MS = 10000;
  const copies = { timer: null, firstAt: 0, lastSavedAt: 0, error: '', dir: '', editSession: '', notice: '', noticeAt: 0 };

  function collectCopyDocs(bridge) {
    const names = new Map(bridge.listDocuments().map((d) => [d.id, d.name]));
    const docs = [];
    mirror.forEach((entry, key) => {
      if (!bridge.hasDocument(entry.localId)) return;
      const editor = bridge.getEditor(entry.localId);
      if (!editor) return;
      const html = (bridge.getCleanHtml(editor) || editor.innerHTML || '').trim();
      docs.push({ key, entry, name: names.get(entry.localId) || 'Untitled', html });
    });
    return docs;
  }

  function noteCopyResult(result, docs, markField) {
    if (!result) return;
    if (result.dir) copies.dir = result.dir;
    const failed = new Set((result.errors || []).map((e) => e.key));
    docs.forEach((d) => { if (!failed.has(d.key)) d.entry[markField] = d.html; });
    if (result.errors && result.errors.length) {
      copies.error = result.errors[0].error || 'Could not write the local copy.';
    } else {
      copies.error = '';
      if (result.saved) copies.lastSavedAt = Date.now();
    }
  }

  // Espelho (texto do PRIMARY) -> <Nome>.ptq. A coleta é síncrona: roda antes de qualquer mudança de estado.
  // Em duas vias o texto daqui é o texto compartilhado, então o espelho em disco segue em dia.
  async function saveMirrorCopies() {
    const bridge = getBridge();
    if (!bridge || state.role !== 'backup' || (state.editing && !twoWayActive())) return null;
    const docs = collectCopyDocs(bridge).filter((d) => d.entry.savedHtml !== d.html);
    if (!docs.length) return null;
    const result = await ipcRenderer.invoke('backup-save-copies', {
      kind: 'mirror',
      docs: docs.map(({ key, name, html }) => ({ key, name, html }))
    });
    noteCopyResult(result, docs, 'savedHtml');
    return result;
  }

  // Texto editado NESTE PC (com o espelho pausado) -> pasta "Edited on backup"
  async function saveEditedCopies() {
    const bridge = getBridge();
    if (!bridge || state.role !== 'backup' || !copies.editSession) return null;
    const docs = collectCopyDocs(bridge).filter((d) => d.html !== d.entry.baseHtml && d.html !== d.entry.editedHtml);
    if (!docs.length) return null;
    const result = await ipcRenderer.invoke('backup-save-copies', {
      kind: 'edited',
      session: copies.editSession,
      docs: docs.map(({ key, name, html }) => ({ key, name, html }))
    });
    noteCopyResult(result, docs, 'editedHtml');
    return result;
  }

  function flushCopiesNow() {
    clearTimeout(copies.timer);
    copies.timer = null;
    const localOnly = state.editing && !twoWayActive(); // edição só neste PC: vai para "Edited on backup"
    return (localOnly ? saveEditedCopies() : saveMirrorCopies()).catch((err) => {
      copies.error = err.message;
      return null;
    });
  }

  // O texto deste backup está prestes a ser substituído pelo do PRIMARY e é diferente dele (uma
  // edição que perdeu a disputa, ou texto que ficou para trás): guarda uma cópia em arquivo próprio,
  // que nenhuma gravação posterior sobrescreve.
  const conflictSaved = new Map(); // key -> último html guardado como cópia de conflito
  function saveConflictCopies(bridge, message) {
    if (!Array.isArray(message.docs)) return;
    const names = new Map(bridge.listDocuments().map((d) => [d.id, d.name]));
    const docs = [];
    message.docs.forEach((incoming) => {
      const entry = mirror.get(incoming && incoming.key);
      if (!entry || !bridge.hasDocument(entry.localId) || typeof incoming.html !== 'string') return;
      const editor = bridge.getEditor(entry.localId);
      if (!editor) return;
      const mine = (bridge.getCleanHtml(editor) || '').trim();
      if (!mine || mine === sanitizeHtml(incoming.html).trim()) return;
      if (conflictSaved.get(incoming.key) === mine) return;
      conflictSaved.set(incoming.key, mine);
      docs.push({ key: incoming.key, name: names.get(entry.localId) || 'Untitled', html: mine });
    });
    if (!docs.length) return;
    ipcRenderer.invoke('backup-save-copies', { kind: 'edited', unique: true, docs }).then((result) => {
      if (result && result.dir) copies.dir = result.dir;
      if (result && result.errors && result.errors.length) copies.error = result.errors[0].error || 'Could not write the copy.';
    }).catch(() => { });
  }

  function scheduleCopySave(delay = COPY_DEBOUNCE_MS) {
    if (state.role !== 'backup') return;
    const now = Date.now();
    if (!copies.timer) copies.firstAt = now;
    clearTimeout(copies.timer);
    const wait = Math.max(0, Math.min(delay, copies.firstAt + COPY_MAX_WAIT_MS - now));
    copies.timer = setTimeout(() => {
      copies.timer = null;
      flushCopiesNow();
    }, wait);
  }

  // Ao fechar a janela não dá para esperar resposta assíncrona: grava de forma síncrona.
  function flushCopiesOnClose() {
    const bridge = getBridge();
    if (!bridge || state.role !== 'backup') return;
    try {
      const all = collectCopyDocs(bridge);
      const edited = state.editing && !twoWayActive();
      const docs = edited
        ? all.filter((d) => d.html !== d.entry.baseHtml && d.html !== d.entry.editedHtml)
        : all.filter((d) => d.entry.savedHtml !== d.html);
      if (!docs.length) return;
      const result = ipcRenderer.sendSync('backup-save-copies-sync', {
        kind: edited ? 'edited' : 'mirror',
        session: copies.editSession,
        docs: docs.map(({ key, name, html }) => ({ key, name, html }))
      });
      noteCopyResult(result, docs, edited ? 'editedHtml' : 'savedHtml');
    } catch (_) { /* fechando: nada a fazer */ }
  }

  function unlockMirrors() {
    const bridge = getBridge();
    releaseMirroredScroll();
    clearTimeout(prompterSyncTimer);
    prompterSyncTimer = null;
    if (bridge) {
      mirror.forEach((entry) => {
        if (bridge.hasDocument(entry.localId)) bridge.setMirrorMode(entry.localId, false);
      });
    }
    mirror.clear();
    lastScroll = null;
    state.editing = false;
    state.editBlocked = false;
    editedLocalIds.clear();
  }

  // Libera a edição local pausando o espelhamento. Com "duas vias", o que for editado aqui também é
  // aplicado no PRIMARY (e o que o PRIMARY mudar continua chegando). Ao retomar, o que foi editado
  // é salvo numa cópia separada ANTES de o texto do PRIMARY voltar a valer.
  // Confirmação via processo principal (ver 'backup-confirm'): window.confirm() tira o foco de
  // teclado do editor no Electron/Windows. Com a edição ainda liberada, o foco volta ao editor.
  async function askConfirm(message, yes) {
    let ok = false;
    try {
      ok = await ipcRenderer.invoke('backup-confirm', { message, yes });
    } catch (_) { /* sem resposta = não confirma */ }
    const bridge = getBridge();
    const activeId = bridge && bridge.getActiveId();
    const editor = activeId != null && bridge.getEditor(activeId);
    if (state.editing && editor && editor.isContentEditable) editor.focus();
    return ok;
  }

  let toggling = false;
  async function toggleEditing() {
    if (toggling) return;
    toggling = true;
    try {
      await toggleEditingInner();
    } finally {
      toggling = false;
    }
  }

  async function toggleEditingInner() {
    const bridge = getBridge();
    if (!bridge || state.role !== 'backup') return;

    if (!state.editing) {
      // Grava o espelho como está agora (coleta síncrona) e fixa a base para detectar o que for editado
      const flush = flushCopiesNow();
      collectCopyDocs(bridge).forEach((d) => { d.entry.baseHtml = d.html; d.entry.editedHtml = null; });
      copies.editSession = new Date().toISOString();
      state.editing = true;
      state.editBlocked = false;
      releaseMirroredScroll();
      mirror.forEach((entry) => {
        if (bridge.hasDocument(entry.localId)) bridge.setMirrorMode(entry.localId, false);
      });
      if (state.twoWay) {
        // A base é o texto do PRIMARY neste instante (o espelho estava em dia)
        startPrimaryWatch(false);
        rebaselineAllMirrors(bridge);
      }
      render(true);
      await flush;
      return;
    }

    const sentToPrimary = twoWayActive();
    const changed = collectCopyDocs(bridge).filter((d) => d.html !== d.entry.baseHtml);
    const where = copies.dir ? `\n\n${copies.dir}\\Edited on backup` : '';
    let question;
    if (!changed.length) {
      question = 'Resume mirroring?\n\nYou made no changes on this PC. The primary\'s text will be shown again.';
    } else if (sentToPrimary) {
      question = `Resume mirroring?\n\nYour changes (${changed.length} document${changed.length > 1 ? 's' : ''}) were sent to the primary, so they stay in its text. If any edit lost a simultaneous-edit dispute, a copy of it is already saved here:${where}\n\nThen the primary's text is shown again.`;
    } else {
      question = `Resume mirroring?\n\nYour changes on this PC (${changed.length} document${changed.length > 1 ? 's' : ''}) will be saved as a separate copy first:${where}\n\nThen the primary's text is shown again.`;
    }
    const ok = await askConfirm(question, 'Resume mirroring');
    if (!ok) return;

    // Edição ainda pendente segue para o PRIMARY antes de o espelho voltar (mesma ordem no canal)
    flushPendingEdits();

    if (changed.length && !sentToPrimary) {
      clearTimeout(copies.timer);
      copies.timer = null;
      let result = null;
      let failure = '';
      try {
        result = await saveEditedCopies();
        // null = tudo já estava salvo (ex.: gravação feita ao digitar): não é erro
        if (result && !result.ok) failure = (result.errors && result.errors[0] && result.errors[0].error) || 'unknown error';
      } catch (err) {
        failure = err.message;
      }
      if (failure && !(await askConfirm(`Could not save a copy of your changes (${failure}).\n\nResume mirroring anyway and lose them?`, 'Resume anyway'))) {
        render(true);
        return;
      }
      if (!failure) {
        copies.notice = `Your changes were saved as a copy in ${copies.dir}\\Edited on backup`;
        copies.noticeAt = Date.now();
      }
    } else if (sentToPrimary && changed.length) {
      copies.notice = 'Your changes were sent to the primary';
      copies.noticeAt = Date.now();
    }

    stopPrimaryWatch();
    editedLocalIds.clear();
    // O PRIMARY manda tudo de novo (já com as edições que ele aceitou)
    state.editing = false;
    state.editBlocked = false;
    copies.editSession = '';
    mirror.forEach((entry) => {
      entry.baseHtml = null;
      entry.editedHtml = null;
      if (bridge.hasDocument(entry.localId)) bridge.setMirrorMode(entry.localId, true);
    });
    ipcRenderer.send('backup-request-resync');
    render(true);
  }

  // O PRIMARY não aplicou uma edição enviada por este backup
  function handleEditRejected(info) {
    if (state.role !== 'backup' || !state.editing) return;
    const reason = String((info && info.reason) || 'conflict');
    const where = copies.dir ? `${copies.dir}\\Edited on backup` : 'the "Edited on backup" folder';

    if (reason === 'disabled' || reason === 'offline') {
      // Daqui em diante as edições ficam só neste PC (guardadas como cópia) até retomar o espelho
      state.editBlocked = true;
      stopPrimaryWatch();
      saveEditedCopies().catch(() => { });
      copies.notice = reason === 'disabled'
        ? `The primary is not accepting edits, so your changes stay on this PC (copy in ${where})`
        : `Not connected to the primary, so your changes stay on this PC (copy in ${where})`;
    } else {
      // Conflito: o texto do PRIMARY prevalece. A cópia do que foi digitado aqui é gravada quando
      // o texto do PRIMARY chega (saveConflictCopies), antes de ele valer.
      copies.notice = `Your last edit conflicted with a change on the primary. The primary's version is shown; yours is saved in ${where}`;
    }
    copies.noticeAt = Date.now();
    render(true);
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
    const ethernet = state.transport === 'ethernet';
    if (ethernet) beginPreparing('Checking the network cable…');
    let result;
    try {
      result = await ipcRenderer.invoke('backup-start-primary', {
        port: Number(($('backup-primary-port') || {}).value) || DEFAULT_PORT,
        transport: state.transport
      });
    } finally {
      endPreparing();
    }
    if (!result.ok) {
      if (!result.cancelled) state.error = result.error;
      render(true);
      return;
    }
    state.role = 'primary';
    state.addresses = result.addresses;
    state.port = result.port;
    state.pin = result.pin;
    state.link = 'listening';
    state.error = '';
    state.ethLink = result.link || null;
    state.ethWarning = result.warning || '';
    startPrimaryWatch();
    render(true);
    // Um backup pode ter conectado antes de este retorno chegar.
    if (state.clients > 0) pushFull();
  }

  // Cabo: o main manda o andamento (cabo, endereço, permissão, busca do primary...)
  function beginPreparing(text) {
    state.preparing = true;
    state.progress = text;
    state.step = 0;
    state.ethWarning = '';
    state.ethLink = null;
    render(true);
  }

  function endPreparing() {
    state.preparing = false;
    state.progress = '';
  }

  function cancelPreparing() {
    ipcRenderer.invoke('backup-stop').catch(() => { });
  }

  // Copia pelo clipboard do Electron (não depende de foco/permissão do navegador) e confirma no botão.
  function copyWithFeedback(button, text) {
    if (!text) return;
    require('electron').clipboard.writeText(String(text));
    const original = button.innerHTML;
    button.innerHTML = '<i class="bi bi-check2"></i>';
    button.classList.add('btn-success');
    button.classList.remove('btn-outline-secondary');
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('btn-success');
      button.classList.add('btn-outline-secondary');
    }, 1200);
  }

  // Um endereço por linha, cada um com o seu botão de copiar (só reconstrói quando muda, para o
  // aviso "copiado" não sumir a cada atualização da janela).
  let lastAddressKey = '';
  function renderAddresses() {
    const key = `${state.port}|${state.addresses.map((a) => `${a.name}=${a.ip}`).join(',')}`;
    if (key === lastAddressKey) return;
    lastAddressKey = key;

    const box = $('backup-primary-addresses');
    box.replaceChildren();
    state.addresses.forEach((a) => {
      const address = `${a.ip}:${state.port}`;

      const row = document.createElement('div');
      row.className = 'bsync-addr-row';

      const label = document.createElement('span');
      label.className = 'bsync-addr';
      const name = document.createElement('small');
      name.textContent = a.name;
      label.append(name, address);
      label.title = `${a.name}: ${address}`;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-outline-secondary';
      button.title = `Copy ${address}`;
      button.innerHTML = '<i class="bi bi-clipboard"></i>';
      button.addEventListener('click', () => copyWithFeedback(button, address));

      row.append(label, button);
      box.appendChild(row);
    });
  }

  // Passo-a-passo da preparação do cabo (só reconstrói quando muda)
  let lastStepsKey = '';
  function renderSteps(asPrimary) {
    const labels = asPrimary ? ['Cable', 'Address', 'Ready'] : ['Cable', 'Address', 'Find primary', 'Connect'];
    const key = `${labels.length}|${state.step}`;
    if (key === lastStepsKey) return;
    lastStepsKey = key;

    const list = $('backup-eth-steps');
    list.replaceChildren();
    labels.forEach((text, index) => {
      const item = document.createElement('li');
      item.className = index < state.step ? 'done' : (index === state.step ? 'active' : '');
      const dot = document.createElement('span');
      dot.className = 'bsync-dot';
      if (index < state.step) dot.innerHTML = '<i class="bi bi-check-lg"></i>';
      else dot.textContent = String(index + 1);
      item.append(dot, text);
      list.appendChild(item);
    });
  }

  async function startBackup() {
    if (state.transport === 'ethernet') {
      await startBackupByCable();
      return;
    }
    let host = ($('backup-host').value || '').trim();
    let port = Number($('backup-port').value) || DEFAULT_PORT;
    const pin = ($('backup-pin').value || '').trim();

    // Aceita o endereço colado como "192.168.0.10:3002" (o que o botão de copiar entrega).
    const pasted = /^(.+):(\d{1,5})$/.exec(host);
    if (pasted) {
      host = pasted[1];
      port = Number(pasted[2]);
      $('backup-host').value = host;
      $('backup-port').value = String(port);
    }

    const result = await ipcRenderer.invoke('backup-connect', { host, port, pin });
    if (!result.ok) {
      state.error = result.error;
      render(true);
      return;
    }
    localStorage.setItem(STORAGE_HOST, host);
    localStorage.setItem(STORAGE_PORT, String(port));
    state.role = 'backup';
    state.link = 'connecting';
    state.error = '';
    render(true);
  }

  // Cabo: só o PIN é digitado. O main prepara a placa, acha o primary e conecta.
  async function startBackupByCable() {
    const pin = ($('backup-pin').value || '').trim();
    if (!/^\d{6}$/.test(pin)) {
      state.error = 'The PIN has 6 digits.';
      render(true);
      return;
    }
    beginPreparing('Checking the network cable…');
    let result;
    try {
      result = await ipcRenderer.invoke('backup-ethernet-connect', { pin });
    } finally {
      endPreparing();
    }
    if (!result.ok) {
      if (!result.cancelled) state.error = result.error;
      render(true);
      return;
    }
    state.role = 'backup';
    state.link = 'connecting';
    state.error = '';
    state.ethLink = result.link || null;
    state.ethWarning = result.warning || '';
    render(true);
  }

  async function stopRole() {
    stopPrimaryWatch();
    // Antes de soltar os documentos, garante a cópia em arquivo do que está na tela
    if (state.role === 'backup') await flushCopiesNow();
    await ipcRenderer.invoke('backup-stop');
    if (state.role === 'backup') unlockMirrors();
    state.role = 'off';
    state.link = 'off';
    state.clients = 0;
    state.pin = '';
    state.error = '';
    state.ethLink = null;
    state.ethWarning = '';
    render(true);
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
      if (state.editing) {
        return twoWayActive()
          ? { text: 'Editing — two-way', cls: 'primary' }
          : { text: 'Editing — mirroring paused', cls: 'warning' };
      }
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
    if (s >= 120) return `${Math.round(s / 60)} min ago`;
    return s < 2 ? 'just now' : `${s}s ago`;
  }

  // O selo da barra de título só é tocado quando muda; os detalhes da janela só são desenhados
  // enquanto ela está aberta (ou quando forçado), para o recurso não custar nada em segundo plano.
  let lastBadgeKey = '';

  function render(force = false) {
    const label = linkLabel();
    const active = state.role !== 'off';

    const badge = $('backup-sync-badge');
    const badgeText = `${state.role === 'primary' ? 'PRIMARY' : 'BACKUP'} · ${label.text}`;
    const badgeKey = `${active}|${label.cls}|${badgeText}`;
    if (badge && badgeKey !== lastBadgeKey) {
      lastBadgeKey = badgeKey;
      badge.className = `badge bg-${label.cls} app-no-drag ms-2 ${active ? '' : 'd-none'}`;
      badge.style.cursor = 'pointer';
      badge.textContent = badgeText;
    }

    const modalEl = $('backupSyncModal');
    if (!modalEl || !(force === true || modalEl.classList.contains('show'))) return;

    const statusText = $('backup-status-text');
    statusText.textContent = active ? `${state.role.toUpperCase()} — ${label.text}` : 'OFF';
    $('backup-status-dot').className = `bi bi-circle-fill text-${label.cls}`;
    $('backup-status-pill').dataset.state = label.cls;
    if (state.preparing) {
      statusText.textContent = 'Preparing cable';
      $('backup-status-dot').className = 'bi bi-circle-fill text-warning';
      $('backup-status-pill').dataset.state = 'warning';
    }

    const busy = active || state.preparing;
    $('backup-role-primary').disabled = busy;
    $('backup-role-backup').disabled = busy;
    $('backup-transport-network').disabled = busy;
    $('backup-transport-ethernet').disabled = busy;
    const cable = state.transport === 'ethernet';
    const asPrimaryNow = active ? state.role === 'primary' : $('backup-role-primary').checked;
    $('backup-transport-network').checked = !cable;
    $('backup-transport-ethernet').checked = cable;
    $('backup-eth-note').classList.toggle('d-none', !cable || state.preparing || active);
    $('backup-eth-progress').classList.toggle('d-none', !state.preparing);
    $('backup-eth-progress-text').textContent = state.progress;
    if (state.preparing) renderSteps(asPrimaryNow);
    $('backup-eth-warning').textContent = state.ethWarning;
    $('backup-eth-warning').classList.toggle('d-none', !state.ethWarning);
    document.querySelectorAll('.backup-manual-only').forEach((el) => el.classList.toggle('d-none', cable));
    $('backup-pin').placeholder = cable ? '6-digit PIN shown on the primary' : '6-digit PIN';
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
    $('backup-primary-port').disabled = primaryOn || state.preparing;
    $('backup-primary-adv').classList.toggle('d-none', primaryOn);
    $('backup-primary-toggle').innerHTML = state.preparing
      ? '<i class="bi bi-x-circle me-1"></i> Cancel'
      : (primaryOn
        ? '<i class="bi bi-stop-circle me-1"></i> Stop sharing'
        : '<i class="bi bi-broadcast me-1"></i> Start sharing');
    $('backup-primary-toggle').className = `btn btn-sm ${primaryOn ? 'btn-danger' : (state.preparing ? 'btn-outline-danger' : 'btn-primary')}`;
    if (primaryOn) {
      $('backup-primary-address-label').textContent = cable
        ? 'Address (only needed if the cable search fails)'
        : 'Address (type it on the backup PC)';
      const cableInfo = $('backup-primary-eth-link');
      cableInfo.classList.toggle('d-none', !(cable && state.ethLink));
      if (cable && state.ethLink) {
        cableInfo.textContent = `Cable: ${state.ethLink.adapter}${state.ethLink.speed ? ` · ${state.ethLink.speed}` : ''}`;
      }
      renderAddresses();
      $('backup-primary-pin').textContent = state.pin;
      $('backup-primary-clients').textContent =
        `${state.clients} connected · last update sent ${formatAge(state.lastActivityAt)}`;
      $('backup-accept-edits').checked = state.acceptEdits;
      let editLine;
      if (!state.acceptEdits) {
        editLine = 'Edits from the backup are blocked: this PC\'s text can only change here.';
      } else if (!state.editsAccepted && !state.editsRejected) {
        editLine = 'No edits received from a backup yet.';
      } else {
        editLine = `Edits from the backup: ${state.editsAccepted} applied` +
          (state.editsRejected ? `, ${state.editsRejected} refused (conflict or blocked)` : '') +
          (state.lastEditAt ? ` · last ${formatAge(state.lastEditAt)}` : '');
      }
      $('backup-primary-edit-info').textContent = editLine;
    }

    // BACKUP
    const backupOn = state.role === 'backup';
    ['backup-host', 'backup-port', 'backup-pin'].forEach((id) => { $(id).disabled = backupOn || state.preparing; });
    $('backup-connect-fields').classList.toggle('d-none', backupOn);
    $('backup-connect-toggle').innerHTML = state.preparing
      ? '<i class="bi bi-x-circle me-1"></i> Cancel'
      : (backupOn
        ? '<i class="bi bi-plug me-1"></i> Disconnect'
        : '<i class="bi bi-plug-fill me-1"></i> Connect');
    $('backup-connect-toggle').className = `btn btn-sm ${state.preparing || backupOn ? 'btn-outline-danger' : 'btn-primary'}`;
    $('backup-takeover-btn').classList.toggle('d-none', !backupOn);
    $('backup-ping-btn').classList.toggle('d-none', !backupOn);
    $('backup-edit-toggle').classList.toggle('d-none', !backupOn);
    $('backup-open-copies-btn').classList.toggle('d-none', !backupOn);
    $('backup-two-way-row').classList.toggle('d-none', !backupOn);
    $('backup-two-way').checked = state.twoWay;
    $('backup-two-way').disabled = state.editing; // vale a partir do "Unlock editing"
    $('backup-edit-toggle').innerHTML = state.editing
      ? '<i class="bi bi-lock me-1"></i> Resume mirroring'
      : '<i class="bi bi-unlock me-1"></i> Unlock editing';
    $('backup-backup-info').classList.toggle('d-none', !backupOn);
    const backupCable = $('backup-eth-link');
    backupCable.classList.toggle('d-none', !(backupOn && cable && state.ethLink));
    if (backupOn && cable && state.ethLink) {
      const peer = state.ethLink.peer;
      backupCable.textContent = `Cable: ${state.ethLink.adapter} (${state.ethLink.ip})` +
        (peer ? ` → ${peer.name} (${peer.ip})` : '');
    }
    if (backupOn) {
      let info;
      if (!state.editing) {
        info = state.twoWay
          ? `Documents are read-only while mirroring · last update ${formatAge(state.lastActivityAt)}. After "Unlock editing", your edits are also applied on the primary.`
          : `Documents are read-only while mirroring · last update ${formatAge(state.lastActivityAt)}`;
      } else if (twoWayActive()) {
        info = 'Two-way editing: your changes are applied on the primary too, and its changes keep arriving here. If both edit the same text at once, the primary\'s version wins and yours is kept as a copy.';
      } else if (state.editBlocked) {
        info = 'Your changes are staying on this PC (the primary is not accepting edits or is offline). They are saved as a copy; when you resume, the primary\'s text is shown again.';
      } else {
        info = 'Mirroring is paused. Your changes are kept as a separate copy on this PC; when you resume, the primary\'s text is shown again.';
      }
      $('backup-backup-info').textContent = info;
    }
    const copyInfo = $('backup-copy-info');
    copyInfo.classList.toggle('d-none', !backupOn);
    if (backupOn) {
      const notice = copies.notice && Date.now() - copies.noticeAt < 20000 ? `${copies.notice}. ` : '';
      let line;
      if (copies.error) line = `⚠ Local copy failed: ${copies.error}`;
      else if (copies.lastSavedAt) line = `Local copy saved on this PC ${formatAge(copies.lastSavedAt)}`;
      else line = 'Local copy: waiting for the first document';
      copyInfo.textContent = notice + line;
      copyInfo.className = `bsync-muted${copies.error ? ' is-error' : ''}`;
    }

    const error = $('backup-error');
    error.textContent = state.error;
    error.classList.toggle('d-none', !state.error);
    if (!active) $('backup-test-result').className = 'd-none';
  }

  function openModal() {
    const modalEl = $('backupSyncModal');
    if (!modalEl || !window.bootstrap) return;
    render(true);
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

    ['backup-role-primary', 'backup-role-backup'].forEach((id) => $(id).addEventListener('change', () => render(true)));
    ['backup-transport-network', 'backup-transport-ethernet'].forEach((id) => $(id).addEventListener('change', () => {
      state.transport = $('backup-transport-ethernet').checked ? 'ethernet' : 'network';
      localStorage.setItem(STORAGE_TRANSPORT, state.transport);
      state.error = '';
      render(true);
    }));
    $('backup-primary-toggle').addEventListener('click', () => {
      state.error = '';
      if (state.preparing) { cancelPreparing(); return; }
      (state.role === 'primary' ? stopRole() : startPrimary()).catch(console.error);
    });
    $('backup-connect-toggle').addEventListener('click', () => {
      state.error = '';
      if (state.preparing) { cancelPreparing(); return; }
      (state.role === 'backup' ? stopRole() : startBackup()).catch(console.error);
    });
    $('backup-takeover-btn').addEventListener('click', () => takeOver().catch(console.error));
    $('backup-edit-toggle').addEventListener('click', () => toggleEditing().catch(console.error));
    $('backup-open-copies-btn').addEventListener('click', () => {
      ipcRenderer.invoke('backup-open-copies-folder').then((r) => {
        if (r && !r.ok) { copies.error = r.error || 'Could not open the folder.'; render(true); }
      }).catch(console.error);
    });
    ipcRenderer.invoke('backup-copies-info').then((info) => { if (info && info.dir) copies.dir = info.dir; }).catch(() => { });

    // Com o espelho pausado, cada edição feita aqui vira cópia em arquivo (após uma pausa na digitação)
    document.addEventListener('input', (event) => {
      if (state.role === 'backup' && state.editing && event.target && event.target.closest &&
        event.target.closest('.text-editor-area')) {
        scheduleCopySave();
        // Duas vias: guarda em qual documento se digitou (pode não ser o da aba ativa no envio)
        const holder = event.target.closest('.editor-container');
        const localId = holder && /^doc-(\d+)$/.test(holder.id) ? Number(holder.id.slice(4)) : null;
        if (localId != null && twoWayActive()) editedLocalIds.add(localId);
      }
    }, true);
    window.addEventListener('beforeunload', flushCopiesOnClose);

    // Duas vias: opções de cada papel (valem a partir da próxima edição)
    $('backup-accept-edits').checked = state.acceptEdits;
    $('backup-accept-edits').addEventListener('change', (event) => {
      state.acceptEdits = event.target.checked;
      localStorage.setItem(STORAGE_ACCEPT_EDITS, state.acceptEdits ? '1' : '0');
      render(true);
    });
    $('backup-two-way').checked = state.twoWay;
    $('backup-two-way').addEventListener('change', (event) => {
      state.twoWay = event.target.checked;
      localStorage.setItem(STORAGE_TWO_WAY, state.twoWay ? '1' : '0');
      render(true);
    });
    $('backup-test-btn').addEventListener('click', () => runPrimaryTest().catch(console.error));
    $('backup-ping-btn').addEventListener('click', () => runBackupPing().catch(console.error));
    $('backup-copy-pin').addEventListener('click', () => copyWithFeedback($('backup-copy-pin'), state.pin));

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
        if (state.role === 'backup') {
          flushCopiesNow(); // a coleta é síncrona: roda antes de os documentos serem soltos
          unlockMirrors();
        }
        state.role = 'off';
      }
      render();
    });

    ipcRenderer.on('backup:progress', (_event, progress) => {
      if (!progress || !state.preparing) return;
      state.progress = String(progress.text || '');
      // A permissão de administrador só aparece depois de o cabo ser detectado
      const stepOf = { detect: 0, cable: 0, address: 1, admin: 1, search: 2, found: 3 }[progress.step];
      if (stepOf !== undefined) state.step = Math.max(state.step, stepOf);
      if (progress.link) state.ethLink = progress.link;
      render();
    });

    ipcRenderer.on('backup:request-full', () => {
      if (state.role === 'primary') pushFull();
    });
    ipcRenderer.on('backup:incoming', (_event, message) => handleIncoming(message));
    // Duas vias: edição de texto que um backup enviou a este PRIMARY / recusa do PRIMARY ao backup
    ipcRenderer.on('backup:incoming-edit', (_event, info) => {
      try {
        handleIncomingEdit(info);
      } catch (err) {
        console.warn('[BackupSync] Falha ao aplicar edição do backup', err);
        ipcRenderer.send('backup-reject-edit', { socketId: info && info.socketId, key: info && info.message && info.message.key, reason: 'invalid' });
        pushFull();
      }
    });
    ipcRenderer.on('backup:edit-rejected', (_event, info) => handleEditRejected(info));

    // Ao voltar para a aba/modo Operator no BACKUP, reaplica a última rolagem recebida.
    const operatorTab = $('operator-tab');
    if (operatorTab) operatorTab.addEventListener('shown.bs.tab', () => setTimeout(mirrorScroll, 120));
    window.addEventListener('operator-edit-mode-changed', () => setTimeout(mirrorScroll, 120));

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
