// ============================================================
// remote-handlers.js
// ============================================================
// DESCRIÇÃO: Handlers IPC para servidor de controle remoto
// FUNÇÃO: Gerencia servidor Express/Socket.io para edição
//         colaborativa via Wi-Fi local. Permite que dispositivos
//         móveis editem o roteiro em tempo real.
// ============================================================

const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================================
// DEPENDÊNCIAS DO SERVIDOR REMOTO
// ============================================================
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

/**
 * initRemoteHandlers
 * -------------------
 * Inicializa o servidor de controle remoto para edição colaborativa.
 * 
 * Modos disponíveis:
 * - 'local': Servidor na rede Wi-Fi local (porta 3001)
 * - 'ngrok': Conexão via internet (WebRTC P2P)
 */
function initRemoteHandlers() {
    
    // ============================================================
    // VARIÁVEIS DE ESTADO DO SERVIDOR
    // ============================================================
    let currentSessionID = "";   // PIN de 6 dígitos para entrar na sala
    let remoteApp = null;        // Instância do Express
    let remoteServer = null;     // Servidor HTTP
    let remoteIo = null;         // Socket.io instance
    let isRemoteRunning = false; // Flag de status do servidor
    
    // Estado completo para sincronização inicial (Cold Start Fix)
    let currentFullState = {
        htmlContent: "",
        fontSize: 24,
        fontFamily: "Arial",
        textAlign: "left"
    };

    // ========================================
    // CARREGA HTML DA PÁGINA REMOTA
    // ========================================
    const remotePageHTML = fs.readFileSync(
        path.join(__dirname, '../../public/html/remote.html'), 
        'utf-8'
    );

    // ============================================================
    // HANDLER: Alternar Servidor Remoto (Liga/Desliga)
    // ============================================================
    /**
     * toggle-server
     * --------------
     * Liga ou desliga o servidor de controle remoto.
     * 
     * Modo 'local' (Wi-Fi):
     * - Cria servidor Express na porta 3001
     * - Detecta IP da rede local automaticamente
     * - Gera PIN de 6 dígitos para autenticação
     * 
     * Modo 'ngrok' (Internet):
     * - Retorna placeholder para conexão WebRTC (implementado no renderer)
     */
    ipcMain.handle('toggle-server', async (event, mode) => {
        
        // ========================================
        // MODO LOCAL (WI-FI)
        // ========================================
        if (mode === 'local') {
            
            // Se já estiver rodando, DESLIGA
            if (isRemoteRunning) {
                if (remoteServer) remoteServer.close();
                isRemoteRunning = false;
                return { active: false, mode: 'local' };
            } 
            
            // Se estiver desligado, LIGA
            else {
                // ========================================
                // VERIFICAÇÃO DE REDE
                // ========================================
                const { networkInterfaces } = require('os');
                const nets = networkInterfaces();
                let ip = null;

                // Busca IP válido da rede local
                for (const name of Object.keys(nets)) {
                    for (const net of nets[name]) {
                        // Busca IPv4 que não seja loopback (127.0.0.1)
                        if (net.family === 'IPv4' && !net.internal) {
                            ip = net.address;
                        }
                    }
                }

                // Se não encontrar IP, cancela e avisa
                if (!ip) {
                    throw new Error("No active Wi-Fi or Ethernet networks detected..");
                }

                // ========================================
                // INICIALIZAÇÃO DO SERVIDOR
                // ========================================
                try {
                    remoteApp = express();
                    remoteServer = http.createServer(remoteApp);
                    remoteIo = socketIo(remoteServer);

                    // Gera PIN de 6 dígitos aleatório
                    currentSessionID = Math.floor(100000 + Math.random() * 900000).toString();
                    
                    // Rota principal serve o HTML do controle remoto
                    remoteApp.get('/', (req, res) => res.send(remotePageHTML));

                    // ========================================
                    // EVENTOS DO SOCKET.IO
                    // ========================================
                    remoteIo.on('connection', (socket) => {
                        // Pega a janela principal para enviar logs
                        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
                        
                        // ----------------------------------------
                        // EVENTO: Usuário tenta entrar na sala
                        // ----------------------------------------
                        socket.on('join-session', (userData) => {
                            if (userData.pin === currentSessionID) {
                                // PIN correto - entra na sala
                                socket.join(currentSessionID);
                                socket.userName = userData.name || "Anônimo"; 
                                socket.emit('login-success', true);
                                
                                // ========================================
                                // FIX COLD START: Solicita estado completo
                                // ========================================
                                // Pede para o renderer enviar o estado completo
                                if (win) {
                                    win.webContents.send('request-full-state-for-remote');
                                }
                                
                                // Envia estado atual imediatamente (se já tiver em cache)
                                // Isso garante que o cliente receba algo mesmo antes do renderer responder
                                if (currentFullState.htmlContent) {
                                    socket.emit('server-initial-state', currentFullState);
                                } else {
                                    // Fallback: pede apenas o texto (compatibilidade)
                                    if (win) win.webContents.send('request-text-for-remote');
                                }
                                
                                // Adiciona log de entrada
                                if (win) {
                                    win.webContents.send('add-log', {
                                        msg: `${socket.userName} entrou na sala.`,
                                        type: 'login',
                                        source: 'Wi-Fi Local',
                                        user: socket.userName
                                    });
                                }
                            } else {
                                // PIN incorreto - recusa
                                socket.emit('login-error', 'ID Incorreto!');
                            }
                        });

                        // ----------------------------------------
                        // EVENTO: Texto foi alterado remotamente
                        // ----------------------------------------
                        socket.on('text-update', (data) => {
                            const textContent = (data && data.content) ? data.content : data;
                            const editorName = (data && data.name) ? data.name : (socket.userName || "Alguém");
                            
                            // Atualiza cache do HTML (Cold Start Fix)
                            currentFullState.htmlContent = textContent;
                            
                            // Envia para todas as janelas locais
                            BrowserWindow.getAllWindows().forEach(w => {
                                if (!w.isDestroyed()) {
                                    w.webContents.send('update-from-remote', textContent);
                                }
                            });
                            
                            // Retransmite para outros usuários remotos
                            socket.broadcast.to(currentSessionID).emit('server-text-update', textContent);
                            
                            // Adiciona log de edição
                            if (win) {
                                win.webContents.send('add-log', {
                                    msg: `${editorName} está digitando...`,
                                    type: 'edit',
                                    user: editorName, 
                                    source: 'Wi-Fi Local'
                                });
                            }
                        });

                        // ----------------------------------------
                        // EVENTO: Estilo foi alterado (fonte, tamanho)
                        // ----------------------------------------
                        socket.on('style-update', (data) => {
                            const editorName = (data && data.name) ? data.name : (socket.userName || "Alguém");
                            
                            // Atualiza cache de estilos (Cold Start Fix)
                            if (data) {
                                if (data.type === 'fontSize') {
                                    currentFullState.fontSize = parseInt(data.value) || currentFullState.fontSize;
                                } else if (data.type === 'fontFamily') {
                                    currentFullState.fontFamily = data.value || currentFullState.fontFamily;
                                } else if (data.type === 'alignment') {
                                    currentFullState.textAlign = data.value || currentFullState.textAlign;
                                }
                            }
                            
                            // Envia para todas as janelas locais
                            BrowserWindow.getAllWindows().forEach(w => {
                                if (!w.isDestroyed()) {
                                    w.webContents.send('style-from-remote', data);
                                }
                            });
                            
                            // Retransmite para outros usuários remotos
                            socket.broadcast.to(currentSessionID).emit('server-style-update', data);
                            
                            // Adiciona log de estilo
                            if (win) {
                                const styleType = data.type === 'fontSize' ? 'tamanho' : (data.type === 'fontFamily' ? 'fonte' : 'alinhamento');
                                win.webContents.send('add-log', {
                                    msg: `${editorName} alterou o ${styleType} para ${data.value}`,
                                    type: 'style',
                                    user: editorName, 
                                    source: 'Wi-Fi Local'
                                });
                            }
                        });

                        // ----------------------------------------
                        // EVENTO: Usuário desconectou
                        // ----------------------------------------
                        socket.on('disconnect', () => {
                            if (socket.userName && win) {
                                win.webContents.send('add-log', {
                                    msg: `${socket.userName} saiu da sala.`,
                                    type: 'logout',
                                    source: 'Wi-Fi Local',
                                    user: socket.userName
                                });
                            }
                        });
                    });

                    // Inicia servidor na porta 3001
                    remoteServer.listen(3001); 
                    isRemoteRunning = true;
                    
                    // Retorna informações de conexão
                    return { 
                        active: true, 
                        url: `http://${ip}:3001`, 
                        mode: 'local', 
                        pin: currentSessionID 
                    };

                } catch (err) {
                    console.error(err);
                    isRemoteRunning = false;
                    throw err;
                }
            }
        } 
        
        // ========================================
        // MODO INTERNET (NGROK/WEBRTC)
        // ========================================
        else if (mode === 'ngrok') {
            // Placeholder - implementação real está no renderer (WebRTC P2P)
            return { active: true, url: "Gerando ID...", mode: 'webrtc' };
        }
    });

    // ============================================================
    // HANDLER: Receber Estado Completo do Renderer (Cold Start Fix)
    // ============================================================
    /**
     * Atualiza o cache do estado e envia para todos os remotos conectados.
     * Chamado quando: 1) Usuário conecta, 2) Host altera texto/estilo
     */
    ipcMain.on('send-full-state-to-remote', (event, fullState) => {
        if (fullState) {
            // Atualiza cache local
            currentFullState = {
                htmlContent: fullState.htmlContent || currentFullState.htmlContent,
                fontSize: fullState.fontSize || currentFullState.fontSize,
                fontFamily: fullState.fontFamily || currentFullState.fontFamily,
                textAlign: fullState.textAlign || currentFullState.textAlign
            };
            
            // Envia para todos os remotos conectados
            if (remoteIo) {
                console.log('📤 Enviando estado completo para remotos:', currentFullState.fontSize + 'pt');
                remoteIo.emit('server-initial-state', currentFullState);
            }
        }
    });

    // ============================================================
    // HANDLER: Enviar Texto para Usuários Remotos
    // ============================================================
    /**
     * Quando o editor local digita, envia para todos os usuários remotos.
     */
    ipcMain.on('send-text-to-remote', (event, content) => {
        // Atualiza cache do HTML
        currentFullState.htmlContent = content;
        
        if (remoteIo) {
            remoteIo.emit('server-text-update', content);
        }
    });

    // ============================================================
    // HANDLER: Enviar Estilo para Usuários Remotos
    // ============================================================
    /**
     * Quando o editor local muda fonte/tamanho, envia para todos os remotos.
     * Também atualiza o cache para Cold Start.
     */
    ipcMain.on('send-style-to-remote', (event, styleData) => {
        // Atualiza cache de estilos
        if (styleData) {
            if (styleData.type === 'fontSize') {
                currentFullState.fontSize = parseInt(styleData.value) || currentFullState.fontSize;
            } else if (styleData.type === 'fontFamily') {
                currentFullState.fontFamily = styleData.value || currentFullState.fontFamily;
            } else if (styleData.type === 'alignment') {
                currentFullState.textAlign = styleData.value || currentFullState.textAlign;
            }
        }
        
        if (remoteIo) {
            remoteIo.emit('server-style-update', styleData);
        }
    });

    // ============================================================
    // HANDLER: Full-Sync (Sincronização Pixel-Perfect Completa)
    // ============================================================
    /**
     * Envia estado completo do editor para roteiristas remotos.
     * Inclui: HTML com estilos inline, preferências globais, estado da toolbar.
     * 
     * Payload Structure:
     * {
     *   type: 'full-sync',
     *   timestamp: number,
     *   content: { html: string, plainText: string },
     *   editorStyles: { fontFamily, fontSize, fontColor, lineHeight, textAlign, ... },
     *   globalPrefs: { defaultFont, defaultFontSize, ... },
     *   toolbarState: { selectedFont, selectedSize, isBold, isItalic, ... },
     *   sender: { name: string, role: 'host' | 'remote' }
     * }
     */
    ipcMain.on('send-full-sync-to-remote', (event, fullSyncData) => {
        if (remoteIo) {
            console.log('📤 Enviando Full-Sync para remotos:', fullSyncData.timestamp);
            remoteIo.emit('server-full-sync', fullSyncData);
        }
    });

    // ============================================================
    // HANDLER: Broadcast de Estilos Globais
    // ============================================================
    /**
     * Quando preferências visuais mudam, envia para todos os remotos.
     */
    ipcMain.on('broadcast-styles-to-remote', (event, styles) => {
        if (remoteIo) {
            console.log('🎨 Broadcasting estilos para remotos');
            remoteIo.emit('server-style-update', {
                type: 'fullStyles',
                value: styles,
                name: 'Host'
            });
        }
    });

    // ============================================================
    // RETORNA REFERÊNCIAS PARA O MAIN.JS
    // ============================================================
    return {
        getCurrentSessionID: () => currentSessionID,
        isServerRunning: () => isRemoteRunning,
        
        // Expõe método para enviar full-sync programaticamente
        sendFullSync: (data) => {
            if (remoteIo) {
                remoteIo.emit('server-full-sync', data);
            }
        }
    };
}

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
module.exports = {
    initRemoteHandlers
};
