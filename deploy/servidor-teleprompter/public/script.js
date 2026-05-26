const socket = io();
let peerConnection;
let dataChannel;
let hostId;

// === ELEMENTOS DA TELA ===
const loadingScreen = document.getElementById('loading-screen');
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const editor = document.getElementById('remote-editor');
const loadingText = document.querySelector('.loading-text');
const errorMsg = document.getElementById('error-msg');

// Status
const statusDiv = document.getElementById('status');
const statusText = document.getElementById('status-text');
const syncDot = document.getElementById('sync-dot');
const syncStatus = document.getElementById('sync-status');
const lastSyncEl = document.getElementById('last-sync');

// Elementos do Login e Header
const nameInput = document.getElementById('inp-name');
const roomInput = document.getElementById('inp-pin');
const btnConnect = document.getElementById('btn-connect');
const btnLogout = document.getElementById('btn-logout');
const userName = document.getElementById('u-name');
const userIcon = document.getElementById('u-icon');

// Estado
let currentUser = "";
let paintingMode = "foreground";
let rightClickedColorBtn = null;
let _textEmitTimer = null;

// ============================================================
// INICIALIZAÇÃO (AUTO LOGIN)
// ============================================================
window.onload = () => {
    const savedName = localStorage.getItem('prompt_user');
    const savedRoom = localStorage.getItem('prompt_room');

    if (savedName && savedRoom) {
        if (loadingText) loadingText.innerText = "Connecting to the room...";
        loadingScreen.style.display = 'flex';
        loginScreen.style.display = 'none';
        appScreen.style.display = 'none';

        if(nameInput) nameInput.value = savedName;
        if(roomInput) roomInput.value = savedRoom;
        
        attemptConnection(savedName, savedRoom);
    } else {
        showLoginScreen();
    }
    
    // Inicializar paleta de cores
    initColorPalette();
    
    // Inicializar editor
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('defaultParagraphSeparator', false, 'p');
};

// ============================================================
// FUNÇÕES DE TROCA DE TELA
// ============================================================
function showLoginScreen() {
    loadingScreen.style.display = 'none';
    loginScreen.style.display = 'flex';
    appScreen.style.display = 'none';
}

function showAppScreen() {
    loadingScreen.style.display = 'none';
    loginScreen.style.display = 'none';
    appScreen.style.display = 'flex';
    setTimeout(() => appScreen.classList.add('visible'), 50);
}

function showError(msg) {
    if(errorMsg) {
        errorMsg.style.display = 'block';
        errorMsg.innerText = msg;
    }
    showLoginScreen();
}

// ============================================================
// BOTÃO CONECTAR
// ============================================================
if(btnConnect){
    btnConnect.addEventListener('click', () => {
        const name = nameInput.value.trim();
        const roomId = roomInput.value.trim();

        if (!name) { showError("Please enter your name."); return; }
        if (roomId.length < 3) { showError("Please enter a valid Room ID."); return; }

        attemptConnection(name, roomId);
    });
}

// ============================================================
// FUNÇÃO DE CONEXÃO CENTRAL
// ============================================================
function attemptConnection(name, roomId) {
    if (loadingText) loadingText.innerText = "Connecting to the room...";
    loadingScreen.style.display = 'flex';
    loginScreen.style.display = 'none';
    if(errorMsg) errorMsg.style.display = 'none';

    localStorage.setItem('prompt_user', name);
    localStorage.setItem('prompt_room', roomId);
    currentUser = name;

    if (userName) userName.innerText = name;
    if (userIcon) userIcon.innerText = name.charAt(0).toUpperCase();

    socket.emit('join-room', { roomId: roomId, name: name });

    // Timeout de segurança (10s)
    setTimeout(() => {
        if(appScreen.style.display === 'none' && loadingScreen.style.display === 'flex') {
            if (loadingText && loadingText.innerText.includes("Connecting")) {
                showError("Connection timeout. Please try again.");
            }
        }
    }, 10000);
}

