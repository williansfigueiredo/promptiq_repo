// ============================================================
// remote-connection.js
// ============================================================
// DESCRIÇÃO: Módulo de conexão remota (Internet/WebRTC)
// FUNÇÃO: Gerencia conexões peer-to-peer via WebRTC para
//         edição colaborativa em tempo real pela internet.
//         Usa servidor de sinalização para handshake inicial.
// ============================================================

/**
 * RemoteConnectionModule
 * -----------------------
 * Módulo que implementa conexão WebRTC para colaboração
 * em tempo real via internet. Suporta múltiplos peers.
 */
const RemoteConnectionModule = (function() {
    
    // ============================================================
    // CONSTANTES
    // ============================================================
    const SIGNALING_URL = "https://roteiro.promptiq.com.br";
    const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

    // ============================================================
    // ESTADO INTERNO
    // ============================================================
    let signalingSocket = null;   // Socket.io para sinalização
    let peers = {};               // Lista de conexões WebRTC (por userId)
    let myRoomId = null;          // ID da sala criada

    // ============================================================
    // REFERÊNCIAS DOM
    // ============================================================
    let btnOpenRemoteModal = null;
    let btnToggleServerModal = null;
    let statusIndicator = null;
    let statusAlert = null;
    let connectionPanel = null;
    let modalUrlDisplay = null;
    let btnModalCopy = null;
    let sidebarIcon = null;
    let remoteModalInstance = null;

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
    /**
     * init
     * -----
     * Inicializa o módulo de conexão remota.
     */
    function init(options) {
        // Referências DOM
        btnOpenRemoteModal = options.btnOpenRemoteModal || document.getElementById("btn-open-remote-modal");
        btnToggleServerModal = options.btnToggleServerModal || document.getElementById("btn-toggle-server-modal");
        statusIndicator = options.statusIndicator || document.getElementById("status-indicator");
        statusAlert = options.statusAlert || document.getElementById("server-status-alert");
        connectionPanel = options.connectionPanel || document.getElementById("connection-details-panel");
        modalUrlDisplay = options.modalUrlDisplay || document.getElementById("modal-url-display");
        btnModalCopy = options.btnModalCopy || document.getElementById("btn-modal-copy");
        sidebarIcon = document.querySelector("#btn-open-remote-modal i");
        
        const remoteModalElement = document.getElementById("remoteConnectionModal");
        if (remoteModalElement && typeof bootstrap !== 'undefined') {
            remoteModalInstance = new bootstrap.Modal(remoteModalElement);
        }
        
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
        
        // Configura listeners
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
    // FUNÇÃO: Iniciar Conexão WebRTC
    // ============================================================
    /**
     * startWebRTCConnection
     * ----------------------
     * Inicia a conexão WebRTC com o servidor de sinalização.
     * Cria uma sala e aguarda conexões de peers.
     */
    async function startWebRTCConnection() {
        // Verifica internet antes de tentar conectar
        const hasInternet = await checkInternetConnection();
        
        if (!hasInternet) {
            showConnectionError("No Connection! Connect to the internet to use this mode.");
            
            if (sidebarIcon) {
                sidebarIcon.classList.remove('broadcast-live');
                sidebarIcon.classList.add('broadcast-offline');
            }
            
            if (btnToggleServerModal) {
                btnToggleServerModal.disabled = false;
            }
            
            return;
        }

        console.log("✅ Internet OK - Connecting...");
        
        // ========================================
        // 1. CONECTA AO SERVIDOR DE SINALIZAÇÃO
        // ========================================
        if (!ioClient) {
            console.error("Socket.io client não disponível!");
            return;
        }
        
        signalingSocket = ioClient(SIGNALING_URL, {
            timeout: 10000,
            reconnection: false
        });

        // Handler de erro de conexão
        signalingSocket.on('connect_error', (error) => {
            console.error("❌ Erro ao conectar:", error);
            showConnectionError("Connection Failed! We were unable to connect to the server.");
            
            stopWebRTCConnection();
            updateServerUI(false);
            
            if (btnToggleServerModal) {
                btnToggleServerModal.disabled = false;
            }
        });

        // ========================================
        // 2. GERA ID DA SALA (6 DÍGITOS)
        // ========================================
        myRoomId = Math.floor(100000 + Math.random() * 900000).toString();

        // ========================================
        // 3. CRIA A SALA NO SERVIDOR
        // ========================================
        signalingSocket.emit('create-room', myRoomId);

        // ========================================
        // 4. ATUALIZA A UI
        // ========================================
        updateServerUI(true, `roteiro.promptiq.com.br | ID: ${myRoomId}`);

        // Ícone fica verde
        if (sidebarIcon) {
            sidebarIcon.classList.remove('broadcast-offline');
            sidebarIcon.classList.add('broadcast-live');
            console.log("🟢 Ícone Internet agora está VERDE");
        }

        // ========================================
        // 5. OUVE NOVOS USUÁRIOS ENTRANDO
        // ========================================
        signalingSocket.on('user-connected', (userData) => {
            const targetId = userData.id || userData;
            const userName = userData.name || "Usuário Internet";
            
            console.log("New user connected:", userData);

            if (!peers[targetId]) createPeerConnection(targetId, true);
            peers[targetId].userName = userName;
        });

        // ========================================
        // 6. OUVE SINAIS TÉCNICOS (ICE/SDP)
        // ========================================
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

        // ========================================
        // 7. OUVE DESCONEXÕES
        // ========================================
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
                
                console.log("Usuário desconectado:", userId);
            }
        });
    }

    // ============================================================
    // FUNÇÃO: Parar Conexão WebRTC
    // ============================================================
    /**
     * stopWebRTCConnection
     * ---------------------
     * Para a conexão WebRTC e limpa todos os recursos.
     */
    function stopWebRTCConnection() {
        if (signalingSocket) {
            signalingSocket.emit('user-leaving', myRoomId);
            signalingSocket.disconnect();
            signalingSocket = null;
        }

        // Volta ícone para vermelho
        if (sidebarIcon) {
            sidebarIcon.classList.remove('broadcast-live');
            sidebarIcon.classList.add('broadcast-offline');
        }
        
        console.log("🔴 Servidor de Internet Parado e Ícone resetado.");
        
        // Fecha todas as conexões
        Object.keys(peers).forEach(id => {
            if (peers[id]) peers[id].close();
        });
        
        peers = {};
        myRoomId = null;
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
    // FUNÇÃO: Broadcast de Texto para Todos os Peers
    // ============================================================
    /**
     * broadcastTextUpdate
     * --------------------
     * Envia atualização de texto para todos os peers conectados.
     * 
     * @param {string} content - Conteúdo HTML a enviar
     * @param {string|null} ignoreId - ID do peer a ignorar (quem enviou)
     */
    function broadcastTextUpdate(content, ignoreId = null) {
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

    // ============================================================
    // FUNÇÃO: Atualizar UI do Modal
    // ============================================================
    /**
     * updateServerUI
     * ---------------
     * Atualiza todos os elementos visuais do modal de conexão.
     * 
     * @param {boolean} isActive - Se o servidor está ativo
     * @param {string} url - URL/ID para exibir
     */
    function updateServerUI(isActive, url = "") {
        if (isActive) {
            // Status: ONLINE
            if (statusAlert) {
                statusAlert.classList.remove("alert-secondary");
                statusAlert.classList.add("alert-success", "text-success");
                statusAlert.querySelector("span").innerHTML = "Status: <strong>CONNECTED</strong>";
            }

            // Indicador visual
            if (statusIndicator) {
                statusIndicator.classList.replace("text-danger", "text-success");
                statusIndicator.classList.add("blink-animation");
            }

            // Botão vira "Parar"
            if (btnToggleServerModal) {
                btnToggleServerModal.classList.replace("btn-primary", "btn-danger");
                btnToggleServerModal.innerHTML = '<i class="bi bi-stop-circle"></i> STOP SERVER';
            }

            // Mostra link de conexão
            if (connectionPanel) connectionPanel.classList.remove("d-none");
            if (modalUrlDisplay) modalUrlDisplay.value = url;

            // Desabilita seleção de modo
            document.querySelectorAll('input[name="connection-mode"]')
                .forEach(el => el.disabled = true);
        } else {
            // Status: OFF
            if (statusAlert) {
                statusAlert.classList.remove("alert-success", "text-success");
                statusAlert.classList.add("alert-secondary");
                statusAlert.querySelector("span").innerHTML = "Status: <strong>OFF</strong>";
            }

            if (statusIndicator) {
                statusIndicator.classList.replace("text-success", "text-danger");
                statusIndicator.classList.remove("blink-animation");
            }

            if (btnToggleServerModal) {
                btnToggleServerModal.classList.replace("btn-danger", "btn-primary");
                btnToggleServerModal.innerHTML = '<i class="bi bi-power"></i> START SERVER';
            }

            if (connectionPanel) connectionPanel.classList.add("d-none");
            if (modalUrlDisplay) modalUrlDisplay.value = "";

            document.querySelectorAll('input[name="connection-mode"]')
                .forEach(el => el.disabled = false);
        }
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

        // Botão Iniciar/Parar
        if (btnToggleServerModal) {
            btnToggleServerModal.addEventListener('click', async () => {
                const selectedMode = document.querySelector('input[name="connection-mode"]:checked')?.value;
                btnToggleServerModal.disabled = true;

                if (selectedMode === 'ngrok') {
                    // Modo Internet (WebRTC)
                    if (signalingSocket && signalingSocket.connected) {
                        // Desliga
                        if (addLogEntry) {
                            addLogEntry({
                                msg: `Você saiu da sala.`,
                                type: 'logout',
                                source: 'Internet',
                                user: 'Você'
                            });
                        }

                        if (ipcRenderer) {
                            ipcRenderer.send('user-disconnected-remote', {
                                name: 'Você',
                                source: 'Internet'
                            });
                        }

                        stopWebRTCConnection();
                        updateServerUI(false);
                        
                        if (sidebarIcon) {
                            sidebarIcon.classList.remove('broadcast-live');
                            sidebarIcon.classList.add('broadcast-offline');
                        }
                    } else {
                        // Liga
                        try {
                            await startWebRTCConnection();
                        } catch (err) {
                            if (sidebarIcon) {
                                sidebarIcon.classList.remove('broadcast-live');
                                sidebarIcon.classList.add('broadcast-offline');
                            }
                        }
                    }
                    btnToggleServerModal.disabled = false;
                } else {
                    // Modo Local (Wi-Fi) - delega para main process
                    handleLocalMode();
                }
            });
        }

        // Botão Copiar Link
        if (btnModalCopy) {
            btnModalCopy.addEventListener("click", () => {
                if (modalUrlDisplay) {
                    modalUrlDisplay.select();
                    document.execCommand("copy");

                    const icon = btnModalCopy.querySelector("i");
                    if (icon) {
                        const oldClass = icon.className;
                        icon.className = "bi bi-check-lg";
                        setTimeout(() => icon.className = oldClass, 2000);
                    }
                }
            });
        }
    }

    // ============================================================
    // HANDLER PARA MODO LOCAL (WI-FI)
    // ============================================================
    async function handleLocalMode() {
        if (!ipcRenderer) {
            console.error("ipcRenderer não disponível");
            btnToggleServerModal.disabled = false;
            return;
        }

        try {
            const result = await ipcRenderer.invoke('toggle-server', 'local');
            
            if (result && result.active) {
                const textoParaMostrar = `${result.url} | ID: ${result.pin}`;
                updateServerUI(true, textoParaMostrar);
                
                if (sidebarIcon) {
                    sidebarIcon.classList.remove('broadcast-offline');
                    sidebarIcon.classList.add('broadcast-live');
                }
            } else {
                updateServerUI(false);
                if (sidebarIcon) {
                    sidebarIcon.classList.remove('broadcast-live');
                    sidebarIcon.classList.add('broadcast-offline');
                }
            }
        } catch (err) {
            const mensagemExibicao = err.message
                .replace("Error invoking remote method 'toggle-server':", "")
                .replace("Error:", "")
                .trim();

            showConnectionError(mensagemExibicao);

            if (sidebarIcon) {
                sidebarIcon.classList.remove('broadcast-live');
                sidebarIcon.classList.add('broadcast-offline');
            }
            updateServerUI(false);
        }
        
        btnToggleServerModal.disabled = false;
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

        // Recebe atualização do roteirista
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
        broadcastTextUpdate,
        updateServerUI,
        checkInternetConnection,
        isConnected: () => signalingSocket && signalingSocket.connected,
        getRoomId: () => myRoomId,
        getPeers: () => peers
    };
    
})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RemoteConnectionModule;
}
