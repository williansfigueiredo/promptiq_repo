// ============================================================
// main.js (Versão 5.12 - Suporte a Fullscreen Nativo)
// ============================================================
// DESCRIÇÃO: Processo principal do Electron (Main Process)
// FUNÇÃO: Gerencia janelas, IPC handlers, servidor remoto,
//         persistência de configurações e operações de arquivo.
// ============================================================

// ============================================================
// SEÇÃO 1: IMPORTAÇÃO DE DEPENDÊNCIAS
// ============================================================
// Módulos do Electron para criação de janelas e comunicação
const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const APP_ICON = path.join(__dirname, '../../public/assets/icon.ico');

// ============================================================
// AUTO-UPDATER: Sistema de Atualização Automática
// ============================================================
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configura electron-log para debug em produção
log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB máximo
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// ============================================================
// OTIMIZAÇÃO DE MEMÓRIA (Flags do Chromium/V8)
// ============================================================
// Limita o tamanho máximo do heap do V8 para 512MB
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
// Impede que renderers em background sejam throttled (evita reconexões)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// OPCIONAL: Descomente para desativar GPU Process (~50-100MB economia)
// app.disableHardwareAcceleration();

// Bibliotecas para leitura de diferentes formatos de arquivo
const mammoth = require('mammoth');       // Leitura de arquivos .docx
const { PDFParse } = require('pdf-parse');    // Leitura de arquivos .pdf (v2.x)
const WordExtractor = require("word-extractor"); // Leitura de arquivos .doc


// ============================================================
// SEÇÃO 2: DEPENDÊNCIAS DO SERVIDOR REMOTO (WI-FI)
// ============================================================
// Express e Socket.io para edição colaborativa via rede local
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

// ============================================================
// SEÇÃO 3: PERSISTÊNCIA DE CONFIGURAÇÕES DO USUÁRIO
// ============================================================
// Sistema que salva/carrega preferências do disco (user-settings.json)

// Caminho do arquivo de configurações (pasta AppData do usuário)
const configPath = path.join(app.getPath('userData'), 'user-settings.json');

// Valores padrão caso o usuário nunca tenha configurado
const defaultSettings = {
  defaultFont: 'Arial', defaultFontSize: 12, defaultFontColor: '#FFFFFF',
  prompterFontScale: 30, prompterMargin: 40, lineSpacing: 1.5,
  backgroundColor: '#000000', cueColor: '#00FF00', cueType: 'arrow',
  overallSpeed: 50, mirrorMode: 'none', autoCheckForUpdates: true,
  useCustomStandbyImage: false, standbyImagePath: null,
  standbyTimeout: 5,  // Minutos de inatividade antes do modo Standby
  appTheme: 'light',
  lastUpdateCheck: null  // Data da última verificação de updates
};

/**
 * loadSettingsFromDisk
 * ---------------------
 * Lê as configurações salvas do arquivo JSON no disco.
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
  return {};
}

// Estado global de configurações (mescla padrão + salvo)
let currentSettings = { ...defaultSettings, ...loadSettingsFromDisk() };

// ============================================================
// SEÇÃO 4: VARIÁVEIS GLOBAIS DE ESTADO
// ============================================================

let currentSessionID = "";   // PIN de 6 dígitos da sessão remota atual
let controlWindow = null;    // Janela principal do editor
let splashWindow = null;     // Janela de splash screen inicial
let overlayWindow = null;    // Janela de overlay (mensagens rápidas)
const windowPairs = new Map(); // Mapa de janelas pareadas (editor <-> prompter)

// Variáveis do servidor remoto Wi-Fi
let remoteApp = null;        // Instância do Express
let remoteServer = null;     // Servidor HTTP
let remoteIo = null;         // Instância do Socket.io
let isRemoteRunning = false; // Flag: servidor está ativo?

// Servidor local para servir o modelo VOSK
let modelServer = null;
const MODEL_SERVER_PORT = 8321;

/**
 * Inicia servidor HTTP local para servir o modelo VOSK
 * Necessário porque fetch() não funciona com file://
 */
function startModelServer() {
  if (modelServer) return;  // Já iniciado

  const modelApp = express();
  const modelPath = path.join(__dirname, '../../public/model');

  // Serve arquivos estáticos da pasta model com CORS habilitado
  modelApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    next();
  });

  modelApp.use('/model', express.static(modelPath));

  modelServer = modelApp.listen(MODEL_SERVER_PORT, '127.0.0.1', () => {
    console.log(`[VOSK] Servidor de modelo iniciado em http://127.0.0.1:${MODEL_SERVER_PORT}/model`);
  });

  modelServer.on('error', (err) => {
    console.error('[VOSK] Erro ao iniciar servidor de modelo:', err.message);
  });
}

// ============================================================
// SEÇÃO 5: PARSER DE RTF (Rich Text Format)
// ============================================================
/**
 * extractTextFromRtf
 * -------------------
 * Extrai texto puro de arquivos RTF, removendo formatação.
 * Suporta caracteres especiais e encoding hexadecimal.
 * 
 * @param {string} rtf - Conteúdo bruto do arquivo RTF
 * @returns {string} Texto limpo sem formatação
 */