// ============================================================
// BOTÃO LOGOUT
// ============================================================
if(btnLogout) {
    btnLogout.addEventListener('click', () => {
        localStorage.removeItem('prompt_user');
        localStorage.removeItem('prompt_room');

        appScreen.style.display = 'none';
        appScreen.classList.remove('visible');
        loginScreen.style.display = 'none';
        loadingScreen.style.display = 'flex';

        if (loadingText) loadingText.innerText = "Leaving the room...";

        setTimeout(() => {
            location.reload();
        }, 1500);
    });
}

// ============================================================
// EVENTOS DO SOCKET
// ============================================================
socket.on('error-msg', (msg) => {
    if (msg.toLowerCase().includes('inválido') || msg.toLowerCase().includes('encontrada') || msg.toLowerCase().includes('not found')) {
        localStorage.removeItem('prompt_room');
    }
    showError(msg);
});

// Progresso de leitura via Socket.io (modo Internet)
let _currentMaxReadIdx = -1;
let _pendingReadProgress = null;
let _readProgressFlushTimer = null;
let _lastEditorInputTime = 0;
let isTyping = false;
let typeTimeout = null;
let _serverReadPayload = null;
let _realignReadTimer = null;

function hasBlockText(el) {
    if (!el || el.nodeType !== 1) return false;
    return !!(el.textContent || '').replace(/\u00a0/g, ' ').trim() || el.querySelector('br,img,hr');
}

function getBlockElementsDirect(container) {
    if (!container) return [];
    const blocks = [];
    const STRUCTURAL = /^(P|DIV|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE)$/i;

    Array.from(container.children).forEach((child) => {
        if (!child || child.nodeType !== 1) return;

        if (/^DIV$/i.test(child.tagName)) {
            const inner = Array.from(child.children).filter(
                (el) => el.nodeType === 1 && (STRUCTURAL.test(el.tagName) || hasBlockText(el))
            );
            if (inner.length > 0) {
                inner.forEach((el) => blocks.push(el));
                return;
            }
        }

        if (hasBlockText(child)) blocks.push(child);
    });

    if (blocks.length > 0) return blocks;
    if (container.children.length > 0) return Array.from(container.children);
    return [container];
}

function resolveMaxReadIdx(payload, blockCount) {
    if (blockCount <= 0) return -1;
    let maxIdx = -1;
    let readPercent = null;

    if (typeof payload === 'number') {
        maxIdx = payload;
    } else if (Array.isArray(payload)) {
        maxIdx = payload.length ? Math.max(...payload) : -1;
    } else if (payload && typeof payload === 'object') {
        if (typeof payload.maxReadIndex === 'number') maxIdx = payload.maxReadIndex;
        else if (Array.isArray(payload.readIndices) && payload.readIndices.length) {
            maxIdx = Math.max(...payload.readIndices);
        }
        if (typeof payload.readPercent === 'number') readPercent = payload.readPercent;
    }

    if (maxIdx >= 0) return Math.min(maxIdx, blockCount - 1);
    if (readPercent != null) {
        if (readPercent <= 0) return -1;
        return Math.min(blockCount - 1, Math.max(0, Math.ceil(readPercent * blockCount) - 1));
    }
    return -1;
}

function getReadBlockCount(payload, blockCount) {
    if (blockCount <= 0) return 0;
    if (payload && typeof payload === 'object' && typeof payload.readCount === 'number') {
        return Math.max(0, Math.min(payload.readCount, blockCount));
    }
    const maxIdx = resolveMaxReadIdx(payload, blockCount);
    return maxIdx < 0 ? 0 : maxIdx + 1;
}

function resolveReadLinePx(payload, blocks) {
    const totalHeight = blocks.reduce((sum, block) => sum + block.offsetHeight, 0);
    if (totalHeight <= 0) return 0;

    if (payload && typeof payload === 'object') {
        if (typeof payload.scrollRatio === 'number') {
            return Math.max(0, Math.min(totalHeight, payload.scrollRatio * totalHeight));
        }
        if (typeof payload.readPercent === 'number') {
            return Math.max(0, Math.min(totalHeight, payload.readPercent * totalHeight));
        }
        if (typeof payload.readLinePx === 'number') {
            let px = payload.readLinePx;
            if (
                typeof payload.contentHeightPx === 'number' &&
                payload.contentHeightPx > 0 &&
                payload.contentHeightPx !== totalHeight
            ) {
                px = (px / payload.contentHeightPx) * totalHeight;
            }
            return Math.max(0, Math.min(totalHeight, px));
        }
    }

    const count = getReadBlockCount(payload, blocks.length);
    let px = 0;
    for (let i = 0; i < count && i < blocks.length; i++) {
        px += blocks[i].offsetHeight;
    }
    return px;
}

