// ============================================================
// font-service.js
// ============================================================
// DESCRIÇÃO: Serviço de gerenciamento de tamanho de fonte
// FUNÇÃO: Centraliza a lógica de aplicação de tamanho de fonte
//         no editor e no prompter (operator), com sincronia
//         entre ambos e atualização da interface (UI).
// ============================================================

/**
 * FontService
 * ------------
 * Módulo responsável pelo controle de tamanho de fonte.
 * Gerencia aplicação no editor, operator e sincronização da UI.
 */
const FontService = (function () {

  // ============================================================
  // ESTADO INTERNO
  // ============================================================
  let currentFontSizePT = 32;  // Tamanho padrão em pontos

  // ============================================================
  // REFERÊNCIAS DOM
  // ============================================================
  let toolbarSizeFix = null;      // Input de tamanho na toolbar
  let fontSizePreset = null;      // Select com tamanhos pré-definidos
  let fontSizeCustom = null;      // Input para tamanho customizado
  let fontSizeMenuItems = null;   // Itens do menu Format > Size

  // ============================================================
  // CALLBACKS EXTERNOS
  // ============================================================
  let getActiveTextEditorArea = null;
  let getActiveDocumentId = null;
  let markDocumentAsUnsaved = null;
  let syncContentToPrompter = null;
  let restoreSelection = null;
  let ipcRenderer = null;

  // ============================================================
  // INICIALIZAÇÃO DO MÓDULO
  // ============================================================
  /**
   * init
   * -----
   * Inicializa o serviço de fontes com referências e callbacks.
   */
  function init(options) {
    toolbarSizeFix = options.toolbarSizeFix || document.getElementById('font-size-toolbar-fix');
    fontSizePreset = options.fontSizePreset || document.getElementById('font-size-preset');
    fontSizeCustom = options.fontSizeCustom || document.getElementById('font-size-custom');
    fontSizeMenuItems = options.fontSizeMenuItems || document.querySelectorAll('.size-option');

    getActiveTextEditorArea = options.getActiveTextEditorArea;
    getActiveDocumentId = options.getActiveDocumentId;
    markDocumentAsUnsaved = options.markDocumentAsUnsaved;
    syncContentToPrompter = options.syncContentToPrompter;
    restoreSelection = options.restoreSelection;
    ipcRenderer = options.ipcRenderer;

    // Configura listeners
    setupToolbarInput();
    setupPresetSelect();
    setupCustomInput();
    setupMenuItems();
  }

  // ============================================================
  // FUNÇÃO: Aplicar Tamanho no Editor
  // ============================================================
  /**
   * applyExactFontSizeToEditor
   * ---------------------------
   * Aplica o tamanho de fonte em pontos (pt) ao texto no editor.
   * Usa execCommand para compatibilidade, depois corrige para CSS.
   * 
   * @param {number} sizeInPt - Tamanho em pontos
   */
  function applyExactFontSizeToEditor(sizeInPt) {
    const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
    if (!editor) return;

    console.log("✏️ Aplicando font size no Editor:", sizeInPt + "pt");

    editor.focus();
    document.execCommand("styleWithCSS", false, true);

    // ========================================
    // SELECIONA TODO O TEXTO
    // ========================================
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // ========================================
    // APLICA TAMANHO VIA EXECCOMMAND
    // ========================================
    // Usa fontSize com valor 1-7, depois corrige para pt
    const fontSizeValue = Math.floor(sizeInPt / 4);
    document.execCommand("fontSize", false, fontSizeValue);

    // ========================================
    // CORRIGE PARA VALOR EM PT
    // ========================================
    const fontSpans = editor.querySelectorAll('span[style*="font-size"]');
    fontSpans.forEach(span => {
      span.removeAttribute("size");
      span.style.fontSize = `${sizeInPt}pt`;
    });

    // Desseleciona e devolve foco
    selection.removeAllRanges();
    editor.focus();

    // Sincroniza com prompter
    if (syncContentToPrompter) syncContentToPrompter();

    // Marca documento como modificado
    const activeDocId = getActiveDocumentId ? getActiveDocumentId() : null;
    if (activeDocId && markDocumentAsUnsaved) {
      markDocumentAsUnsaved(activeDocId);
    }
  }

  // ============================================================
  // FUNÇÃO: Aplicar Tamanho no Operator (Prompter)
  // ============================================================
  /**
   * applyExactFontSizeToOperator
   * -----------------------------
   * Aplica o tamanho de fonte no texto do prompter (aba Operator).
   * 
   * @param {number} sizeInPt - Tamanho em pontos
   */
  function applyExactFontSizeToOperator(sizeInPt) {
    const prompterText = document.getElementById('prompterText-control');

    if (prompterText) {
      console.log("📺 Aplicando font size no Operator:", sizeInPt + "pt");
      prompterText.style.fontSize = `${sizeInPt}pt`;
      prompterText.style.lineHeight = "1.4";  // Mantém espaçamento legível
    }
  }

  // ============================================================
  // FUNÇÃO: Atualizar Estado da UI
  // ============================================================
  /**
   * updateFontUIState
   * ------------------
   * Atualiza todos os elementos de interface relacionados a fonte.
   * 
   * @param {string|null} fontName - Nome da fonte (opcional)
   * @param {number|null} fontSize - Tamanho da fonte (opcional)
   */
  function updateFontUIState(fontName, fontSize) {
    // Atualiza memória global
    if (fontSize) {
      currentFontSizePT = fontSize;
    }

    // Atualiza input da toolbar
    if (fontSize && toolbarSizeFix) {
      toolbarSizeFix.value = fontSize;
    }

    // Atualiza input customizado
    if (fontSize && fontSizeCustom) {
      fontSizeCustom.value = fontSize;
    }

    // Atualiza select pré-definido
    if (fontSize && fontSizePreset) {
      const existsInPreset = Array.from(fontSizePreset.options).some(
        opt => opt.value == fontSize
      );
      fontSizePreset.value = existsInPreset ? fontSize : "";
    }

    // ========================================
    // LIMPA CHECKMARKS ANTERIORES
    // ========================================
    document.querySelectorAll(
      '.menu-item[data-action="set-font"], ' +
      '.font-option, ' +
      '.menu-item[data-action="set-size"], ' +
      '.size-option'
    ).forEach(el => el.classList.remove('checked', 'active'));

    // Aplica checkmark na fonte atual
    if (fontName) {
      const cleanFont = fontName.replace(/['"]/g, "");
      const fontItem = document.querySelector(`[data-value="${cleanFont}"]`);
      if (fontItem) fontItem.classList.add('checked', 'active');
    }

    // Aplica checkmark no tamanho atual
    if (fontSize) {
      const sizeItem = document.querySelector(`[data-value="${fontSize}"]`);
      if (sizeItem) sizeItem.classList.add('checked', 'active');
    }
  }

  // ============================================================
  // FUNÇÃO: Aplicar Tamanho Exato (Método Combinado)
  // ============================================================
  /**
   * applyExactFontSize
   * -------------------
   * Aplica o tamanho em ambos (editor e operator) e sincroniza UI.
   * 
   * @param {number} sizeInPt - Tamanho em pontos
   */
  function applyExactFontSize(sizeInPt) {
    if (!sizeInPt) return;

    currentFontSizePT = sizeInPt;

    applyExactFontSizeToEditor(sizeInPt);
    applyExactFontSizeToOperator(sizeInPt);
    updateFontUIState(null, sizeInPt);
  }

  // ============================================================
  // CONFIGURAÇÃO DO INPUT DA TOOLBAR
  // ============================================================
  function setupToolbarInput() {
    if (!toolbarSizeFix) return;

    toolbarSizeFix.addEventListener('input', (e) => {
      const valor = parseInt(e.target.value) || 12;

      // Validação: não deixar menor que 8 ou maior que 100
      if (valor < 8 || valor > 100) return;

      currentFontSizePT = valor;
      applyExactFontSizeToEditor(valor);
      applyExactFontSizeToOperator(valor);
      updateFontUIState(null, valor);

      // Salva nas preferências e sincroniza com a janela de projeção
      if (ipcRenderer) {
        ipcRenderer.send('save-settings', { defaultFontSize: valor });
        ipcRenderer.send('sync-projection-font-size', valor);
      }
    });

    // Devolve foco ao editor quando apertar Enter
    toolbarSizeFix.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
        if (editor) editor.focus();
      }
    });
  }

  // ============================================================
  // CONFIGURAÇÃO DO SELECT PRÉ-DEFINIDO
  // ============================================================
  function setupPresetSelect() {
    if (!fontSizePreset) return;

    fontSizePreset.addEventListener('change', (e) => {
      const val = parseInt(e.target.value);

      if (val > 0) {
        console.log("📐 Tamanho pré-definido selecionado:", val);

        applyExactFontSizeToEditor(val);
        applyExactFontSizeToOperator(val);
        updateFontUIState(null, val);

        // Sincroniza com janela de projeção
        if (ipcRenderer) {
          ipcRenderer.send('sync-projection-font-size', val);
        }

        // Limpa o input customizado
        if (fontSizeCustom) fontSizeCustom.value = "";

        // Foco no editor
        const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
        if (editor) editor.focus();
      }
    });
  }

  // ============================================================
  // CONFIGURAÇÃO DO INPUT CUSTOMIZADO
  // ============================================================
  function setupCustomInput() {
    if (!fontSizeCustom) return;

    // Aplica em tempo real enquanto digita
    fontSizeCustom.addEventListener('input', (e) => {
      const val = parseInt(e.target.value) || 0;

      if (val >= 8 && val <= 100) {
        console.log("📐 Tamanho customizado digitado:", val);

        applyExactFontSizeToEditor(val);
        applyExactFontSizeToOperator(val);
        updateFontUIState(null, val);

        // Sincroniza com janela de projeção
        if (ipcRenderer) {
          ipcRenderer.send('sync-projection-font-size', val);
        }

        // Limpa o select pré-definido
        if (fontSizePreset) fontSizePreset.value = "";
      }
    });

    // Enter devolve foco ao editor
    fontSizeCustom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = parseInt(e.target.value);
        if (val >= 8 && val <= 100) {
          const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
          if (editor) editor.focus();
        }
      }
    });

    // Valida o valor quando sai do input
    fontSizeCustom.addEventListener('blur', (e) => {
      const val = parseInt(e.target.value);

      if (val < 8) {
        fontSizeCustom.value = "8";
        applyExactFontSizeToEditor(8);
        applyExactFontSizeToOperator(8);
      } else if (val > 100) {
        fontSizeCustom.value = "100";
        applyExactFontSizeToEditor(100);
        applyExactFontSizeToOperator(100);
      }
    });
  }

  // ============================================================
  // CONFIGURAÇÃO DOS ITENS DO MENU
  // ============================================================
  function setupMenuItems() {
    if (!fontSizeMenuItems) return;

    fontSizeMenuItems.forEach(item => {
      item.addEventListener('click', (e) => {
        const val = parseInt(item.dataset.value);

        if (val > 0) {
          if (restoreSelection) restoreSelection();

          applyExactFontSizeToEditor(val);
          applyExactFontSizeToOperator(val);

          if (syncContentToPrompter) syncContentToPrompter();

          updateFontUIState(null, val);

          // Sincroniza com janela de projeção
          if (ipcRenderer) {
            ipcRenderer.send('sync-projection-font-size', val);
          }

          const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
          if (editor) editor.focus();

          console.log("✅ Font size aplicado e sincronizado!");
        }
      });
    });
  }

  // ============================================================
  // API PÚBLICA DO MÓDULO
  // ============================================================
  return {
    init,
    applyExactFontSize,
    applyExactFontSizeToEditor,
    applyExactFontSizeToOperator,
    updateFontUIState,
    getCurrentFontSize: () => currentFontSizePT,
    setCurrentFontSize: (size) => { currentFontSizePT = size; }
  };

})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FontService;
}