function extractTextFromRtf(rtf) {
  rtf = rtf.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  let text = "";
  let stack = 0;
  let ignoreLevels = [];
  let i = 0;

  while (i < rtf.length) {
    let char = rtf[i];
    if (char === '\\') {
      let remaining = rtf.slice(i);
      let match = remaining.match(/^(\\[a-z]+|\\[^a-z])(-?\d*) ?/i);
      if (match) {
        let cmd = match[1];
        let len = match[0].length;
        if (['\\fonttbl', '\\colortbl', '\\stylesheet', '\\info', '\\listtable', '\\header', '\\footer', '\\*', '\\pict'].includes(cmd)) {
          ignoreLevels.push(stack);
        }
        if (ignoreLevels.length === 0) {
          if (cmd === '\\par' || cmd === '\\line') text += '\n';
          else if (cmd === '\\tab') text += '\t';
        }
        i += len;
        continue;
      } else {
        i++;
        continue;
      }
    }
    if (char === '{') { stack++; i++; continue; }
    if (char === '}') {
      if (ignoreLevels.length > 0 && stack === ignoreLevels[ignoreLevels.length - 1]) {
        ignoreLevels.pop();
      }
      stack--; i++; continue;
    }
    if (ignoreLevels.length === 0 && char !== '\r' && char !== '\n') { text += char; }
    i++;
  }
  return text.replace(/\n\s*\n/g, '\n').trim();
}

// ============================================================
// SEÇÃO 6: MENU DE CONTEXTO (CLIQUE DIREITO)
// ============================================================
/**
 * attachContextMenu
 * ------------------
 * Adiciona menu de contexto customizado a uma janela.
 * Inclui sugestões do corretor ortográfico e opções padrão.
 * 
 * @param {BrowserWindow} win - Janela do Electron
 */
function attachContextMenu(win) {
  win.webContents.on('context-menu', (event, params) => {
    const menuTemplate = [];
    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        params.dictionarySuggestions.forEach(suggestion => {
          menuTemplate.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
        });
      } else { menuTemplate.push({ label: '(Sem sugestões)', enabled: false }); }
      menuTemplate.push({ type: 'separator' });
      menuTemplate.push({ label: 'Adicionar ao dicionário', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      menuTemplate.push({ type: 'separator' });
    }
    menuTemplate.push(
      { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
      { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar Tudo' }
    );
    const menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup();
  });
}



// ============================================================
// SEÇÃO 7: INICIALIZAÇÃO DA APLICAÇÃO
// ============================================================

/**
 * ensureBackupDirectory
 * ----------------------
 * Cria a pasta de backups na inicialização do app (se não existir).
 * Isso garante que a pasta esteja pronta antes do primeiro backup.
 * 
 * NOTA: Esta função só cria a pasta SE ela não existir.
 * Após a primeira execução, a pasta já existe e nada é feito.
 */
function ensureBackupDirectory() {
  try {
    const documentsPath = app.getPath('documents');
    const backupDir = path.join(documentsPath, 'Promptiq_Backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log('[Startup] Pasta de backups criada:', backupDir);
    } else {
      console.log('[Startup] Pasta de backups já existe:', backupDir);
    }
  } catch (error) {
    console.error('[Startup] Erro ao criar pasta de backups:', error.message);
  }
}

/**
 * initializeApp
 * --------------
 * Cria a janela principal do editor após o splash screen.
 * Configura preload, spellcheck e menu de contexto.
 */
function initializeApp() {
  // Garante que a pasta de backups existe antes de tudo
  ensureBackupDirectory();

  // Inicia servidor HTTP para servir o modelo VOSK
  startModelServer();

  controlWindow = new BrowserWindow({
    width: 1200, height: 800, title: "promptiq - Editor",
    frame: false, titleBarStyle: "hidden",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true, contextIsolation: false,
      spellcheck: true,
      backgroundThrottling: true,  // Economiza CPU/memória quando em background
      v8CacheOptions: 'none'       // Reduz cache de código V8 (~10-20MB)
    },
  });
  controlWindow.setMenuBarVisibility(false);
  controlWindow.removeMenu();
  controlWindow.loadFile(path.join(__dirname, "../../public/html/index.html"));
  controlWindow.maximize(); // Maximiza a janela (ocupa a tela toda)
  controlWindow.show();     // Agora sim mostra a janela pro usuário

  // DevTools desabilitado para produção
  // controlWindow.webContents.openDevTools();

  attachContextMenu(controlWindow);
  controlWindow.on("closed", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    controlWindow = null;
  });



}

/**
 * createSplashWindow
 * -------------------
 * Cria janela de splash screen transparente.
 * Fecha automaticamente após 5 segundos e inicia o app.
 */
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 600, height: 400, transparent: true, frame: false, alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      v8CacheOptions: 'none'  // Splash é temporário, não precisa de cache
    }
  });
  splashWindow.loadFile(path.join(__dirname, '../../public/html/splash.html'));
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    initializeApp();
  }, 5000);
}

// Inicia a aplicação quando o Electron estiver pronto
app.whenReady().then(() => {
  createSplashWindow();
  initAutoUpdater();
});

// ============================================================
// AUTO-UPDATER: Inicialização e Eventos
// ============================================================
/**
 * initAutoUpdater
 * ----------------
 * Configura o sistema de atualização automática silenciosa.
 * - Checa atualizações ao iniciar
 * - Recheca a cada 1 hora
 * - Notifica o usuário apenas quando download estiver pronto
 */