socket.on('server-read-progress', (payload) => {
    applyReadProgress(payload);
    requestAnimationFrame(() => applyReadProgressNow(_serverReadPayload));
});

restoreCachedReadProgress();
if (_serverReadPayload) {
    setTimeout(() => applyReadProgressNow(_serverReadPayload), 300);
}

// ============================================================
// SINALIZAÇÃO WEBRTC
// ============================================================
socket.on('signal', async (data) => {
    if (!peerConnection) createPeer(data.sender);

    const signal = data.signal;
    if (signal.type === 'offer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', { target: data.sender, signal: peerConnection.localDescription });
        
        showAppScreen();
        updateConnectionStatus(true);

    } else if (signal.candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) { console.error(e); }
    }
});

function createPeer(senderId) {
    hostId = senderId;
    const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    peerConnection = new RTCPeerConnection(config);

    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupChannel();
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { target: hostId, signal: { candidate: event.candidate } });
        }
    };
    
    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'disconnected') {
            updateConnectionStatus(false);
            alert("Connection lost with the studio.");
        }
    };
}

// === PROGRESSO DE LEITURA (cor mais clara) ===

function indexEditorBlocks() {
    if (!editor) return;
    editor.querySelectorAll('.script-read').forEach((el) => el.classList.remove('script-read'));
    editor.querySelectorAll('[data-read]').forEach((el) => el.removeAttribute('data-read'));
    editor.querySelectorAll('[data-para-idx]').forEach((el) => el.removeAttribute('data-para-idx'));
    ensureBlockIndexing();
}

function ensureBlockIndexing() {
    if (!editor) return [];
    const blocks = getBlockElementsDirect(editor);
    blocks.forEach((block, i) => {
        block.setAttribute('data-para-idx', String(i));
    });
    return blocks;
}

function markUserTyping() {
    _lastEditorInputTime = Date.now();
    isTyping = true;
    clearTimeout(typeTimeout);
    typeTimeout = setTimeout(() => {
        isTyping = false;
        scheduleReadProgressRealign();
    }, 1000);
}

function isUserEditing() {
    return isTyping || (Date.now() - _lastEditorInputTime < 1000);
}

function getCursorBlockIndex() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    while (node && node !== editor) {
        if (node.nodeType === 1 && node.hasAttribute('data-para-idx')) {
            return parseInt(node.getAttribute('data-para-idx'), 10);
        }
        node = node.parentElement;
    }
    return -1;
}

function saveEditorViewState() {
    if (!editor) return null;
    const sel = window.getSelection();
    let range = null;
    if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        range = sel.getRangeAt(0).cloneRange();
    } else if (window.lastEditorRange) {
        range = window.lastEditorRange.cloneRange();
    }
    return { scrollTop: editor.scrollTop, range };
}

function restoreEditorViewState(state) {
    if (!state || !editor) return;
    editor.scrollTop = state.scrollTop;
    if (state.range) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        try {
            sel.addRange(state.range);
            window.lastEditorRange = state.range.cloneRange();
        } catch (_) { /* selection may be invalid after DOM change */ }
    }
}

function flushPendingReadProgress() {
    if (_pendingReadProgress == null) return;
    const payload = _pendingReadProgress;
    _pendingReadProgress = null;
    applyReadProgressNow(payload);
}

function storeReadProgressPayload(payload) {
    _serverReadPayload = payload;
    try {
        const hasProgress =
            (payload && typeof payload.readLinePx === 'number' && payload.readLinePx > 0) ||
            (payload && typeof payload.scrollRatio === 'number' && payload.scrollRatio > 0) ||
            getReadBlockCount(payload, 9999) > 0;
        if (hasProgress) {
            sessionStorage.setItem('promptiq:readProgress', JSON.stringify(payload));
        } else {
            sessionStorage.removeItem('promptiq:readProgress');
        }
    } catch (_) {}
}

