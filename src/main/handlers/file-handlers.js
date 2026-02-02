// ============================================================
// file-handlers.js
// ============================================================
// DESCRIÇÃO: Handlers IPC para operações de arquivos
// FUNÇÃO: Gerencia abertura, salvamento, leitura e manipulação
//         de arquivos de roteiro nos formatos PTQ (proprietário),
//         TXT, DOCX, DOC, PDF e RTF através de diálogos do sistema.
// ============================================================

const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================================
// DEPENDÊNCIAS DE LEITURA DE FORMATOS ESPECIAIS
// ============================================================
const mammoth = require('mammoth');           // Leitor de .docx
const { PDFParse } = require('pdf-parse');    // Leitor de .pdf (v2.x)
const WordExtractor = require("word-extractor"); // Leitor de .doc antigo

/**
 * initFileHandlers
 * -----------------
 * Inicializa todos os handlers IPC relacionados a operações de arquivo.
 * 
 * @param {Function} extractTextFromRtf - Função para extrair texto de RTF
 * @param {Function} attachContextMenu - Função para anexar menu de contexto
 * @param {Object} currentSettings - Objeto de configurações atual (referência)
 * @param {Map} windowPairs - Mapa de janelas pareadas
 */
function initFileHandlers(extractTextFromRtf, attachContextMenu, currentSettings, windowPairs) {

  // ============================================================
  // FUNÇÃO AUXILIAR: Leitor Assíncrono de Conteúdo de Arquivo
  // ============================================================
  /**
   * readFileContent
   * ----------------
   * Lê o conteúdo de um arquivo e extrai o texto baseado na extensão.
   * 
   * Formatos suportados:
   * - .txt: Texto puro
   * - .docx: Word 2007+ (via mammoth)
   * - .doc: Word 97-2003 (via word-extractor)
   * - .pdf: PDF (via pdf-parse)
   * - .rtf: Rich Text Format (via parser customizado)
   * 
   * @param {string} filePath - Caminho absoluto do arquivo
   * @returns {Promise<string>} - Conteúdo do arquivo em texto puro
   */
  async function readFileContent(filePath) {
    const fsPromises = require('fs').promises;
    const extension = path.extname(filePath).toLowerCase();

    // SEGURANÇA: Impede leitura de caminhos relativos suspeitos
    if (!path.isAbsolute(filePath)) {
      throw new Error("Caminho de arquivo inseguro.");
    }

    try {
      // ========================================
      // PTQ: Formato Proprietário PromptIQ
      // JSON com HTML preservando formatação completa
      // ========================================
      if (extension === '.ptq') {
        const ptqContent = await fsPromises.readFile(filePath, 'utf-8');
        try {
          const ptqData = JSON.parse(ptqContent);
          // Retorna o HTML interno que preserva toda formatação
          return ptqData.content || '';
        } catch (parseError) {
          // Se não for JSON válido, trata como texto
          console.warn('Arquivo .ptq inválido, tratando como texto:', parseError.message);
          return ptqContent;
        }
      }

      // ========================================
      // DOCX: Word 2007 e posteriores
      // Converte para HTML para manter formatação
      // ========================================
      if (extension === '.docx') {
        try {
          // Lê o arquivo como buffer primeiro para verificar se está acessível
          const buffer = await fsPromises.readFile(filePath);
          const result = await mammoth.convertToHtml({ buffer: buffer });
          return result.value; // Retorna HTML com formatação
        } catch (docxError) {
          console.error('Erro ao ler DOCX:', docxError.message);
          // Tenta ler como texto puro como fallback
          throw new Error(`Não foi possível ler o arquivo .docx. Verifique se o arquivo não está aberto no Word ou corrompido.`);
        }
      }

      // ========================================
      // DOC: Word 97-2003 (formato binário antigo)
      // ========================================
      if (extension === '.doc') {
        return (await new WordExtractor().extract(filePath)).getBody();
      }

      // ========================================
      // PDF: Documento portátil
      // ========================================
      if (extension === '.pdf') {
        const buffer = await fsPromises.readFile(filePath);
        const pdfParser = new PDFParse({ data: buffer });
        const result = await pdfParser.getText();
        await pdfParser.destroy();
        return result.text;
      }

      // ========================================
      // RTF: Rich Text Format
      // ========================================
      if (extension === '.rtf') {
        const rtfRaw = await fsPromises.readFile(filePath, 'utf-8');
        return extractTextFromRtf(rtfRaw);
      }

      // ========================================
      // TXT e outros: Texto puro ou HTML
      // Tenta UTF-8 primeiro, se falhar tenta Latin-1
      // Detecta se contém HTML para preservar formatação
      // ========================================
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
  // HANDLER: Diálogo de Abrir Arquivo (Janela Atual)
  // ============================================================
  /**
   * Abre o diálogo do sistema para selecionar um arquivo e 
   * carrega seu conteúdo na janela atual.
   */
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
        event.sender.send('file-opened', {
          content,
          name: path.basename(filePaths[0]),
          path: filePaths[0]
        });
      } catch (err) {
        dialog.showErrorBox('Erro', err.message);
      }
    }
  });

  // ============================================================
  // HANDLER: Diálogo de Abrir Arquivo em Nova Janela
  // ============================================================
  /**
   * Abre o diálogo do sistema e cria uma nova janela do editor
   * para o arquivo selecionado.
   */
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

        // ========================================
        // CRIA NOVA JANELA DO EDITOR
        // ========================================
        const newWin = new BrowserWindow({
          width: 1200,
          height: 800,
          title: `Editor: ${fileName}`,
          frame: false,
          titleBarStyle: 'hidden',
          x: bounds.x + 30,  // Offset para não sobrepor a janela pai
          y: bounds.y + 30,
          webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            nodeIntegration: true,
            contextIsolation: false,
            spellcheck: true
          }
        });

        // Configurações da janela
        newWin.setMenuBarVisibility(false);
        newWin.removeMenu();
        attachContextMenu(newWin);

        // ========================================
        // ENVIA DADOS QUANDO A JANELA CARREGAR
        // ========================================
        newWin.webContents.once('did-finish-load', () => {
          newWin.webContents.send('file-opened', { content, name: fileName, path: filePath });
          if (typeof currentSettings !== 'undefined') {
            newWin.webContents.send('settings-updated-globally', currentSettings);
          }
        });

        // Carrega o HTML do editor
        newWin.loadFile(path.join(__dirname, '../../public/html/index.html'));

        // Limpeza ao fechar
        newWin.on('closed', () => {
          if (typeof windowPairs !== 'undefined') {
            windowPairs.delete(newWin.id);
          }
        });

      } catch (err) {
        console.error(err);
        dialog.showErrorBox('Erro ao abrir janela', err.message);
      }
    }
  });

  // ============================================================
  // HANDLER: Reabrir Arquivo Recente
  // ============================================================
  /**
   * Abre um arquivo a partir do caminho salvo na lista de recentes.
   */
  ipcMain.on('reopen-recent-file', async (event, filePath) => {
    try {
      const content = await readFileContent(filePath);
      event.sender.send('file-opened', {
        content,
        name: path.basename(filePath),
        path: filePath
      });
    } catch (err) {
      dialog.showErrorBox('Erro ao abrir recente', `Arquivo não encontrado: ${err.message}`);
    }
  });

  // ============================================================
  // HANDLER: Limpar Lista de Arquivos Recentes
  // ============================================================
  ipcMain.on('clear-recent-files-data', () => {
    console.log("Limpando recentes...");
  });

  // ============================================================
  // HANDLER: Diálogo de Confirmação para Fechar Documento
  // ============================================================
  /**
   * Mostra diálogo perguntando se quer salvar alterações antes de fechar.
   */
  ipcMain.on('confirm-close-dialog', async (event, editorId, fileName) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Salvar', 'Não Salvar', 'Cancelar'],
      defaultId: 0,
      title: 'Salvar Alterações?',
      message: `O arquivo "${fileName}" tem alterações não salvas.`
    });

    if (response === 0) {
      // Usuário escolheu "Salvar"
      event.sender.send('prompt-save-and-close', editorId);
    } else if (response === 1) {
      // Usuário escolheu "Não Salvar"
      event.sender.send('close-document-unsaved', editorId);
    }
    // Se response === 2, usuário cancelou - não faz nada
  });

  // ============================================================
  // HANDLER: Diálogo "Salvar Como..."
  // ============================================================
  /**
   * Abre o diálogo do sistema para escolher onde salvar o arquivo.
   * O formato .ptq preserva toda a formatação (cores, estilos, etc.)
   */
  ipcMain.on('save-file-dialog', async (event, content, editorId, defaultName = 'Untitled.ptq') => {
    const win = BrowserWindow.fromWebContents(event.sender);

    // Garante extensão .ptq como padrão
    let saveName = path.basename(defaultName);
    if (!saveName.endsWith('.ptq')) {
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
          content: content,  // HTML com formatação
          metadata: {
            version: '1.0',
            createdAt: new Date().toISOString(),
            app: 'PromptIQ',
            format: 'rich-text-html'
          }
        };
        fs.writeFileSync(filePath, JSON.stringify(ptqData, null, 2), 'utf-8');
      } else {
        // Outros formatos: salva como texto/HTML direto
        fs.writeFileSync(filePath, content, 'utf-8');
      }

      event.sender.send('file-saved', path.basename(filePath), filePath, editorId);
    }
  });

  // ============================================================
  // HANDLER: Salvar Arquivo Direto (Ctrl+S quando já tem caminho)
  // ============================================================
  /**
   * Salva o arquivo diretamente no caminho já conhecido.
   * Detecta extensão para salvar no formato correto.
   */
  ipcMain.on('save-file-direct', (event, content, editorId, filePath) => {
    if (filePath) {
      const extension = path.extname(filePath).toLowerCase();

      if (extension === '.ptq') {
        // Salva como JSON com metadados
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

  // ============================================================
  // HANDLER: Salvar e Fechar Documento
  // ============================================================
  /**
   * Abre diálogo de salvar, salva o arquivo e depois fecha a aba.
   */
  ipcMain.on('save-file-dialog-and-close', async (event, content, editorId, defaultName) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    // Garante extensão .ptq como padrão
    let saveName = path.basename(defaultName || 'Untitled.ptq');
    if (!saveName.endsWith('.ptq')) {
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

  // ============================================================
  // HANDLER: Salvar Arquivo com Histórico (JSON)
  // ============================================================
  /**
   * Salva o arquivo incluindo o histórico de versões em formato JSON.
   */
  ipcMain.on('save-file-with-history', (event, data) => {
    // data = { filePath: string, content: string, history: array }
    try {
      const jsonString = JSON.stringify(data, null, 2);
      fs.writeFileSync(data.filePath, jsonString, 'utf-8');
      event.sender.send('history-saved-success', data.filePath);
    } catch (err) {
      dialog.showErrorBox('Erro ao Salvar Histórico', err.message);
    }
  });

  // ============================================================
  // HANDLER: Ler Arquivo com Histórico
  // ============================================================
  /**
   * Lê um arquivo JSON que contém conteúdo + histórico de versões.
   */
  ipcMain.on('read-file-with-history', (event, filePath) => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      event.sender.send('file-history-loaded', data);
    } catch (err) {
      event.sender.send('file-history-error', err.message);
    }
  });

  // ============================================================
  // HANDLER: Reverter para Versão Salva
  // ============================================================
  /**
   * Recarrega o conteúdo do arquivo do disco, descartando alterações.
   */
  ipcMain.on('revert-file-content', async (e, p, id) => {
    try {
      e.sender.send('file-content-reverted', id, await readFileContent(p));
    } catch (err) {
      // Silenciosamente falha se arquivo não existir mais
    }
  });

  // ============================================================
  // HANDLER: Imprimir Documento
  // ============================================================
  /**
   * Abre o diálogo de impressão do sistema.
   */
  ipcMain.on('print-document', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.webContents.print({ silent: false, printBackground: false });
    }
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
    const { app } = require('electron');
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
   * 
   * IMPORTANTE: Não emite alertas ao usuário em caso de erro.
   * Apenas loga no console para não interromper o fluxo de trabalho.
   */
  ipcMain.on('save-backup-files', async (event, backupData) => {
    const { app } = require('electron');
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
}

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
module.exports = {
  initFileHandlers
};