function initAutoUpdater() {
  // Só executa em produção (builds empacotados)
  if (!app.isPackaged) {
    log.info('[AutoUpdater] Modo desenvolvimento - auto-update desativado');
    return;
  }

  log.info('[AutoUpdater] Iniciando verificação de atualizações...');

  // Evento: Erro durante atualização
  autoUpdater.on('error', (err) => {
    log.error('[AutoUpdater] Erro:', err.message);
  });

  // Evento: Verificando por atualizações
  autoUpdater.on('checking-for-update', () => {
    log.info('[AutoUpdater] Verificando atualizações...');
  });

  // Evento: Atualização disponível (apenas loga, não mostra nada)
  autoUpdater.on('update-available', (info) => {
    log.info('[AutoUpdater] Nova versão disponível:', info.version);
    log.info('[AutoUpdater] Download iniciando silenciosamente...');
  });

  // Evento: Nenhuma atualização disponível
  autoUpdater.on('update-not-available', (info) => {
    log.info('[AutoUpdater] App já está na versão mais recente:', info.version);
  });

  // Evento: Progresso do download (apenas log)
  autoUpdater.on('download-progress', (progress) => {
    log.info(`[AutoUpdater] Download: ${Math.round(progress.percent)}%`);
  });

  // Evento: Download concluído - NOTIFICA O USUÁRIO
  autoUpdater.on('update-downloaded', (info) => {
    log.info('[AutoUpdater] Download concluído! Versão:', info.version);

    // Envia evento para TODAS as janelas abertas
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('update_downloaded', {
          version: info.version,
          releaseNotes: info.releaseNotes
        });
      }
    });
  });

  // Checa atualizações imediatamente
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('[AutoUpdater] Failed to check for updates:', err.message);
  });

  // Recheca a cada 1 hora (3600000ms)
  setInterval(() => {
    log.info('[AutoUpdater] Scheduled check...');
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('[AutoUpdater] Scheduled check failed:', err.message);
    });
  }, 60 * 60 * 1000);
}

// Handler IPC: Usuário clicou em "Reiniciar Agora"
ipcMain.on('restart_app', () => {
  log.info('[AutoUpdater] Usuário solicitou reinício para atualização');
  autoUpdater.quitAndInstall(false, true);
});

// Handler IPC: Usuário clicou em "Check Now" nas Preferences
ipcMain.on('check-for-updates', (event) => {
  log.info('[AutoUpdater] Verificação manual solicitada pelo usuário');

  // Só funciona em produção
  if (!app.isPackaged) {
    log.info('[AutoUpdater] Modo desenvolvimento - simulando resposta');
    event.sender.send('update-check-result', {
      status: 'dev-mode',
      message: 'Auto-update only works on packaged builds (.exe).'
    });
    return;
  }

  // Registra handlers temporários para esta verificação manual
  const onUpdateAvailable = (info) => {
    event.sender.send('update-check-result', {
      status: 'available',
      version: info.version,
      message: `New version ${info.version} available! Download starting...`
    });
  };

  const onUpdateNotAvailable = (info) => {
    event.sender.send('update-check-result', {
      status: 'up-to-date',
      version: info.version,
      message: 'You are already using the latest version.'
    });
  };

  const onError = (err) => {
    event.sender.send('update-check-result', {
      status: 'error',
      message: `Error checking for updates: ${err.message}`
    });
  };

  // Adiciona listeners temporários
  autoUpdater.once('update-available', onUpdateAvailable);
  autoUpdater.once('update-not-available', onUpdateNotAvailable);
  autoUpdater.once('error', onError);

  // Inicia verificação
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('[AutoUpdater] Manual check failed:', err.message);
    event.sender.send('update-check-result', {
      status: 'error',
      message: `Connection failed: ${err.message}`
    });
  });
});

// Fecha a aplicação quando todas as janelas são fechadas (exceto macOS)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ============================================================
// SEÇÃO 8: LEITURA DE ARQUIVOS (ASSÍNCRONA)
// ============================================================
/**
 * readFileContent
 * ----------------
 * Lê conteúdo de arquivos de diferentes formatos.
 * Suporta: .txt, .docx, .doc, .pdf, .rtf
 * 
 * @param {string} filePath - Caminho absoluto do arquivo
 * @returns {Promise<string>} Conteúdo textual do arquivo
 */