function restoreCachedReadProgress() {
    if (_serverReadPayload) return;
    try {
        const raw = sessionStorage.getItem('promptiq:readProgress');
        if (raw) _serverReadPayload = JSON.parse(raw);
    } catch (_) {}
}

function scheduleReadProgressRealign() {
    if (!_serverReadPayload) return;
    clearTimeout(_realignReadTimer);
    _realignReadTimer = setTimeout(() => applyReadProgressNow(_serverReadPayload), 120);
}

function applyReadProgress(payload) {
    storeReadProgressPayload(payload);
    applyReadProgressNow(payload);
}

function computeReadCountFromPayload(payload, blocks) {
    const blockCount = blocks.length;
    if (blockCount <= 0 || !payload || typeof payload !== 'object') return 0;

    const totalHeight = blocks.reduce((sum, block) => sum + block.offsetHeight, 0);
    if (totalHeight <= 0) return 0;

    let readLinePx = 0;
    if (typeof payload.readLinePx === 'number' && payload.readLinePx > 0) {
        const opHeight =
            typeof payload.contentHeightPx === 'number' && payload.contentHeightPx > 0
                ? payload.contentHeightPx
                : totalHeight;
        readLinePx = (payload.readLinePx / opHeight) * totalHeight;
    } else if (typeof payload.scrollRatio === 'number' && payload.scrollRatio > 0) {
        readLinePx = payload.scrollRatio * totalHeight;
    } else if (typeof payload.readCount === 'number' && payload.readCount > 0) {
        return Math.min(payload.readCount, blockCount);
    } else if (typeof payload.maxReadIndex === 'number' && payload.maxReadIndex >= 0) {
        return Math.min(payload.maxReadIndex + 1, blockCount);
    }

    if (readLinePx <= 0) return 0;

    let readCount = 0;
    let accumulated = 0;
    blocks.forEach((block, idx) => {
        accumulated += block.offsetHeight;
        if (accumulated <= readLinePx + 1) readCount = idx + 1;
    });
    return readCount;
}

function setBlockReadState(block, isRead) {
    if (!block) return;
    block.classList.toggle('script-read', isRead);
    if (isRead) block.setAttribute('data-read', '1');
    else block.removeAttribute('data-read');
}

function applyReadProgressNow(payload, retryCount) {
    if (!editor) return;

    const blocks = ensureBlockIndexing();
    if (blocks.length === 0) return;

    const totalHeight = blocks.reduce((sum, block) => sum + block.offsetHeight, 0);
    if (totalHeight <= 0 && (retryCount || 0) < 8) {
        requestAnimationFrame(() => applyReadProgressNow(payload, (retryCount || 0) + 1));
        return;
    }

    const readCount = computeReadCountFromPayload(payload, blocks);
    const viewState = saveEditorViewState();

    editor.querySelectorAll('.script-read').forEach((el) => el.classList.remove('script-read'));
    editor.querySelectorAll('[data-read]').forEach((el) => el.removeAttribute('data-read'));
    blocks.forEach((block, idx) => {
        setBlockReadState(block, idx < readCount);
    });

    _currentMaxReadIdx = readCount > 0 ? readCount - 1 : -1;
    restoreEditorViewState(viewState);
}

function reapplyReadProgress() {
    if (!editor || !_serverReadPayload) return;
    requestAnimationFrame(() => applyReadProgressNow(_serverReadPayload));
}

function flushTextUpdateToHost() {
    if (!editor) return;
    const outgoing = sanitizeOutgoingHtml(editor.innerHTML);
    const currentName = localStorage.getItem('prompt_user') || currentUser || "Anonymous";

    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({
            type: 'update',
            content: outgoing,
            name: currentName
        }));
    }

    socket.emit('text-update', {
        content: outgoing,
        name: currentName
    });
}

function scheduleTextUpdateToHost() {
    clearTimeout(_textEmitTimer);
    _textEmitTimer = setTimeout(flushTextUpdateToHost, 150);
}

