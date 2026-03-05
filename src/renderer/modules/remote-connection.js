// ============================================================
// remote-connection.js
// ============================================================
// DESCRIÇÃO: Módulo de conexão remota (Local + Internet)
// FUNÇÃO: Gerencia conexões via Wi-Fi local E WebRTC para
//         edição colaborativa em tempo real. Permite que
//         ambos os modos funcionem simultaneamente.
// ============================================================

/**
 * RemoteConnectionModule
 * -----------------------
 * Módulo que implementa conexão dupla para colaboração
 * em tempo real via Local (Wi-Fi) e Internet (WebRTC).
 */
const RemoteConnectionModule = (function() {
    
    // ============================================================
    // CONSTANTES
    // ============================================================
    const SIGNALING_URL = "https://roteiro.promptiq.com.br";
    const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

    // ============================================================
    // ESTADO INTERNO - SEPARADO PARA CADA MODO
    // ============================================================
    
    // Estado Internet (WebRTC)
    let signalingSocket = null;
    let peers = {};
    let internetRoomId = null;
    let isInternetActive = false;
    
    // Estado Local (Wi-Fi)
    let isLocalActive = false;
    let localUrl = null;
    let localPin = null;

    // ============================================================
    // REFERÊNCIAS DOM
    // ============================================================
    let btnOpenRemoteModal = null;
    let sidebarIcon = null;
    let remoteModalInstance = null;
    
    // Elementos Local
    let btnToggleLocal = null;
    let localStatusBadge = null;
    let localConnectionPanel = null;
    let localUrlDisplay = null;
    let btnCopyLocal = null;
    
    // Elementos Internet
    let btnToggleInternet = null;
    let internetStatusBadge = null;
    let internetConnectionPanel = null;
    let internetUrlDisplay = null;
    let btnCopyInternet = null;

    // Status Alert (compatibilidade)
    let statusAlert = null;
    let statusIndicator = null;

    // ============================================================
    // CALLBACKS EXTERNOS
    // ============================================================
    let getActiveTextEditorArea = null;
    let syncContentToPrompter = null;
    let addLogEntry = null;
    let flashRedBorder = null;
    let flashRedBorderMultiple = null;
    let ipcRenderer = null;
    let ioClient = null;
    let activeDocumentId = null;

    // ============================================================
    // INICIALIZAÇÃO DO MÓDULO
    // ============================================================
    function init(options) {
        // Botão sidebar
        btnOpenRemoteModal = options.btnOpenRemoteModal || document.getElementById("btn-open-remote-modal");
        sidebarIcon = document.querySelector("#btn-open-remote-modal i");
        
        // Modal
        const remoteModalElement = document.getElementById("remoteConnectionModal");
        if (remoteModalElement && typeof bootstrap !== 'undefined') {
            remoteModalInstance = new bootstrap.Modal(remoteModalElement);
        }
        
        // Elementos Local
        btnToggleLocal = document.getElementById("btn-toggle-local");
        localStatusBadge = document.getElementById("local-status-badge");
        localConnectionPanel = document.getElementById("local-connection-panel");
        localUrlDisplay = document.getElementById("local-url-display");
        btnCopyLocal = document.getElementById("btn-copy-local");
        
        // Elementos Internet
        btnToggleInternet = document.getElementById("btn-toggle-internet");
        internetStatusBadge = document.getElementById("internet-status-badge");
        internetConnectionPanel = document.getElementById("internet-connection-panel");
        internetUrlDisplay = document.getElementById("internet-url-display");
        btnCopyInternet = document.getElementById("btn-copy-internet");
        
        // Status Alert (compatibilidade)
        statusAlert = document.getElementById("server-status-alert");
        statusIndicator = document.getElementById("status-indicator");
        
        // Callbacks
        getActiveTextEditorArea = options.getActiveTextEditorArea;
        syncContentToPrompter = options.syncContentToPrompter;
        addLogEntry = options.addLogEntry;
        flashRedBorder = options.flashRedBorder;
        flashRedBorderMultiple = options.flashRedBorderMultiple;
        ipcRenderer = options.ipcRenderer;
        ioClient = options.ioClient;
        
        // Estado inicial do ícone (vermelho/offline)
        if (sidebarIcon) {
            sidebarIcon.classList.add("broadcast-offline");
            sidebarIcon.classList.remove("broadcast-live");
        }
        
        setupEventListeners();
        setupIPCListeners();
    }

    /**
     * setActiveDocumentId
     * --------------------
     * Atualiza referência do documento ativo.
     */
    function setActiveDocumentId(id) {
        activeDocumentId = id;
    }

    // ============================================================
    // FUNÇÃO: Verificar Conectividade com Internet
    // ============================================================
    /**
     * checkInternetConnection
     * ------------------------
     * Verifica se há conexão com a internet fazendo
     * um HEAD request para o Google.
     * 
     * @returns {Promise<boolean>}
     */
    async function checkInternetConnection() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            
            await fetch("https://www.google.com", { 
                method: 'HEAD', 
                mode: 'no-cors',
                signal: controller.signal 
            });
            
            clearTimeout(timeoutId);
            return true;
        } catch (error) {
            console.log("ℹ️ Sistema offline detectado.");
            return false;
        }
    }

    // ============================================================
    // MODO LOCAL (WI-FI) - FUNÇÕES
    // ============================================================
    
    async function startLocalServer() {
        if (!ipcRenderer) {
            console.error("ipcRenderer não disponível");
            return false;
        }

        try {
            const result = await ipcRenderer.invoke('toggle-server', 'local');
            
            if (result && result.active) {
                isLocalActive = true;
                localUrl = result.url;
                localPin = result.pin;
                
                updateLocalUI(true, `${result.url} | ID: ${result.pin}`);
                updateSidebarIcon();
                
                if (addLogEntry) {
                    addLogEntry({
                        msg: 'Local server started',
                        type: 'login',
                        source: 'Local Network',
                        user: 'System'
                    });
                }
                
                return true;
            }
            return false;
        } catch (err) {
            const mensagemExibicao = err.message
                .replace("Error invoking remote method 'toggle-server':", "")
                .replace("Error:", "")
                .trim();

            showConnectionError(mensagemExibicao);
            isLocalActive = false;
            updateLocalUI(false);
            updateSidebarIcon();
            return false;
        }
    }
    
    async function stopLocalServer() {
        if (!ipcRenderer) return;
        
        try {
            await ipcRenderer.invoke('toggle-server', 'local');
            isLocalActive = false;
            localUrl = null;
            localPin = null;
            updateLocalUI(false);
            updateSidebarIcon();
            
            if (addLogEntry) {
                addLogEntry({
                    msg: 'Local server stopped',
                    type: 'logout',
                    source: 'Local Network',
                    user: 'System'
                });
            }
        } catch (err) {
            console.error("Erro ao parar servidor local:", err);
        }
    }
    
    function updateLocalUI(active, url = "") {
        if (active) {
            if (localStatusBadge) {
                localStatusBadge.textContent = "ONLINE";
                localStatusBadge.classList.remove("bg-secondary");
                localStatusBadge.classList.add("bg-success");
            }
            if (btnToggleLocal) {
                btnToggleLocal.classList.remove("btn-outline-primary");
                btnToggleLocal.classList.add("btn-danger");
            }
            if (localConnectionPanel) localConnectionPanel.classList.remove("d-none");
            if (localUrlDisplay) localUrlDisplay.value = url;
        } else {
            if (localStatusBadge) {
                localStatusBadge.textContent = "OFF";
                localStatusBadge.classList.remove("bg-success");
                localStatusBadge.classList.add("bg-secondary");
            }
            if (btnToggleLocal) {
                btnToggleLocal.classList.remove("btn-danger");
                btnToggleLocal.classList.add("btn-outline-primary");
            }
            if (localConnectionPanel) localConnectionPanel.classList.add("d-none");
            if (localUrlDisplay) localUrlDisplay.value = "";
        }
    }

    // ============================================================
    // MODO INTERNET (WEBRTC) - FUNÇÕES
    // ============================================================
    
    async function startWebRTCConnection() {
        const hasInternet = await checkInternetConnection();
        
        if (!hasInternet) {
            showConnectionError("No Connection! Connect to the internet to use this mode.");
            updateInternetUI(false);
            updateSidebarIcon();
            return false;
        }

        console.log("✅ Internet OK - Connecting...");
        
        if (!ioClient) {
            console.error("Socket.io client não disponível!");
            return false;
        }
        
        signalingSocket = ioClient(SIGNALING_URL, {
            timeout: 10000,
            reconnection: false
        });

        signalingSocket.on('connect_error', (error) => {
            console.error("❌ Erro ao conectar:", error);
            showConnectionError("Connection Failed! We were unable to connect to the server.");
            stopWebRTCConnection();
            return false;
        });

        internetRoomId = Math.floor(100000 + Math.random() * 900000).toString();
        signalingSocket.emit('create-room', internetRoomId);

        isInternetActive = true;
        updateInternetUI(true, `roteiro.promptiq.com.br | ID: ${internetRoomId}`);
        updateSidebarIcon();

        if (addLogEntry) {
            addLogEntry({
                msg: 'Internet server started',
                type: 'login',
                source: 'Internet',
                user: 'System'
            });
        }

        signalingSocket.on('user-connected', (userData) => {
            const targetId = userData.id || userData;
            const userName = userData.name || "Usuário Internet";
            
            console.log("New user connected:", userData);

            if (!peers[targetId]) createPeerConnection(targetId, true);
            peers[targetId].userName = userName;
        });

        signalingSocket.on('signal', async (data) => {
            const senderId = data.sender;
            
            if (!peers[senderId]) {
                createPeerConnection(senderId, false);
            }
            
            const peer = peers[senderId];
            const signal = data.signal;

            try {
                if (signal.type === 'offer') {
                    await peer.setRemoteDescription(new RTCSessionDescription(signal));
                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);
                    signalingSocket.emit('signal', { target: senderId, signal: peer.localDescription });
                } else if (signal.type === 'answer') {
                    await peer.setRemoteDescription(new RTCSessionDescription(signal));
                } else if (signal.candidate) {
                    await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
                }
            } catch (e) {
                console.error("Erro no sinal WebRTC:", e);
            }
        });

        signalingSocket.on('user-disconnected', (userId) => {
            if (peers[userId]) {
                const remoteName = peers[userId].userName || "Visitante (Web)";

                if (addLogEntry) {
                    addLogEntry({
                        msg: `${remoteName} saiu da sala.`,
                        type: 'logout',
                        source: 'Internet',
                        user: remoteName
                    });
                }

                if (ipcRenderer) {
                    ipcRenderer.send('user-disconnected-remote', {
                        name: remoteName,
                        source: 'Internet'
                    });
                }

                peers[userId].close();
                delete peers[userId];
            }
        });
        
        return true;
    }

    // ============================================================
    // FUNÇÃO: Parar Conexão WebRTC
    // ============================================================
    function stopWebRTCConnection() {
        if (signalingSocket) {
            signalingSocket.emit('user-leaving', internetRoomId);
            signalingSocket.disconnect();
            signalingSocket = null;
        }

        Object.keys(peers).forEach(id => {
            if (peers[id]) peers[id].close();
        });
        
        peers = {};
        internetRoomId = null;
        isInternetActive = false;
        
        updateInternetUI(false);
        updateSidebarIcon();
        
        if (addLogEntry) {
            addLogEntry({
                msg: 'Internet server stopped',
                type: 'logout',
                source: 'Internet',
                user: 'System'
            });
        }
        
        console.log("🔴 Servidor de Internet Parado");
    }
    
    function updateInternetUI(active, url = "") {
        if (active) {
            if (internetStatusBadge) {
                internetStatusBadge.textContent = "ONLINE";
                internetStatusBadge.classList.remove("bg-secondary");
                internetStatusBadge.classList.add("bg-success");
            }
            if (btnToggleInternet) {
                btnToggleInternet.classList.remove("btn-outline-primary");
                btnToggleInternet.classList.add("btn-danger");
            }
            if (internetConnectionPanel) internetConnectionPanel.classList.remove("d-none");
            if (internetUrlDisplay) internetUrlDisplay.value = url;
        } else {
            if (internetStatusBadge) {
                internetStatusBadge.textContent = "OFF";
                internetStatusBadge.classList.remove("bg-success");
                internetStatusBadge.classList.add("bg-secondary");
            }
            if (btnToggleInternet) {
                btnToggleInternet.classList.remove("btn-danger");
                btnToggleInternet.classList.add("btn-outline-primary");
            }
            if (internetConnectionPanel) internetConnectionPanel.classList.add("d-none");
            if (internetUrlDisplay) internetUrlDisplay.value = "";
        }
    }

    // ============================================================
    // ÍCONE DA SIDEBAR (VERDE SE QUALQUER UM ATIVO)
    // ============================================================
    function updateSidebarIcon() {
        if (sidebarIcon) {
            if (isLocalActive || isInternetActive) {
                sidebarIcon.classList.remove('broadcast-offline');
                sidebarIcon.classList.add('broadcast-live');
            } else {
                sidebarIcon.classList.remove('broadcast-live');
                sidebarIcon.classList.add('broadcast-offline');
            }
        }
        
        // Atualiza status alert (compatibilidade)
        if (statusAlert && statusIndicator) {
            if (isLocalActive || isInternetActive) {
                statusAlert.classList.remove("alert-secondary");
                statusAlert.classList.add("alert-success", "text-success");
                statusAlert.querySelector("span").innerHTML = "Status: <strong>CONNECTED</strong>";
                statusIndicator.classList.replace("text-danger", "text-success");
                statusIndicator.classList.add("blink-animation");
            } else {
                statusAlert.classList.remove("alert-success", "text-success");
                statusAlert.classList.add("alert-secondary");
                statusAlert.querySelector("span").innerHTML = "Status: <strong>OFF</strong>";
                statusIndicator.classList.replace("text-success", "text-danger");
                statusIndicator.classList.remove("blink-animation");
            }
        }
    }

    // ============================================================
    // FUNÇÃO: Criar Conexão Peer
    // ============================================================
    /**
     * createPeerConnection
     * ---------------------
     * Cria uma nova conexão WebRTC com um peer.
     * 
     * @param {string} targetId - ID do peer remoto
     * @param {boolean} isInitiator - Se somos o iniciador da conexão
     */
    function createPeerConnection(targetId, isInitiator) {
        const config = { iceServers: ICE_SERVERS };
        const peer = new RTCPeerConnection(config);
        
        peers[targetId] = peer;

        // ========================================
        // ICE CANDIDATE HANDLER
        // ========================================
        peer.onicecandidate = (event) => {
            if (event.candidate && signalingSocket) {
                signalingSocket.emit('signal', { 
                    target: targetId, 
                    signal: { candidate: event.candidate } 
                });
            }
        };

        if (isInitiator) {
            // Host cria o canal de dados
            const channel = peer.createDataChannel("teleprompter");
            setupDataChannelHooks(channel, targetId);
            
            peer.createOffer().then(offer => {
                peer.setLocalDescription(offer);
                signalingSocket.emit('signal', { target: targetId, signal: offer });
            });
        } else {
            // Cliente recebe o canal
            peer.ondatachannel = (event) => {
                setupDataChannelHooks(event.channel, targetId);
            };
        }
        
        return peer;
    }

    // ============================================================
    // FUNÇÃO: Configurar Hooks do Data Channel
    // ============================================================
    /**
     * setupDataChannelHooks
     * ----------------------
     * Configura os event handlers do canal de dados WebRTC.
     */
    function setupDataChannelHooks(channel, userId) {
        if (peers[userId]) {
            peers[userId].dataChannel = channel;
        }

        // ========================================
        // CANAL ABRIU: Envia conteúdo inicial
        // ========================================
        channel.onopen = () => {
            console.log(`Canal aberto com ${userId}`);
            
            const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
            if (editor) {
                channel.send(JSON.stringify({ 
                    type: 'update', 
                    content: editor.innerHTML 
                }));
            }
            
            const savedName = peers[userId]?.userName || "Visitante (Internet)";
            
            if (addLogEntry) {
                addLogEntry({
                    msg: `${savedName} entrou na sala.`,
                    type: 'login',
                    source: 'Internet',
                    user: savedName
                });
            }
        };

        // ========================================
        // CANAL FECHOU: Usuário saiu
        // ========================================
        channel.onclose = () => {
            console.log(`Canal fechado com ${userId}`);
            
            const savedName = peers[userId]?.userName || "Visitante (Internet)";
            
            if (addLogEntry) {
                addLogEntry({
                    msg: `${savedName} saiu da sala.`,
                    type: 'logout',
                    source: 'Internet',
                    user: savedName
                });
            }

            if (ipcRenderer) {
                ipcRenderer.send('user-disconnected-remote', {
                    name: savedName,
                    source: 'Internet'
                });
            }

            if (peers[userId]) {
                peers[userId].close();
                delete peers[userId];
            }
        };

        // ========================================
        // MENSAGEM RECEBIDA: Atualiza editor
        // ========================================
        channel.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === 'update') {
                const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
                
                if (editor && editor.innerHTML !== data.content) {
                    editor.innerHTML = data.content;
                    
                    if (flashRedBorder) flashRedBorder(editor);
                    
                    const container = document.getElementById(`doc-${activeDocumentId}`);
                    if (container && flashRedBorder) {
                        flashRedBorder(container);
                    }

                    if (syncContentToPrompter) syncContentToPrompter();
                    
                    broadcastTextUpdate(data.content, userId);

                    const remoteName = peers[userId]?.userName || "Roteirista (Web)";

                    if (addLogEntry) {
                        addLogEntry({
                            msg: `${remoteName} digitando...`,
                            type: 'edit',
                            source: 'Internet',
                            user: remoteName
                        });
                    }
                    
                    if (flashRedBorderMultiple) flashRedBorderMultiple(editor, 2);
                }
            }
        };
    }

    // ============================================================
    // BROADCAST PARA TODOS OS MODOS ATIVOS
    // ============================================================
    
    /**
     * broadcastToAll
     * ---------------
     * Envia atualização de texto para TODOS os dispositivos conectados,
     * tanto via Local (Wi-Fi) quanto via Internet (WebRTC).
     * 
     * @param {string} content - Conteúdo HTML a enviar
     * @param {string|null} ignoreId - ID do peer WebRTC a ignorar (quem enviou)
     */
    function broadcastToAll(content, ignoreId = null) {
        // Envia para peers WebRTC (Internet)
        if (isInternetActive) {
            Object.keys(peers).forEach(id => {
                if (id !== ignoreId) {
                    const peer = peers[id];
                    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                        peer.dataChannel.send(JSON.stringify({ 
                            type: 'update', 
                            content: content 
                        }));
                    }
                }
            });
        }
        
        // Envia para servidor local (Wi-Fi)
        if (isLocalActive && ipcRenderer) {
            ipcRenderer.send('send-text-to-remote', content);
        }
    }
    
    /**
     * broadcastTextUpdate (compatibilidade)
     * Alias para broadcastToAll - envia para AMBOS os modos
     */
    function broadcastTextUpdate(content, ignoreId = null) {
        broadcastToAll(content, ignoreId);
    }

    // ============================================================
    // FUNÇÃO: Atualizar UI do Modal (COMPATIBILIDADE)
    // ============================================================
    function updateServerUI(isActive, url = "") {
        // Mantido para compatibilidade - agora usa updateSidebarIcon
        updateSidebarIcon();
    }

    // ============================================================
    // FUNÇÃO: Mostrar Erro de Conexão
    // ============================================================
    function showConnectionError(message) {
        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-danger alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3';
        alertDiv.style.zIndex = '9999';
        alertDiv.innerHTML = `
            <i class="bi bi-wifi-off"></i> 
            <strong>${message}</strong>
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(alertDiv);
        setTimeout(() => alertDiv.remove(), 5000);
    }

    // ============================================================
    // CONFIGURAÇÃO DE EVENT LISTENERS
    // ============================================================
    function setupEventListeners() {
        // Abrir modal
        if (btnOpenRemoteModal && remoteModalInstance) {
            btnOpenRemoteModal.addEventListener("click", () => {
                remoteModalInstance.show();
            });
        }

        // Botão Toggle Local
        if (btnToggleLocal) {
            btnToggleLocal.addEventListener('click', async () => {
                btnToggleLocal.disabled = true;
                
                if (isLocalActive) {
                    await stopLocalServer();
                } else {
                    await startLocalServer();
                }
                
                btnToggleLocal.disabled = false;
            });
        }
        
        // Botão Toggle Internet
        if (btnToggleInternet) {
            btnToggleInternet.addEventListener('click', async () => {
                btnToggleInternet.disabled = true;
                
                if (isInternetActive) {
                    stopWebRTCConnection();
                } else {
                    await startWebRTCConnection();
                }
                
                btnToggleInternet.disabled = false;
            });
        }

        // Botão Copiar Local
        if (btnCopyLocal) {
            btnCopyLocal.addEventListener("click", () => {
                if (localUrlDisplay) {
                    localUrlDisplay.select();
                    document.execCommand("copy");
                    showCopyFeedback(btnCopyLocal);
                }
            });
        }
        
        // Botão Copiar Internet
        if (btnCopyInternet) {
            btnCopyInternet.addEventListener("click", () => {
                if (internetUrlDisplay) {
                    internetUrlDisplay.select();
                    document.execCommand("copy");
                    showCopyFeedback(btnCopyInternet);
                }
            });
        }
    }
    
    function showCopyFeedback(btn) {
        const icon = btn.querySelector("i");
        if (icon) {
            const oldClass = icon.className;
            icon.className = "bi bi-check-lg";
            setTimeout(() => icon.className = oldClass, 2000);
        }
    }

    // ============================================================
    // CONFIGURAÇÃO DE IPC LISTENERS
    // ============================================================
    function setupIPCListeners() {
        if (!ipcRenderer) return;

        // Recebe texto do servidor local
        ipcRenderer.on("update-text-from-remote", (event, newText) => {
            const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
            if (editor) {
                editor.innerText = newText;
                if (flashRedBorder) flashRedBorder(editor);
                if (syncContentToPrompter) syncContentToPrompter();
            }
        });

        // Servidor pede texto atual
        ipcRenderer.on("request-text-for-remote", () => {
            const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
            if (editor) {
                ipcRenderer.send("send-text-to-remote", editor.innerHTML);
            }
        });

        // Recebe atualização do roteirista (local)
        ipcRenderer.on("update-from-remote", (event, newText) => {
            const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;

            if (editor && editor.innerText !== newText) {
                editor.innerHTML = newText;

                if (flashRedBorder) flashRedBorder(editor);

                const container = document.getElementById("document-content-container");
                if (container) {
                    container.style.transition = "box-shadow 0.2s";
                    container.style.boxShadow = "inset 0 0 0 4px #ff0000";
                    setTimeout(() => container.style.boxShadow = "none", 400);
                }
                
                if (flashRedBorderMultiple) flashRedBorderMultiple(editor, 2);

                if (syncContentToPrompter) syncContentToPrompter();
                
                // Propaga para Internet se estiver ativo
                if (isInternetActive) {
                    Object.keys(peers).forEach(id => {
                        const peer = peers[id];
                        if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                            peer.dataChannel.send(JSON.stringify({ 
                                type: 'update', 
                                content: newText 
                            }));
                        }
                    });
                }
            }
        });
    }

    // ============================================================
    // API PÚBLICA DO MÓDULO
    // ============================================================
    return {
        init,
        setActiveDocumentId,
        startWebRTCConnection,
        stopWebRTCConnection,
        startLocalServer,
        stopLocalServer,
        broadcastTextUpdate,
        broadcastToAll,
        updateServerUI,
        checkInternetConnection,
        isConnected: () => isLocalActive || isInternetActive,
        isLocalConnected: () => isLocalActive,
        isInternetConnected: () => isInternetActive,
        getRoomId: () => internetRoomId,
        getLocalPin: () => localPin,
        getPeers: () => peers
    };
    
})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RemoteConnectionModule;
}