async function readFileContent(filePath) {
  // OTIMIZAÇÃO: Usa Promises nativas do Node.js
  const fsPromises = require('fs').promises;
  const extension = path.extname(filePath).toLowerCase();

  // SEGURANÇA: Impede leitura de caminhos relativos suspeitos
  if (!path.isAbsolute(filePath)) {
    throw new Error("Caminho de arquivo inseguro.");
  }

  try {
    // PTQ: Formato Proprietário PromptIQ (JSON com HTML)
    if (extension === '.ptq') {
      const ptqContent = await fsPromises.readFile(filePath, 'utf-8');
      try {
        const ptqData = JSON.parse(ptqContent);
        return ptqData.content || '';
      } catch (parseError) {
        console.warn('Arquivo .ptq inválido, tratando como texto:', parseError.message);
        return ptqContent;
      }
    }

    // DOCX: Converte para HTML para manter formatação (negrito, itálico, etc)
    if (extension === '.docx') {
      try {
        const buffer = await fsPromises.readFile(filePath);
        const result = await mammoth.convertToHtml({ buffer: buffer });
        return result.value;
      } catch (docxError) {
        console.error('Erro ao ler DOCX:', docxError.message);
        throw new Error('Não foi possível ler o arquivo .docx. Verifique se não está aberto no Word.');
      }
    }
    if (extension === '.doc') return (await new WordExtractor().extract(filePath)).getBody();

    // OTIMIZAÇÃO: Leitura assíncrona de PDF
    if (extension === '.pdf') {
      const buffer = await fsPromises.readFile(filePath);
      const pdfParser = new PDFParse({ data: buffer });
      const result = await pdfParser.getText();
      await pdfParser.destroy();
      return result.text;
    }

    // OTIMIZAÇÃO: Leitura assíncrona de RTF
    if (extension === '.rtf') {
      const rtfRaw = await fsPromises.readFile(filePath, 'utf-8');
      return extractTextFromRtf(rtfRaw);
    }

    // OTIMIZAÇÃO: Texto puro ou HTML com detecção de encoding
    const buffer = await fsPromises.readFile(filePath);
    let text = buffer.toString('utf-8');

    // Se tiver caracteres de substituição (indica encoding errado)
    if (text.includes('\ufffd')) {
      // Tenta Latin-1 (ISO-8859-1) - comum em arquivos Windows antigos
      text = buffer.toString('latin1');
    }

    // Detecta se o arquivo contém HTML (salvo pelo PromptIQ)
    // Verifica tags HTML comuns que indicam formatação preservada
    const htmlPattern = /<(p|div|span|br|strong|em|b|i|u|font)\b[^>]*>/i;
    if (htmlPattern.test(text)) {
      // Arquivo contém HTML - retorna como está para preservar formatação
      return text;
    }

    return text;

  } catch (error) {
    throw new Error(`Erro leitura: ${error.message}`);
  }
}

// ============================================================
// SEÇÃO 9: IPC HANDLERS - CONTROLE DE JANELA
// ============================================================
// Handlers para minimizar, maximizar, fullscreen e fechar janelas

ipcMain.on('control-window', (event, command) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (command === 'minimize') win.minimize();
  if (command === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (command === 'fullscreen') win.setFullScreen(!win.isFullScreen()); // NOVO: Alterna Fullscreen Real
  if (command === 'close') win.close();
  if (command === 'exit') app.quit();
});

ipcMain.on('menu-action', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.webContents.send('menu-action', payload);
});

ipcMain.on('set-spell-check-language', (event, langCode) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.webContents.session.setSpellCheckerLanguages([langCode]);
});

// ============================================================
// SEÇÃO 10: IPC HANDLERS - OPERAÇÕES DE ARQUIVO
// ============================================================
// Handlers para abrir, salvar e gerenciar arquivos

// Abre diálogo para selecionar arquivo (na mesma janela)
ipcMain.on('open-file-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'PromptIQ', extensions: ['ptq'] },
      { name: 'Documentos', extensions: ['txt', 'docx', 'doc', 'pdf', 'rtf'] },
      { name: 'Todos os Arquivos', extensions: ['*'] }
    ]
  });
  if (!canceled && filePaths[0]) {
    try {
      const content = await readFileContent(filePaths[0]);
      event.sender.send('file-opened', { content, name: path.basename(filePaths[0]), path: filePaths[0] });
    } catch (err) { dialog.showErrorBox('Erro', err.message); }
  }
});

// Abre arquivo em uma NOVA janela (com offset de posição)
ipcMain.on('open-file-dialog-new-window', async (event) => {
  const parentWin = BrowserWindow.fromWebContents(event.sender);
  if (!parentWin) return;

  const { canceled, filePaths } = await dialog.showOpenDialog(parentWin, {
    properties: ['openFile'],
    filters: [
      { name: 'PromptIQ', extensions: ['ptq'] },
      { name: 'Documentos', extensions: ['txt', 'docx', 'doc', 'pdf', 'rtf'] },
      { name: 'Todos os Arquivos', extensions: ['*'] }
    ]
  });

  if (!canceled && filePaths[0]) {
    try {
      const filePath = filePaths[0];
      const content = await readFileContent(filePath);
      const fileName = path.basename(filePath);
      const bounds = parentWin.getBounds();

      // 1. Cria a janela
      const newWin = new BrowserWindow({
        width: 1200,
        height: 800,
        title: `Editor: ${fileName}`,
        icon: APP_ICON,
        frame: false,
        titleBarStyle: 'hidden',
        x: bounds.x + 30,
        y: bounds.y + 30,
        webPreferences: {
          // Ajustei para usar o mesmo preload da janela principal
          preload: path.join(__dirname, 'preload.js'),
          nodeIntegration: true,
          contextIsolation: false,
          spellcheck: true,
          backgroundThrottling: true,
          v8CacheOptions: 'none'
        }
      });

      // 2. Configura a janela
      newWin.setMenuBarVisibility(false);
      newWin.removeMenu();
      attachContextMenu(newWin);

      // 3. Define o que acontece quando terminar de carregar
      newWin.webContents.once('did-finish-load', () => {
        newWin.webContents.send('file-opened', { content, name: fileName, path: filePath });
        // Evita erro se settings não existir
        if (typeof currentSettings !== 'undefined') {
          newWin.webContents.send('settings-updated-globally', currentSettings);
        }
      });

      // 4. Carrega o arquivo HTML (Correção do caminho aqui)
      // Certifique-se que esta linha está DENTRO do bloco try
      newWin.loadFile(path.join(__dirname, '../../public/html/index.html'));

      // 5. Limpeza ao fechar
      newWin.on('closed', () => {
        // Verifica se windowPairs existe antes de deletar
        if (typeof windowPairs !== 'undefined') {
          windowPairs.delete(newWin.id);
        }
      });

    } catch (err) {
      console.error(err); // Ajuda a ver o erro no terminal
      dialog.showErrorBox('Erro ao abrir janela', err.message);
    }
  }
});

