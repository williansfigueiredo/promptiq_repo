// ============================================================
// settings-handlers.js
// ============================================================
// DESCRIÇÃO: Handlers IPC para gerenciamento de configurações
// FUNÇÃO: Gerencia persistência de preferências do usuário,
//         janela de preferências, imagem de standby e
//         configurações de idioma do corretor ortográfico.
// ============================================================

const { ipcMain, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * initSettingsHandlers
 * ---------------------
 * Inicializa handlers de configurações e retorna o objeto de settings.
 * 
 * @param {string} configPath - Caminho do arquivo de configurações
 * @param {Object} defaultSettings - Configurações padrão
 * @param {BrowserWindow} controlWindow - Janela principal (referência)
 * @returns {Object} - Retorna funções e estado para serem usados no main.js
 */
function initSettingsHandlers(configPath, defaultSettings, controlWindow) {

    // ============================================================
    // CARREGAMENTO INICIAL DE CONFIGURAÇÕES DO DISCO
    // ============================================================
    /**
     * loadSettingsFromDisk
     * ---------------------
     * Lê as configurações salvas do arquivo JSON.
     * Retorna objeto vazio se arquivo não existir ou der erro.
     */
    function loadSettingsFromDisk() {
        try {
            if (fs.existsSync(configPath)) {
                const data = fs.readFileSync(configPath, 'utf-8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error("Erro ao ler configurações salvas:", error);
        }
        return {}; // Retorna vazio se der erro ou não existir
    }

    // ========================================
    // INICIALIZA ESTADO GLOBAL
    // ========================================
    // Mescla o padrão com o que foi lido do disco
    // Isso garante que novas opções não quebrem configs antigas
    let currentSettings = { ...defaultSettings, ...loadSettingsFromDisk() };

    // ============================================================
    // HANDLER: Abrir Janela de Preferências
    // ============================================================
    /**
     * Cria e exibe a janela modal de preferências.
     */
    ipcMain.on('open-preferences-window', () => {
        const win = new BrowserWindow({
            width: 830, 
            height: 800, 
            title: "Preferências", 
            parent: controlWindow,  // Janela pai (fica por trás)
            modal: true,            // Bloqueia interação com janela pai
            resizable: false,       // Tamanho fixo
            frame: false,           // Remove barra de título do Windows
            titleBarStyle: 'hidden', // Comportamento sem bordas em Mac/Linux
            webPreferences: { 
                nodeIntegration: true, 
                contextIsolation: false 
            }
        });
        
        win.setMenuBarVisibility(false); 
        win.removeMenu();
        win.loadFile(path.join(__dirname, '../../public/html/preferences.html'));
        
        // Quando a janela carregar, envia as configurações atuais
        win.webContents.on('did-finish-load', () => {
            win.webContents.send('load-settings', currentSettings);
        });
    });

    // ============================================================
    // HANDLER: Diálogo para Selecionar Imagem de Standby
    // ============================================================
    /**
     * Abre o seletor de arquivos para escolher imagem de standby.
     * Usado quando o teleprompter está parado/esperando.
     */
    ipcMain.on('open-standby-image-dialog', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            properties: ['openFile'], 
            filters: [{ 
                name: 'Imagens', 
                extensions: ['jpg', 'jpeg', 'png', 'gif'] 
            }]
        });
        
        if (!canceled && filePaths.length > 0) { 
            event.sender.send('standby-image-selected', filePaths[0]); 
        }
    });

    // ============================================================
    // HANDLER: Salvar Configurações
    // ============================================================
    /**
     * Recebe novas configurações, mescla com as atuais, salva no disco
     * e propaga para todas as janelas abertas.
     */
    ipcMain.on('save-settings', (event, settings) => {
        // Mescla com configurações existentes
        currentSettings = { ...currentSettings, ...settings };
        
        // Notifica todas as janelas abertas
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('settings-updated-globally', currentSettings);
            }
        });

        // ========================================
        // PERSISTE NO ARQUIVO FÍSICO
        // ========================================
        try {
            fs.writeFileSync(configPath, JSON.stringify(currentSettings, null, 2));
            console.log("Configurações salvas em:", configPath);
        } catch (err) {
            console.error("Erro ao salvar config:", err);
        }

        // Notifica todas as janelas (segunda vez para garantir)
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('settings-updated-globally', currentSettings);
            }
        });
    });

    // ============================================================
    // HANDLER: Solicitar Configurações Iniciais
    // ============================================================
    /**
     * Quando uma janela abre, ela pode pedir as configurações atuais.
     */
    ipcMain.on('request-initial-settings', (e) => {
        e.sender.send('settings-updated-globally', currentSettings);
    });

    // ============================================================
    // HANDLER: Definir Idioma do Corretor Ortográfico
    // ============================================================
    /**
     * Configura o idioma do spellchecker nativo do Chromium.
     * Idiomas comuns: 'pt-BR', 'en-US', 'es-ES'
     */
    ipcMain.on('set-spell-check-language', (event, langCode) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.webContents.session.setSpellCheckerLanguages([langCode]);
        }
    });

    // ============================================================
    // RETORNA REFERÊNCIAS PARA O MAIN.JS
    // ============================================================
    return {
        getCurrentSettings: () => currentSettings,
        setCurrentSettings: (newSettings) => { 
            currentSettings = newSettings; 
        }
    };
}

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
module.exports = {
    initSettingsHandlers
};