function setupChannel() {
    dataChannel.onopen = () => {
        showAppScreen();
        updateConnectionStatus(true);
    };

    dataChannel.onclose = () => {
        updateConnectionStatus(false);
    };

    dataChannel.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'init' || data.type === 'update') {
            const incoming = sanitizeHtmlIfFontLocked(data.content);
            if (editor && !isUserEditing() && editor.innerHTML !== incoming) {
                const viewState = saveEditorViewState();
                editor.innerHTML = incoming;
                indexEditorBlocks();
                reapplyReadProgress();
                restoreEditorViewState(viewState);
                flashSyncIndicator();
                updateLastSync();
            }
        } else if (data.type === 'read-progress') {
            applyReadProgress(data);
            requestAnimationFrame(() => applyReadProgressNow(_serverReadPayload));
        }
    };

    if(editor) {
        editor.addEventListener('focusin', markUserTyping);
        editor.addEventListener('keydown', markUserTyping);
        editor.addEventListener('input', () => {
            markUserTyping();
            flashSyncIndicator();
            updateLastSync();
            scheduleTextUpdateToHost();
            scheduleReadProgressRealign();
        });
    }
}

// ============================================================
// TOOLBAR - ALINHAMENTO
// ============================================================
document.getElementById('remote-align-left')?.addEventListener('click', () => {
    document.execCommand('justifyLeft', false, null);
    setActiveAlignment('remote-align-left');
});

document.getElementById('remote-align-center')?.addEventListener('click', () => {
    document.execCommand('justifyCenter', false, null);
    setActiveAlignment('remote-align-center');
});

document.getElementById('remote-align-right')?.addEventListener('click', () => {
    document.execCommand('justifyRight', false, null);
    setActiveAlignment('remote-align-right');
});

function setActiveAlignment(activeId) {
    ['remote-align-left', 'remote-align-center', 'remote-align-right'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const activeEl = document.getElementById(activeId);
    if (activeEl) activeEl.classList.add('active');
}

// ============================================================
// TOOLBAR - CORES (MODO FOREGROUND/BACKGROUND)
// ============================================================
document.querySelectorAll('#remote-color-mode .toolbar-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#remote-color-mode .toolbar-btn[data-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        paintingMode = btn.dataset.mode;
    });
});

document.getElementById('remote-reset-color')?.addEventListener('click', () => {
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('hiliteColor', false, 'transparent');
    document.execCommand('foreColor', false, '#000000');
});

// Cores rápidas da paleta
document.querySelectorAll('#remote-color-palette .color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        document.execCommand('styleWithCSS', false, true);
        if (paintingMode === 'background') {
            document.execCommand('hiliteColor', false, color);
        } else {
            document.execCommand('foreColor', false, color);
        }
    });
    
    // Clique direito para trocar a cor do botão
    btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rightClickedColorBtn = btn;
        document.getElementById('color-palette-popup')?.classList.add('show');
    });
});

// ============================================================
// PALETA DE 60+ CORES
// ============================================================
const BASIC_COLORS = [
    '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
    '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'
];

const PASTEL_COLORS = [
    '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
    '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
    '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'
];

const VIBRANT_COLORS = [
    '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
    '#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47',
    '#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'
];

function initColorPalette() {
    const basicGrid = document.getElementById('basic-colors');
    const pastelGrid = document.getElementById('pastel-colors');
    const vibrantGrid = document.getElementById('vibrant-colors');
    
    if (!basicGrid) return;
    
    BASIC_COLORS.forEach(color => {
        const swatch = document.createElement('div');
        swatch.className = 'palette-swatch';
        swatch.style.backgroundColor = color;
        swatch.dataset.color = color;
        swatch.addEventListener('click', () => applyColorFromPalette(color));
        basicGrid.appendChild(swatch);
    });
    
    PASTEL_COLORS.forEach(color => {
        const swatch = document.createElement('div');
        swatch.className = 'palette-swatch';
        swatch.style.backgroundColor = color;
        swatch.dataset.color = color;
        swatch.addEventListener('click', () => applyColorFromPalette(color));
        pastelGrid.appendChild(swatch);
    });
    
    VIBRANT_COLORS.forEach(color => {
        const swatch = document.createElement('div');
        swatch.className = 'palette-swatch';
        swatch.style.backgroundColor = color;
        swatch.dataset.color = color;
        swatch.addEventListener('click', () => applyColorFromPalette(color));
        vibrantGrid.appendChild(swatch);
    });
}