// Reabre arquivo da lista de recentes
ipcMain.on('reopen-recent-file', async (event, filePath) => {
  try {
    const content = await readFileContent(filePath);
    event.sender.send('file-opened', { content, name: path.basename(filePath), path: filePath });
  } catch (err) { dialog.showErrorBox('Erro ao abrir recente', `Arquivo não encontrado: ${err.message}`); }
});

// Limpa lista de arquivos recentes
ipcMain.on('clear-recent-files-data', () => { console.log("Limpando recentes..."); });

// Diálogo de confirmação ao fechar documento não salvo
ipcMain.on('confirm-close-dialog', async (event, editorId, fileName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save', 'Do not save', 'Cancelar'], defaultId: 0,
    title: 'Save Changes?', message: `The file "${fileName}" has unsaved changes.`
  });
  if (response === 0) event.sender.send('prompt-save-and-close', editorId);
  else if (response === 1) event.sender.send('close-document-unsaved', editorId);
});

// ============================================================
// SEÇÃO 11: IPC HANDLERS - DIÁLOGOS DE SALVAMENTO
// ============================================================
// Handlers para salvar arquivos com diálogo, salvamento direto e impressão

// Diálogo "Salvar Como" padrão - com suporte a .ptq
ipcMain.on('save-file-dialog', async (event, content, editorId, defaultName = 'Untitled.ptq') => {
  const win = BrowserWindow.fromWebContents(event.sender);

  // Garante extensão .ptq como padrão
  let saveName = path.basename(defaultName);
  if (!saveName.endsWith('.ptq') && !saveName.endsWith('.txt') && !saveName.endsWith('.html')) {
    saveName = saveName.replace(/\.[^.]+$/, '') + '.ptq';
  }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: saveName,
    filters: [
      { name: 'PromptIQ (Formatação Preservada)', extensions: ['ptq'] },
      { name: 'Texto Puro', extensions: ['txt'] },
      { name: 'HTML', extensions: ['html'] }
    ]
  });

  if (!canceled && filePath) {
    const extension = path.extname(filePath).toLowerCase();

    if (extension === '.ptq') {
      // Salva como JSON com metadados
      const ptqData = {
        content: content,
        metadata: {
          version: '1.0',
          createdAt: new Date().toISOString(),
          app: 'PromptIQ',
          format: 'rich-text-html'
        }
      };
      fs.writeFileSync(filePath, JSON.stringify(ptqData, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    event.sender.send('file-saved', path.basename(filePath), filePath, editorId);
  }
});

// Salvamento direto (sobrescreve arquivo existente) - detecta .ptq
ipcMain.on('save-file-direct', (event, content, editorId, filePath) => {
  if (filePath) {
    const extension = path.extname(filePath).toLowerCase();

    if (extension === '.ptq') {
      const ptqData = {
        content: content,
        metadata: {
          version: '1.0',
          updatedAt: new Date().toISOString(),
          app: 'PromptIQ',
          format: 'rich-text-html'
        }
      };
      fs.writeFileSync(filePath, JSON.stringify(ptqData, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    event.sender.send('file-saved-direct', path.basename(filePath), filePath, editorId);
  }
});

// Salva e fecha o documento - com suporte a .ptq
ipcMain.on('save-file-dialog-and-close', async (event, content, editorId, defaultName) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  let saveName = path.basename(defaultName || 'Untitled.ptq');
  if (!saveName.endsWith('.ptq') && !saveName.endsWith('.txt') && !saveName.endsWith('.html')) {
    saveName = saveName.replace(/\.[^.]+$/, '') + '.ptq';
  }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: saveName,
    filters: [
      { name: 'PromptIQ (Formatação Preservada)', extensions: ['ptq'] },
      { name: 'Texto Puro', extensions: ['txt'] },
      { name: 'HTML', extensions: ['html'] }
    ]
  });

  if (!canceled && filePath) {
    const extension = path.extname(filePath).toLowerCase();

    if (extension === '.ptq') {
      const ptqData = {
        content: content,
        metadata: {
          version: '1.0',
          createdAt: new Date().toISOString(),
          app: 'PromptIQ',
          format: 'rich-text-html'
        }
      };
      fs.writeFileSync(filePath, JSON.stringify(ptqData, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    event.sender.send('file-saved-and-closed', path.basename(filePath), filePath, editorId);
  }
});



// Abre diálogo de impressão nativo
ipcMain.on('print-document', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.webContents.print({ silent: false, printBackground: false });
});

// ============================================================
// HANDLER: Abrir Arquivo de Backup (.html)
// ============================================================
/**
 * Abre o diálogo do sistema para selecionar um arquivo de backup HTML
 * e envia o conteúdo bruto para o renderer processar.
 * O diálogo abre diretamente na pasta Documentos/Promptiq_Backups.
 */
ipcMain.on('open-backup-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  // Define o caminho padrão para a pasta de backups
  const documentsPath = app.getPath('documents');
  const backupDir = path.join(documentsPath, 'Promptiq_Backups');

  // Verifica se a pasta existe, senão usa Documentos
  let defaultPath = documentsPath;
  try {
    if (fs.existsSync(backupDir)) {
      defaultPath = backupDir;
    }
  } catch (e) {
    // Se der erro, usa Documentos
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Importar Backup',
    defaultPath: defaultPath,
    properties: ['openFile'],
    filters: [
      { name: 'Arquivos HTML', extensions: ['html', 'htm'] }
    ]
  });

  if (!canceled && filePaths[0]) {
    try {
      // Lê o arquivo HTML como string bruta
      const rawHtml = fs.readFileSync(filePaths[0], 'utf-8');

      // Envia o conteúdo bruto para o renderer processar
      event.sender.send('backup-file-loaded', {
        content: rawHtml,
        name: path.basename(filePaths[0]),
        path: filePaths[0]
      });
    } catch (err) {
      dialog.showErrorBox('Erro ao Importar Backup', err.message);
    }
  }
});

// ============================================================
// HANDLER: Shadow Backup (Redundância de Segurança)
// ============================================================
/**
 * Salva arquivos de backup (.txt e .html) na pasta Documentos/Promptiq_Backups.
 * Recebe: { plainText, htmlContent, timestamp }
 * Formato dos arquivos: backup_YYYY-MM-DD_HH-mm.txt e .html
 */
ipcMain.on('save-backup-files', async (event, backupData) => {
  const fsPromises = require('fs').promises;

  try {
    // 1. Define o diretório de backup na pasta Documentos do usuário
    const documentsPath = app.getPath('documents');
    const backupDir = path.join(documentsPath, 'Promptiq_Backups');

    // 2. Cria a pasta de backups se não existir
    try {
      await fsPromises.access(backupDir);
    } catch {
      await fsPromises.mkdir(backupDir, { recursive: true });
      console.log('[Shadow Backup] Pasta criada:', backupDir);
    }

    // 3. Gera nome do arquivo com timestamp
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/T/, '_')
      .replace(/:/g, '-')
      .slice(0, 16); // YYYY-MM-DD_HH-mm

    const baseFileName = `backup_${timestamp}`;
    const txtFilePath = path.join(backupDir, `${baseFileName}.txt`);
    const htmlFilePath = path.join(backupDir, `${baseFileName}.html`);

    // 4. Salva os arquivos de forma assíncrona
    await Promise.all([
      fsPromises.writeFile(txtFilePath, backupData.plainText, 'utf-8'),
      fsPromises.writeFile(htmlFilePath, backupData.htmlContent, 'utf-8')
    ]);

    console.log(`[Shadow Backup] Salvos com sucesso: ${baseFileName}.txt e .html`);

  } catch (error) {
    // CRÍTICO: Apenas loga o erro, NÃO exibe diálogo ao usuário
    console.error('[Shadow Backup] Erro ao salvar:', error.message);
  }
});

