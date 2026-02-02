// ============================================================
// window-handlers.js
// ============================================================
// DESCRIÇÃO: Handlers IPC para gerenciamento de janelas
// FUNÇÃO: Controla operações de janela (minimizar, maximizar,
//         fullscreen), gerencia janela de projeção/broadcast
//         para segundo monitor e sincroniza scroll/marcadores.
// ============================================================

const { ipcMain, BrowserWindow, screen } = require('electron');
const path = require('path');

/**
 * initWindowHandlers
 * -------------------
 * Inicializa todos os handlers IPC relacionados a janelas.
 * 
 * @param {Object} currentSettings - Objeto de configurações atual (referência)
 */
function initWindowHandlers(currentSettings) {

    // ============================================================
    // HANDLER: Controle de Janela (Minimizar/Maximizar/Fechar)
    // ============================================================
    /**
     * Recebe comandos de controle de janela do renderer process.
     * 
     * Comandos disponíveis:
     * - 'minimize': Minimiza a janela para a barra de tarefas
     * - 'maximize': Alterna entre maximizado e tamanho normal
     * - 'fullscreen': Alterna modo tela cheia nativo (F11)
     * - 'close': Fecha a janela atual
     * - 'exit': Encerra toda a aplicação
     */
    ipcMain.on('control-window', (event, command) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        
        if (command === 'minimize') {
            win.minimize();
        }
        
        if (command === 'maximize') {
            win.isMaximized() ? win.unmaximize() : win.maximize();
        }
        
        if (command === 'fullscreen') {
            // Alterna Fullscreen Real do sistema operacional
            win.setFullScreen(!win.isFullScreen());
        }
        
        if (command === 'close') {
            win.close();
        }
        
        if (command === 'exit') {
            require('electron').app.quit();
        }
    });

    // ============================================================
    // HANDLER: Ações de Menu (Propaga para o Renderer)
    // ============================================================
    /**
     * Recebe ação de menu e repassa para o webContents processar.
     */
    ipcMain.on('menu-action', (event, payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.webContents.send('menu-action', payload);
        }
    });

    // ============================================================
    // HANDLER: Definir Título da Janela
    // ============================================================
    /**
     * Atualiza o título da janela (exibido na barra de título e taskbar).
     */
    ipcMain.on('set-window-title', (e, title) => { 
        if (!e.sender.isDestroyed()) {
            BrowserWindow.fromWebContents(e.sender).setTitle(title); 
        }
    });

    // ============================================================
    // HANDLER: Diálogos de Informação e Erro
    // ============================================================
    /**
     * Mostra uma caixa de diálogo informativa.
     */
    ipcMain.on('show-info-dialog', (e, t, m) => {
        const { dialog } = require('electron');
        dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { 
            type: 'info', 
            title: t, 
            message: m, 
            buttons: ['OK'] 
        });
    });

    /**
     * Mostra uma caixa de diálogo de erro.
     */
    ipcMain.on('show-error-dialog', (e, t, m) => {
        const { dialog } = require('electron');
        dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { 
            type: 'error', 
            title: t, 
            message: m, 
            buttons: ['OK'] 
        });
    });

    // ============================================================
    // HANDLER: Abrir Janela de Projeção/Broadcast (Segundo Monitor)
    // ============================================================
    /**
     * Cria uma nova janela de teleprompter para exibição em monitor externo.
     * Detecta automaticamente o segundo monitor e posiciona a janela lá.
     */
    ipcMain.on('open-projection-window', () => {
        const displays = screen.getAllDisplays();
        
        // Tenta encontrar display externo (posição diferente de 0,0)
        const externalDisplay = displays.find((display) => {
            return display.bounds.x !== 0 || display.bounds.y !== 0;
        });

        // Define posição (segunda tela se existir, senão abre na principal)
        const displayToUse = externalDisplay || displays[0];
        
        const projectionWin = new BrowserWindow({
            width: displayToUse.bounds.width,
            height: displayToUse.bounds.height,
            x: displayToUse.bounds.x,
            y: displayToUse.bounds.y,
            title: "Saída de Teleprompter (HDMI)",
            autoHideMenuBar: true,
            backgroundColor: '#000000',
            fullscreen: false,  // Começa em janela (usuário pode maximizar)
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                backgroundThrottling: false  // Mantém performance mesmo em background
            }
        });

        projectionWin.loadFile(path.join(__dirname, '../../public/html/projection.html'));

        // ========================================
        // SINCRONIZAÇÃO INICIAL QUANDO CARREGA
        // ========================================
        projectionWin.webContents.once('did-finish-load', () => {
            console.log("✅ Janela de Broadcast carregada");
            
            // 1. Envia as configurações atuais
            projectionWin.webContents.send('settings-updated-globally', currentSettings);
            
            // 2. Pede para o App.js mandar o conteúdo atual
            BrowserWindow.getAllWindows().forEach(win => {
                if (!win.isDestroyed() && win !== projectionWin) {
                    win.webContents.send('request-resync-data');
                }
            });
        });
    });

    // ============================================================
    // HANDLER: Janela de Projeção Pronta (Handshake)
    // ============================================================
    /**
     * Quando a janela de projeção avisa que terminou de carregar,
     * avisa todas as outras janelas para re-enviar os dados.
     */
    ipcMain.on('projection-ready', (event) => {
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('request-resync-data');
        });
    });

    // ============================================================
    // HANDLER: Sincronizar Posição de Scroll (60 FPS)
    // ============================================================
    /**
     * Recebe a posição de scroll do editor e envia para todas
     * as outras janelas (para sincronia de teleprompter).
     */
    ipcMain.on('sync-scroll-position', (event, position) => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('update-scroll', position);
            }
        });
    });

    // ============================================================
    // HANDLER: Atualizar Conteúdo do Prompter
    // ============================================================
    /**
     * Quando o texto do editor muda, envia para todas as janelas
     * de projeção para manter sincronizado.
     */
    ipcMain.on('update-prompter-content', (event, content) => {
        BrowserWindow.getAllWindows().forEach(win => {
            // Envia para todas exceto quem mandou (evita loop)
            if (!win.isDestroyed() && (win.webContents.id !== event.sender.id)) {
                win.webContents.send('update-prompter-content', content);
            }
        });
    });

    // ============================================================
    // HANDLER: Comandos de Controle do Prompter (Play/Pause/Stop)
    // ============================================================
    /**
     * Propaga comandos de controle (play, pause, stop, velocidade)
     * para todas as janelas abertas.
     */
    ipcMain.on('control-prompter', (event, command) => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('control-prompter', command);
            }
        });
    });

    // ============================================================
    // HANDLER: Sincronizar Posição do Marcador (Cue Marker)
    // ============================================================
    /**
     * Envia a posição do marcador de leitura para todas as janelas.
     * positionData pode ser um número (Y) ou objeto { top, visible }.
     */
    ipcMain.on('sync-marker-position', (event, positionData) => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
                win.webContents.send('update-marker-position', positionData);
            }
        });
    });

    // ============================================================
    // HANDLER: Broadcast de Mensagem de Overlay
    // ============================================================
    /**
     * Envia mensagem rápida (Quick Message) para todas as janelas
     * exibirem como overlay sobre o teleprompter.
     */
    ipcMain.on('broadcast-overlay-message', (event, item) => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('show-overlay-message', item);
            }
        });
    });
}

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
module.exports = {
    initWindowHandlers
};