function applyColorFromPalette(color) {
    // Se clicou com botão direito em uma cor, trocar a cor do botão
    if (rightClickedColorBtn) {
        rightClickedColorBtn.style.backgroundColor = color;
        rightClickedColorBtn.dataset.color = color;
        rightClickedColorBtn = null;
        document.getElementById('color-palette-popup')?.classList.remove('show');
        return;
    }
    
    // Caso contrário, aplicar a cor normalmente
    document.execCommand('styleWithCSS', false, true);
    if (paintingMode === 'background') {
        document.execCommand('hiliteColor', false, color);
    } else {
        document.execCommand('foreColor', false, color);
    }
    document.getElementById('color-palette-popup')?.classList.remove('show');
}

// Botão Mais Cores - abre popup
document.getElementById('btn-more-colors')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('color-palette-popup')?.classList.toggle('show');
});

// Clique direito na paleta também abre popup
document.getElementById('remote-color-palette')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('color-palette-popup')?.classList.toggle('show');
});

// Fechar popup ao clicar fora
document.addEventListener('click', (e) => {
    const popup = document.getElementById('color-palette-popup');
    const wrapper = document.getElementById('remote-color-palette');
    if (popup && wrapper && !wrapper.contains(e.target)) {
        popup.classList.remove('show');
        rightClickedColorBtn = null;
    }
});

// Botão cor personalizada
document.getElementById('btn-custom-color')?.addEventListener('click', () => {
    document.getElementById('custom-color-picker')?.click();
});

document.getElementById('custom-color-picker')?.addEventListener('input', (e) => {
    applyColorFromPalette(e.target.value);
});

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================
function updateConnectionStatus(connected) {
    const statusSpan = statusDiv?.querySelector('span');
    if (statusSpan) statusSpan.innerText = connected ? "ONLINE" : "OFFLINE";
    if (statusDiv) statusDiv.classList.toggle('connected', connected);
}

function flashSyncIndicator() {
    if (editor) {
        editor.classList.add('sync-flash');
        setTimeout(() => editor.classList.remove('sync-flash'), 300);
    }
    if (syncDot) {
        syncDot.classList.remove('synced');
        syncDot.classList.add('syncing');
        setTimeout(() => {
            syncDot.classList.remove('syncing');
            syncDot.classList.add('synced');
        }, 500);
    }
}