// ============================================================
// SEÇÃO 12: JANELA DE PREFERÊNCIAS
// ============================================================
// Abre janela modal de preferências e gerencia imagem de standby

ipcMain.on('open-preferences-window', () => {
  const win = new BrowserWindow({
    width: 830,
    height: 800,
    title: "Preferences",
    icon: APP_ICON,
    parent: controlWindow,
    modal: true,
    resizable: false,

    // === CORREÇÃO AQUI ===
    frame: false,              // Remove a barra branca/padrão do Windows
    titleBarStyle: 'hidden',   // Garante comportamento sem bordas em Mac/Linux também
    // =====================

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      v8CacheOptions: 'none'   // Modal temporário, não precisa de cache
    }
  });

  win.setMenuBarVisibility(false);
  win.removeMenu();
  win.loadFile(path.join(__dirname, '../../public/html/preferences.html'));

  // DEBUG: Abre DevTools automaticamente para debug
  win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.on('did-finish-load', () => {
    // Recarrega configurações do disco para garantir dados atualizados
    currentSettings = { ...defaultSettings, ...loadSettingsFromDisk() };
    console.log("📤 Enviando settings para Preferences:", JSON.stringify({
      showProgressIndicator: currentSettings.showProgressIndicator,
      continuousLoop: currentSettings.continuousLoop
    }));
    win.webContents.send('load-settings', currentSettings);
    win.webContents.send('apply-theme', currentSettings.appTheme || 'light');
  });
});

// Handler para mudar tema globalmente
let currentAppTheme = 'light';
ipcMain.on('set-app-theme', (event, theme) => {
  currentAppTheme = theme;
  currentSettings.appTheme = theme;
  // Propaga para todas as janelas
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('apply-theme', theme);
    }
  });
});

// Abre diálogo para selecionar imagem de standby
ipcMain.on('open-standby-image-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'], filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'gif'] }]
  });
  if (!canceled && filePaths.length > 0) { event.sender.send('standby-image-selected', filePaths[0]); }
});

// ============================================================
// SEÇÃO 13: PERSISTÊNCIA DE CONFIGURAÇÕES
// ============================================================
// Salva configurações em arquivo e propaga para todas as janelas

ipcMain.on('save-settings', (event, settings) => {
  // Ignora se settings estiver vazio ou undefined
  if (!settings || Object.keys(settings).length === 0) {
    console.log("⚠️ save-settings ignorado: objeto vazio recebido");
    return;
  }

  console.log("💾 Recebendo settings para salvar:", JSON.stringify({
    showProgressIndicator: settings.showProgressIndicator,
    continuousLoop: settings.continuousLoop
  }));
  currentSettings = { ...currentSettings, ...settings };
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('settings-updated-globally', currentSettings);
  });

  // --- ADICIONE ISTO: Salva no arquivo físico ---
  try {
    fs.writeFileSync(configPath, JSON.stringify(currentSettings, null, 2));
    console.log("✅ Configurações salvas em:", configPath);
  } catch (err) {
    console.error("❌ Erro ao salvar config:", err);
  }
  // ----------------------------------------------

  // Notifica todas as janelas abertas
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('settings-updated-globally', currentSettings);
  });

});

// Solicita configurações iniciais ao carregar
ipcMain.on('request-initial-settings', (e) => e.sender.send('settings-updated-globally', currentSettings));

// Salva uma configuração individual (para updates parciais como lastUpdateCheck)
ipcMain.on('save-setting', (event, { key, value }) => {
  if (!key) return;
  currentSettings[key] = value;
  try {
    fs.writeFileSync(configPath, JSON.stringify(currentSettings, null, 2));
    console.log(`✅ Configuração '${key}' salva:`, value);
  } catch (err) {
    console.error("❌ Erro ao salvar config:", err);
  }
});

// Reverte conteúdo de arquivo para última versão salva
ipcMain.on('revert-file-content', async (e, p, id) => {
  try { e.sender.send('file-content-reverted', id, await readFileContent(p)); } catch (err) { }
});

// Define título da janela dinamicamente
ipcMain.on('set-window-title', (e, title) => { if (!e.sender.isDestroyed()) BrowserWindow.fromWebContents(e.sender).setTitle(title); });

// Diálogos de informação e erro
ipcMain.on('show-info-dialog', (e, t, m) => dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { type: 'info', title: t, message: m, buttons: ['OK'] }));
ipcMain.on('show-error-dialog', (e, t, m) => dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { type: 'error', title: t, message: m, buttons: ['OK'] }));

// ============================================================
// SEÇÃO 14: HANDLERS DE HISTÓRICO DE VERSÕES
// ============================================================
// Salva e carrega arquivos .json com histórico de versões

// Salvar arquivo com histórico (.json)
ipcMain.on('save-file-with-history', (event, data) => {
  // data = { filePath: string, content: string, history: array }
  try {
    const jsonString = JSON.stringify(data, null, 2);
    fs.writeFileSync(data.filePath, jsonString, 'utf-8');
    // Confirma para o renderer que salvou
    event.sender.send('history-saved-success', data.filePath);
  } catch (err) {
    dialog.showErrorBox('Erro ao Salvar Histórico', err.message);
  }
});

// Ler arquivo com histórico
ipcMain.on('read-file-with-history', (event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw); // Tenta ler como JSON
    event.sender.send('file-history-loaded', data);
  } catch (err) {
    // Se der erro (ex: tentou abrir um .txt normal como histórico), avisa
    event.sender.send('file-history-error', err.message);
  }
});

// ============================================================
// SEÇÃO 15: SERVIDOR REMOTO (WI-FI E INTERNET)
// ============================================================
// Express + Socket.io para controle remoto via Wi-Fi
// WebRTC para conexão P2P via internet (roteiro.promptiq.com.br)

// HTML da página de controle remoto (carregado do arquivo)
const remotePageHTML = fs.readFileSync(path.join(__dirname, '../../public/html/remote.html'), 'utf-8');

/**
 * Handler para iniciar/parar servidor remoto
 * @param {string} mode - 'local' para Wi-Fi ou 'internet' para WebRTC
 * @returns {Object} - Status e informações de conexão (IP, porta, código)
 */
ipcMain.handle('toggle-server', async (event, mode) => {
  // MODO LOCAL (WI-FI)
  if (mode === 'local') {
    if (isRemoteRunning) {
      if (remoteServer) remoteServer.close();
      isRemoteRunning = false;
      return { active: false, mode: 'local' };
    } else {
      // --- INÍCIO DA VERIFICAÇÃO DE REDE ---
      const { networkInterfaces } = require('os');
      const nets = networkInterfaces();
      let ip = null;

      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          // Busca um IPv4 que não seja o 127.0.0.1 (internal)
          if (net.family === 'IPv4' && !net.internal) {
            ip = net.address;
          }
        }
      }

      // 🔴 Se não achar IP, cancela tudo aqui e avisa o Renderer
      if (!ip) {
        throw new Error("No active Wi-Fi or Ethernet networks detected..");
      }
      // --- FIM DA VERIFICAÇÃO DE REDE ---

      try {
        remoteApp = express();
        remoteServer = http.createServer(remoteApp);
        remoteIo = socketIo(remoteServer);

        currentSessionID = Math.floor(100000 + Math.random() * 900000).toString();
        remoteApp.get('/', (req, res) => res.send(remotePageHTML));

        remoteIo.on('connection', (socket) => {

          socket.on('join-session', (userData) => {
            if (userData.pin === currentSessionID) {
              socket.join(currentSessionID);
              socket.userName = userData.name || "Anonymous";
              socket.emit('login-success', true);

              // Busca janela ativa no momento (não guarda referência antiga)
              const mainWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
              if (mainWin) mainWin.webContents.send('request-text-for-remote');
              if (mainWin) {
                mainWin.webContents.send('add-log', {
                  msg: `${socket.userName} Entered the room.`,
                  type: 'login',
                  source: 'Local Network',
                  user: socket.userName
                });
              }
            } else {
              socket.emit('login-error', 'ID Incorrect!');
            }
          });

          socket.on('text-update', (data) => {
            const textContent = (data && data.content) ? data.content : data;
            const editorName = (data && data.name) ? data.name : (socket.userName || "Someone");
            BrowserWindow.getAllWindows().forEach(w => {
              if (!w.isDestroyed()) w.webContents.send('update-from-remote', textContent);
            });
            socket.broadcast.to(currentSessionID).emit('server-text-update', textContent);

            // Envia log para janela principal (verificando se não foi destruída)
            const mainWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
            if (mainWin) {
              mainWin.webContents.send('add-log', {
                msg: `${editorName} is typing...`,
                type: 'edit',
                user: editorName,
                source: 'Local Network'
              });
            }
          });

          socket.on('disconnect', () => {
            // Busca janela ativa no momento do disconnect (não usa referência antiga)
            const mainWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
            if (socket.userName && mainWin) {
              mainWin.webContents.send('add-log', {
                msg: `${socket.userName} Left the room.`,
                type: 'logout',
                source: 'Local Network',
                user: socket.userName
              });
            }
          });
        });

        remoteServer.listen(3001);
        isRemoteRunning = true;

        // Retorna o IP real que encontramos na verificação acima
        return { active: true, url: `http://${ip}:3001`, mode: 'local', pin: currentSessionID };

      } catch (err) {
        console.error(err);
        isRemoteRunning = false;
        throw err;
      }
    }
  }
  else if (mode === 'ngrok') {
    return { active: true, url: "Generating ID...", mode: 'webrtc' };
  }
});