function updateLastSync() {
    if (lastSyncEl) {
        const now = new Date();
        lastSyncEl.textContent = `Last sync: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
    if (syncStatus) {
        syncStatus.textContent = 'Synced';
    }
}

// Enter para conectar
if(roomInput) roomInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') btnConnect?.click(); });
if(nameInput) nameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') roomInput?.focus(); });

// ============================================================
// CADEADO DE FONTE (FONT LOCK)
// ============================================================
window.fontSizeLocked = (function () {
    try {
        return localStorage.getItem('promptiq_font_lock') === '1';
    } catch (e) {
        return false;
    }
})();

function refreshFontLockUI() {
    const btn = document.getElementById('remote-font-lock');
    const icon = document.getElementById('remote-font-lock-icon');
    if (!btn || !icon) return;
    if (window.fontSizeLocked) {
        btn.classList.add('active');
        icon.className = 'bi bi-lock-fill';
        btn.title = 'Cadeado fechado: tamanho/fonte não sincronizam com o operador';
    } else {
        btn.classList.remove('active');
        icon.className = 'bi bi-unlock';
        btn.title = 'Cadeado aberto: tamanho/fonte sincronizam com o operador';
    }
}

document.getElementById('remote-font-lock')?.addEventListener('click', () => {
    window.fontSizeLocked = !window.fontSizeLocked;
    try {
        localStorage.setItem('promptiq_font_lock', window.fontSizeLocked ? '1' : '0');
    } catch (e) { /* ignore */ }
    refreshFontLockUI();
});

refreshFontLockUI();

// ============================================================
// SANITIZAÇÃO DE HTML (remove inline font-size / font-family)
// ============================================================
function stripFontSizeAndFamily(html) {
    if (typeof html !== 'string' || html.length === 0) return html;
    try {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;

        // Limpa style inline em qualquer elemento
        tmp.querySelectorAll('[style]').forEach(el => {
            const style = el.getAttribute('style') || '';
            const cleaned = style
                .replace(/font-size\s*:\s*[^;"]+;?/gi, '')
                .replace(/font-family\s*:\s*[^;"]+;?/gi, '')
                .replace(/\s*;\s*;/g, ';')
                .trim();
            if (cleaned.length === 0) {
                el.removeAttribute('style');
            } else {
                el.setAttribute('style', cleaned);
            }
        });

        // Remove atributos antigos size/face em <font>
        tmp.querySelectorAll('font[size], font[face]').forEach(el => {
            el.removeAttribute('size');
            el.removeAttribute('face');
        });

        return tmp.innerHTML;
    } catch (e) {
        return html;
    }
}

function stripReadProgressMarkup(html) {
    if (!html) return html;
    try {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('.script-read').forEach((el) => el.classList.remove('script-read'));
        tmp.querySelectorAll('[data-para-idx]').forEach((el) => el.removeAttribute('data-para-idx'));
        return tmp.innerHTML;
    } catch (e) {
        return html;
    }
}

function sanitizeHtmlIfFontLocked(html) {
    let out = stripReadProgressMarkup(html);
    if (window.fontSizeLocked) out = stripFontSizeAndFamily(out);
    return out;
}

function sanitizeOutgoingHtml(html) {
    let out = stripReadProgressMarkup(html);
    if (window.fontSizeLocked) out = stripFontSizeAndFamily(out);
    return out;
}

// ============================================================
// TRACKING DA SELEÇÃO NO EDITOR
// ============================================================
window.lastEditorRange = null;

document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (editor && editor.contains(range.commonAncestorContainer)) {
        window.lastEditorRange = range.cloneRange();
    }
});

function restoreEditorSelection() {
    if (!window.lastEditorRange) return null;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(window.lastEditorRange);
    return window.lastEditorRange;
}

// ============================================================
// CONTROLE DE TAMANHO DA FONTE (local + saída para operador)
// ============================================================
function getCurrentEditorFontSizePt() {
    if (!editor) return 24;
    const cs = window.getComputedStyle(editor).fontSize;
    const px = parseFloat(cs);
    if (!isNaN(px) && px > 0) {
        return Math.round((px / 96) * 72);
    }
    return 24;
}

function applyLocalFontSize(sizePt) {
    if (!editor) return;
    const clamped = Math.max(8, Math.min(200, parseInt(sizePt, 10) || 24));

    const sel = window.getSelection();
    const hasActiveSelection = sel && sel.rangeCount > 0
        && !sel.getRangeAt(0).collapsed
        && editor.contains(sel.getRangeAt(0).commonAncestorContainer);
    const hasStoredSelection = window.lastEditorRange && !window.lastEditorRange.collapsed
        && editor.contains(window.lastEditorRange.commonAncestorContainer);

    if (hasActiveSelection || hasStoredSelection) {
        editor.focus();
        if (!hasActiveSelection && hasStoredSelection) {
            restoreEditorSelection();
        }
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('fontSize', false, '7');
        const fonts = editor.querySelectorAll('font[size="7"]');
        fonts.forEach(f => {
            const span = document.createElement('span');
            span.style.fontSize = clamped + 'pt';
            while (f.firstChild) span.appendChild(f.firstChild);
            f.parentNode.replaceChild(span, f);
        });
    } else {
        editor.style.fontSize = clamped + 'pt';
    }

    const input = document.getElementById('remote-size-input');
    if (input) input.value = clamped;

    triggerEditorSync();
}

function triggerEditorSync() {
    if (!editor) return;
    const currentName = localStorage.getItem('prompt_user') || currentUser || "Anonymous";
    const outgoing = sanitizeOutgoingHtml(editor.innerHTML);

    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({
            type: 'update',
            content: outgoing,
            name: currentName
        }));
    }
    if (typeof socket !== 'undefined' && socket && socket.connected) {
        socket.emit('text-update', {
            content: outgoing,
            name: currentName
        });
    }
    flashSyncIndicator();
    updateLastSync();
}

document.getElementById('remote-size-decrease')?.addEventListener('click', () => {
    const current = parseInt(document.getElementById('remote-size-input')?.value, 10)
        || getCurrentEditorFontSizePt();
    applyLocalFontSize(current - 2);
});

document.getElementById('remote-size-increase')?.addEventListener('click', () => {
    const current = parseInt(document.getElementById('remote-size-input')?.value, 10)
        || getCurrentEditorFontSizePt();
    applyLocalFontSize(current + 2);
});

document.getElementById('remote-size-input')?.addEventListener('change', (e) => {
    applyLocalFontSize(e.target.value);
});

// Sincronizar o input com o tamanho atual quando o app abre
setTimeout(() => {
    const input = document.getElementById('remote-size-input');
    if (input) input.value = getCurrentEditorFontSizePt();
}, 200);

// ============================================================
// TRANSFORMAÇÃO DE CASE (UPPERCASE, lowercase, Title Case)
// ============================================================
function transformText(text, mode) {
    if (mode === 'upper') return text.toUpperCase();
    if (mode === 'lower') return text.toLowerCase();
    if (mode === 'title') {
        return text.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return text;
}

function transformCase(mode) {
    if (!editor) return;

    const sel = window.getSelection();
    const hasActiveSelection = sel && sel.rangeCount > 0
        && !sel.getRangeAt(0).collapsed
        && editor.contains(sel.getRangeAt(0).commonAncestorContainer);
    const hasStoredSelection = window.lastEditorRange && !window.lastEditorRange.collapsed
        && editor.contains(window.lastEditorRange.commonAncestorContainer);

    if (hasActiveSelection || hasStoredSelection) {
        editor.focus();
        if (!hasActiveSelection && hasStoredSelection) restoreEditorSelection();

        const range = window.getSelection().getRangeAt(0);
        const walker = document.createTreeWalker(
            range.commonAncestorContainer,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    const r = document.createRange();
                    r.selectNode(node);
                    if (range.compareBoundaryPoints(Range.END_TO_START, r) <= 0 &&
                        range.compareBoundaryPoints(Range.START_TO_END, r) >= 0) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_REJECT;
                }
            }
        );

        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        textNodes.forEach((tn) => {
            let start = 0;
            let end = tn.nodeValue.length;
            if (tn === range.startContainer) start = range.startOffset;
            if (tn === range.endContainer) end = range.endOffset;
            const before = tn.nodeValue.substring(0, start);
            const middle = tn.nodeValue.substring(start, end);
            const after = tn.nodeValue.substring(end);
            tn.nodeValue = before + transformText(middle, mode) + after;
        });
    } else {
        // Sem seleção: transforma o documento inteiro
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            node.nodeValue = transformText(node.nodeValue, mode);
        }
    }

    triggerEditorSync();
}

document.getElementById('remote-case-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('remote-case-menu');
    if (!menu) return;
    menu.style.display = (menu.style.display === 'block') ? 'none' : 'block';
});

document.querySelectorAll('.remote-case-option').forEach((opt) => {
    opt.addEventListener('mouseenter', () => { opt.style.background = 'var(--background-tertiary)'; });
    opt.addEventListener('mouseleave', () => { opt.style.background = 'transparent'; });
    opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = opt.dataset.case;
        const menu = document.getElementById('remote-case-menu');
        if (menu) menu.style.display = 'none';
        transformCase(mode);
    });
});

// Fecha o menu de case ao clicar fora
document.addEventListener('click', (e) => {
    const menu = document.getElementById('remote-case-menu');
    const btn = document.getElementById('remote-case-btn');
    if (!menu) return;
    if (btn && (btn.contains(e.target) || menu.contains(e.target))) return;
    menu.style.display = 'none';
});