// Sincroniza texto do PC para dispositivos remotos conectados
ipcMain.on('send-text-to-remote', (event, content) => {
  if (remoteIo) {
    remoteIo.emit('server-text-update', content);
  }
});

// ============================================================
// SEÇÃO 16: OVERLAY E MENSAGENS RÁPIDAS
// ============================================================
// Broadcast de mensagens de overlay para todas as janelas

// Envia mensagem de overlay para todas as janelas abertas
ipcMain.on('broadcast-overlay-message', (event, item) => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('show-overlay-message', item);
    }
  });
});

// ============================================================
// SEÇÃO 17: SISTEMA DE HANDSHAKE (SINCRONIZAÇÃO INICIAL)
// ============================================================
// Evita tela preta ao abrir janelas de projeção

// A Janela da TV avisa que abriu e solicita ressincronização
ipcMain.on('projection-ready', (event) => {
  // O Main avisa todas as janelas (principalmente o Editor) para re-enviar os dados
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('request-resync-data');
    }
  });
});


// ============================================================
// SEÇÃO 18: ARQUITETURA DE BROADCAST (JANELA DE PROJEÇÃO)
// ============================================================
// Cria janela de projeção para segunda tela (HDMI)
// Sincroniza scroll, conteúdo e marcador entre janelas

ipcMain.on('open-projection-window', () => {
  const displays = screen.getAllDisplays();

  // Tenta encontrar display externo
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
    title: "Teleprompter Output",
    autoHideMenuBar: true,
    icon: APP_ICON,
    backgroundColor: '#000000',
    fullscreen: false, // Começa em janela
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,  // Mantém ativo para sincronização em tempo real
      v8CacheOptions: 'none'        // Reduz cache V8 (~10-20MB)
    }
  });

  projectionWin.loadFile(path.join(__dirname, '../../public/html/projection.html'));

  // 🔥 CORREÇÃO CRÍTICA: Quando terminar de carregar, sincroniza TUDO
  projectionWin.webContents.once('did-finish-load', () => {
    console.log("✅ Janela de Broadcast carregada");

    // 1. Envia as configurações
    projectionWin.webContents.send('settings-updated-globally', currentSettings);

    // 2. Pede para o App.js mandar o conteúdo
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed() && win !== projectionWin) {
        win.webContents.send('request-resync-data');
      }
    });
  });

  // Opcional: Abre DevTools para debug
  // projectionWin.webContents.openDevTools();
});

// ============================================================
// SEÇÃO 19: SINCRONIZAÇÃO EM TEMPO REAL
// ============================================================
// Sincroniza posição de scroll, conteúdo e marcador entre janelas

// Sincronia de posição do scroll (60 FPS - Alta Performance)
ipcMain.on('sync-scroll-position', (event, position) => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-scroll', position);
    }
  });
});

// Atualiza conteúdo do prompter em todas as janelas (exceto remetente)
ipcMain.on('update-prompter-content', (event, content) => {
  BrowserWindow.getAllWindows().forEach(win => {
    // A lógica original impedia o envio se o remetente fosse a própria janela
    // Mas a projectionWin precisa receber de QUALQUER um.

    // Se a janela não for destruída E (não for quem enviou OU for a janela de projeção)
    if (!win.isDestroyed() && (win.webContents.id !== event.sender.id)) {
      win.webContents.send('update-prompter-content', content);
    }
  });
});

// Comandos de controle do prompter (Play/Pause Remoto)
ipcMain.on('control-prompter', (event, command) => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('control-prompter', command);
    }
  });
});

// Sincroniza posição do marcador (CUE MARKER) entre janelas
ipcMain.on('sync-marker-position', (event, positionData) => {
  // positionData pode ser apenas o número (Y) ou um objeto { top: 123, visible: true }
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
      win.webContents.send('update-marker-position', positionData);
    }
  });
});