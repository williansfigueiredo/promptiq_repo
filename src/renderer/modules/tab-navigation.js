// ============================================================
// tab-navigation.js
// ============================================================
// DESCRIÇÃO: Módulo de navegação entre abas com memória de posição
// FUNÇÃO: 
//   1. Persiste posição do scroll do Operator ao trocar de aba
//   2. Navegação contextual explícita: menu "Go to Operator" ou APIs
//      navigateToWordIndex / navigateToPosition
//   3. Mapeia palavras entre Editor e Operator usando índices
// ============================================================

const { ipcRenderer } = require('electron');

/**
 * TabNavigationManager
 * --------------------
 * Gerencia a navegação entre abas Edit e Operator com:
 * - Persistência de posição de scroll
 * - Navegação contextual por duplo clique
 * - Mapeamento de palavras entre containers
 */
const TabNavigationManager = {

  // ============================================================
  // ESTADO INTERNO
  // ============================================================
  operatorSavedScrollPosition: 0,    // Posição salva do scroll do Operator
  pendingWordIndex: null,             // Índice da palavra para navegar (duplo clique)
  pendingNavigationContext: null,     // Contexto adicional da navegação
  isInitialized: false,               // Flag de inicialização

  // Última posição do caret no editor (cursor piscando) — usada para
  // navegação direta ao Operator quando o usuário só posiciona o cursor
  // e troca de aba (sem precisar do menu de contexto).
  lastCaretEditor: null,
  lastCaretNode: null,
  lastCaretOffset: 0,
  lastCaretTimestamp: 0,
  editorReferenceArmed: false,
  lastEditorPointerPoint: null,

  // Sincronização Operator → Edit: índice da palavra visível no Operator
  // quando o usuário sair dessa aba, para sincronizar com o Editor
  operatorVisibleWordIndex: null,

  // Última aba ativa (id do gatilho Bootstrap), usada para saber
  // se a entrada no Operator veio realmente da aba Edit.
  currentTabTriggerId: null,

  // Limite de validade para navegação pendente. Se uma navegação ficar velha,
  // ela deve ser descartada para não reaplicar uma referência stale depois de
  // várias trocas de aba ou de scroll manual.
  navigationStaleMs: 4000,
  tabTransitionId: 0,
  tabTransitionTimers: [],
  tabTransitionRafs: [],
  lastAppliedScrollTransitionId: null,

  cancelPendingTabWork: function () {
    this.tabTransitionId += 1;
    this.tabTransitionTimers.forEach((timerId) => clearTimeout(timerId));
    this.tabTransitionTimers = [];
    this.tabTransitionRafs.forEach((rafId) => cancelAnimationFrame(rafId));
    this.tabTransitionRafs = [];
    this.lastAppliedScrollTransitionId = null;
  },

  scheduleTabWork: function (callback, delay) {
    const transitionId = this.tabTransitionId;
    const timerId = setTimeout(() => {
      this.tabTransitionTimers = this.tabTransitionTimers.filter((id) => id !== timerId);
      if (transitionId !== this.tabTransitionId) return;
      callback();
    }, delay);
    this.tabTransitionTimers.push(timerId);
  },

  scheduleTransitionFrame: function (callback) {
    const transitionId = this.tabTransitionId;
    const rafId = requestAnimationFrame(() => {
      this.tabTransitionRafs = this.tabTransitionRafs.filter((id) => id !== rafId);
      if (transitionId !== this.tabTransitionId) return;
      callback();
    });
    this.tabTransitionRafs.push(rafId);
  },

  // ============================================================
  // FUNÇÃO: Inicializar o módulo
  // ============================================================
  /**
   * init
   * -----
   * Configura todos os event listeners para navegação entre abas.
   * Deve ser chamado após o DOM estar carregado.
   */
  init: function () {
    if (this.isInitialized) return;

    const tabOperatorTrigger = document.getElementById('operator-tab');
    const tabHomeTrigger = document.getElementById('home-tab');

    const initialActiveTab = document.querySelector('[data-bs-toggle="tab"].active');
    if (initialActiveTab && initialActiveTab.id) {
      this.currentTabTriggerId = initialActiveTab.id;
    }

    // =========================================
    // MENU DE CONTEXTO: "IR PARA OPERATOR"
    // =========================================
    // Quando o IPC receber o comando, executa a navegação
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('go-to-operator-at-selection', (_event, payload) => {
      this.goToOperatorAtCurrentSelection(payload);
    });

    // Rastreia o último caret dentro do editor: ao sair do modo edição a seleção
    // pode já ter sido perdida (painel oculto / foco no botão).
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const parent = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const editor = parent && parent.closest ? parent.closest('.text-editor-area') : null;
      if (!editor || !editor.contains(node)) return;
      this.lastCaretEditor = editor;
      this.lastCaretNode = node;
      this.lastCaretOffset = range.startOffset;
      this.lastCaretTimestamp = Date.now();
    });

    // =========================================
    // EVENTOS DE TROCA DE ABA
    // =========================================

    // Ao sair do Operator -> Home (salva posição e para scroll)
    if (tabHomeTrigger) {
      tabHomeTrigger.addEventListener('show.bs.tab', () => {
        this.cancelPendingTabWork();
        // Para o scroll e salva posição ANTES de sair da aba Operator
        this.clearPendingNavigation();
        this.clearEditorReference();
        this.stopScrollIfRunning();
      });

      tabHomeTrigger.addEventListener('shown.bs.tab', () => {
        this.currentTabTriggerId = 'home-tab';

        // Força reflow da aba Home
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const homePane = document.getElementById('home-tab-pane');
            if (homePane) {
              void homePane.offsetHeight;
              homePane.classList.add('force-reflow');
              void homePane.offsetHeight;
              homePane.classList.remove('force-reflow');
            }

            // Dispara resize para recalcular layouts
            window.dispatchEvent(new Event('resize'));
          });
        });
      });
    }

    // Ao voltar para o Operator
    if (tabOperatorTrigger) {
      // Pré-aplica posição ANTES da aba aparecer (evita salto visual)
      tabOperatorTrigger.addEventListener('show.bs.tab', () => {
        this.cancelPendingTabWork();
        this.operatorVisibleWordIndex = null;

        // Restaura a posição salva ao voltar. Navegação por palavra só via menu
        // "Go to Prompter" (contexto do editor) ou navigateToWordIndex().
        this.preApplyScrollPosition();
      });

      tabOperatorTrigger.addEventListener('shown.bs.tab', () => {
        this.currentTabTriggerId = 'operator-tab';
        // Usa requestAnimationFrame duplo para garantir renderização completa
        this.scheduleTransitionFrame(() => {
          this.scheduleTransitionFrame(() => {
            // Força reflow para evitar texto cortado
            this.forceReflow();

            // Se há navegação pendente, aguarda um pouco mais para o conteúdo estar pronto
            if (this.pendingWordIndex !== null) {
              this.scheduleTabWork(() => {
                this.restoreOrNavigate();
              }, 100);
            } else {
              this.restoreOrNavigate();
            }

            // Devolve foco para o teclado funcionar
            const prompterControl = document.querySelector('.prompter-in-control');
            if (prompterControl) {
              prompterControl.setAttribute('tabindex', '-1');
              prompterControl.focus({ preventScroll: true });
            }

            // Dispara resize adicional após tudo estar pronto
            this.scheduleTabWork(() => {
              window.dispatchEvent(new Event('resize'));
            }, 50);
          });
        });
      });
    }

    this.isInitialized = true;
    console.log('✅ TabNavigationManager inicializado');
  },

  // ============================================================
  // FUNÇÃO: Manipular duplo clique no Editor
  // ============================================================
  /**
   * handleEditorDoubleClick
   * ------------------------
   * [DESATIVADO] - Navegação agora é apenas via menu de contexto.
   */
  handleEditorDoubleClick: function (e) {
    // Função desativada - não usar
    // A navegação para o Operator é feita pelo menu de contexto
  },

  // ============================================================
  // FUNÇÃO: Ir para Operator na seleção atual (via menu contexto)
  // ============================================================
  /**
   * goToOperatorAtCurrentSelection
   * --------------------------------
   * Pega a seleção atual do editor e navega para o Operator
   * no ponto correspondente.
   */
  goToOperatorAtCurrentSelection: function (contextPoint) {
    let range = null;
    let editor = null;
    let selectedText = '';

    const pointRangeData = this.resolveEditorRangeFromPoint(contextPoint);
    if (pointRangeData) {
      range = pointRangeData.range;
      editor = pointRangeData.editor;

      const liveSelection = window.getSelection();
      if (liveSelection && liveSelection.rangeCount > 0 && !liveSelection.getRangeAt(0).collapsed) {
        const liveRange = liveSelection.getRangeAt(0);
        if (editor.contains(liveRange.commonAncestorContainer)) {
          selectedText = (liveSelection.toString() || '').trim();
        }
      }
    } else {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        console.log('🚨 Nenhuma seleção/cursor ativo no editor');
        return;
      }

      range = selection.getRangeAt(0);
      selectedText = (selection.toString() || '').trim();

      const node = range.startContainer;
      const parent = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      editor = parent?.closest?.('.text-editor-area');
      if (!editor) {
        console.log('🚨 Seleção não está em um editor');
        return;
      }
    }

    const node = range.startContainer;

    // Calcula o índice da palavra
    const wordIndex = this.calculateWordIndex(editor, range);

    if (wordIndex !== null) {
      const charOffset = this.calculateCharacterOffset(editor, range.startContainer, range.startOffset);
      let contextText = selectedText;

      if (!contextText && node && node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent || '';
        const safeOffset = Math.max(0, Math.min(range.startOffset || 0, raw.length));
        const left = raw.slice(0, safeOffset).match(/\S+$/)?.[0] || '';
        const right = raw.slice(safeOffset).match(/^\S+/)?.[0] || '';
        contextText = (left + right).trim();
      }

      this.pendingWordIndex = wordIndex;
      this.pendingNavigationContext = {
        text: contextText,
        charOffset: charOffset,
        timestamp: Date.now()
      };

      console.log(`📍 Palavra/cursor capturado: "${contextText || '[cursor]'}" (índice: ${wordIndex}, charOffset: ${charOffset})`);

      // O modo edição cobre o prompter: fecha-o para revelar o trecho de destino.
      window.dispatchEvent(new CustomEvent('operator-edit-panel:close'));

      this.switchToOperatorTab();
    }
  },

  resolveEditorRangeFromPoint: function (contextPoint) {
    if (!contextPoint || !Number.isFinite(contextPoint.x) || !Number.isFinite(contextPoint.y)) {
      return null;
    }

    const dpr = window.devicePixelRatio || 1;
    const attempts = [
      [contextPoint.x, contextPoint.y],
      [contextPoint.x * dpr, contextPoint.y * dpr],
      [contextPoint.x / dpr, contextPoint.y / dpr]
    ];

    for (const [x, y] of attempts) {
      let range = null;

      if (typeof document.caretRangeFromPoint === 'function') {
        range = document.caretRangeFromPoint(x, y);
      } else if (typeof document.caretPositionFromPoint === 'function') {
        const caretPos = document.caretPositionFromPoint(x, y);
        if (caretPos && caretPos.offsetNode) {
          range = document.createRange();
          range.setStart(caretPos.offsetNode, caretPos.offset || 0);
          range.collapse(true);
        }
      }

      if (!range || !range.startContainer) continue;

      const node = range.startContainer;
      const parent = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const editor = parent?.closest?.('.text-editor-area');

      if (editor && editor.contains(node)) {
        return { range, editor };
      }
    }

    return null;
  },

  // ============================================================
  // FUNÇÃO: Usar caret (cursor) atual do editor como destino
  // ============================================================
  /**
   * tryUseCaretAsPendingNavigation
   * -------------------------------
   * Se o usuário deixou o caret (barrinha piscando) num ponto do
   * editor e está mudando para a aba Operator SEM ter pendingWordIndex
   * (ou seja, sem ter usado o menu "Go to Operator"), calcula o índice
   * da palavra naquela posição e marca para navegação automática.
   */
  tryUseCaretAsPendingNavigation: function () {
    // Se já há navegação pendente (vinda do menu de contexto), respeita.
    if (this.pendingWordIndex !== null) {
      console.log('ℹ️ Navegação pendente já existe, ignorando caret');
      return;
    }
    if (!this.editorReferenceArmed || !this.lastCaretEditor || !this.lastCaretNode) {
      console.log('ℹ️ Nenhum caret rastreado no editor');
      return;
    }

    // Evita usar caret antigo (stale), que pode apontar para posição errada
    // após diversas trocas de aba/reflow.
    const caretAgeMs = Date.now() - (this.lastCaretTimestamp || 0);
    if (caretAgeMs > 2000) {
      console.log(`ℹ️ Caret ignorado por estar antigo (${caretAgeMs}ms)`);
      return;
    }

    // Confirma que o caret ainda está num elemento existente no DOM.
    if (!document.contains(this.lastCaretEditor) || !document.contains(this.lastCaretNode)) {
      console.log('⚠️ Caret armazenado não está mais no DOM');
      this.lastCaretEditor = null;
      this.lastCaretNode = null;
      return;
    }

    try {
      const fakeRange = document.createRange();
      const maxOffset = this.lastCaretNode.nodeType === Node.TEXT_NODE
        ? (this.lastCaretNode.textContent || '').length
        : this.lastCaretNode.childNodes.length;
      const safeOffset = Math.max(0, Math.min(this.lastCaretOffset || 0, maxOffset));

      fakeRange.setStart(this.lastCaretNode, safeOffset);
      fakeRange.collapse(true);

      const wordIndex = this.calculateWordIndex(this.lastCaretEditor, fakeRange);

      if (wordIndex !== null && wordIndex >= 0) {
        // Pega um texto de contexto perto do caret (até 30 chars) para
        // fallback em findWordByText caso o índice não bata.
        const contextText = (this.lastCaretNode.textContent || '')
          .substr(Math.max(0, this.lastCaretOffset - 15), 30)
          .trim()
          .split(/\s+/)[0] || '';

        this.pendingWordIndex = wordIndex;
        const charOffset = this.calculateCharacterOffset(this.lastCaretEditor, this.lastCaretNode, safeOffset);
        this.pendingNavigationContext = {
          text: contextText,
          charOffset: charOffset,
          timestamp: Date.now()
        };

        // Consome o caret uma única vez para evitar reuso de referência stale.
        this.lastCaretTimestamp = 0;
        this.editorReferenceArmed = false;

        console.log(`✅ Caret detectado no editor — navegando para palavra #${wordIndex} ("${contextText}")`);
        return;
      } else {
        console.warn('⚠️ calculateWordIndex retornou null ou index inválido');
      }
    } catch (err) {
      console.warn('⚠️ tryUseCaretAsPendingNavigation: erro ao processar caret', err);
      // Limpar dados inválidos
      this.lastCaretEditor = null;
      this.lastCaretNode = null;
    }
  },

  /**
   * captureEditorCaretAsPendingNavigation
   * -------------------------------------
   * Ao sair do modo edição: transforma o último caret do editor em navegação
   * pendente (índice de palavra + offset) para o prompter abrir nesse ponto.
   * Chamar ANTES de ocultar o painel. Retorna true se capturou.
   */
  captureEditorCaretAsPendingNavigation: function () {
    if (this.hasPendingNavigation()) return true;

    const editor = this.lastCaretEditor;
    const node = this.lastCaretNode;
    if (!editor || !node || !document.contains(editor) || !document.contains(node)) return false;

    try {
      const maxOffset = node.nodeType === Node.TEXT_NODE
        ? (node.textContent || '').length
        : node.childNodes.length;
      const safeOffset = Math.max(0, Math.min(this.lastCaretOffset || 0, maxOffset));
      const range = document.createRange();
      range.setStart(node, safeOffset);
      range.collapse(true);

      const wordIndex = this.calculateWordIndex(editor, range);
      if (wordIndex === null || wordIndex < 0) return false;

      const raw = node.nodeType === Node.TEXT_NODE ? (node.textContent || '') : '';
      const left = raw.slice(0, safeOffset).match(/\S+$/)?.[0] || '';
      const right = raw.slice(safeOffset).match(/^\S+/)?.[0] || '';

      this.pendingWordIndex = wordIndex;
      this.pendingNavigationContext = {
        text: (left + right).trim(),
        charOffset: this.calculateCharacterOffset(editor, node, safeOffset),
        timestamp: Date.now()
      };
      return true;
    } catch (err) {
      console.warn('⚠️ captureEditorCaretAsPendingNavigation falhou', err);
      return false;
    }
  },

  /** Aplica a navegação pendente (após o HTML do prompter estar sincronizado). */
  applyPendingNavigationNow: function () {
    this.scheduleTransitionFrame(() => {
      this.scheduleTransitionFrame(() => this.restoreOrNavigate());
    });
  },

  // ============================================================
  // FUNÇÃO: Usar seleção/caret ATUAL do editor como navegação
  // ============================================================
  /**
   * tryUseLiveSelectionAsPendingNavigation
   * --------------------------------------
   * Captura a seleção viva no momento da troca de aba (inclusive seleção
   * de palavra via duplo clique) para navegar ao ponto exato no Operator.
   */
  tryUseLiveSelectionAsPendingNavigation: function () {
    const force = arguments[0] === true;
    if (this.pendingWordIndex !== null || (!force && !this.editorReferenceArmed)) return;

    // Quando forçado (troca de aba), ignora seleção muito antiga para não
    // reaplicar um ponto stale como destino de navegação.
    if (force) {
      const selectionAgeMs = Date.now() - (this.lastCaretTimestamp || 0);
      if (selectionAgeMs > 2500) return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    try {
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      const parent = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const editor = parent && parent.closest ? parent.closest('.text-editor-area') : null;

      if (!editor || !editor.contains(node)) return;

      const wordIndex = this.calculateWordIndex(editor, range);
      if (wordIndex === null || wordIndex < 0) return;

      const selectedText = (selection.toString() || '').trim();
      const charOffset = this.calculateCharacterOffset(editor, range.startContainer, range.startOffset);

      this.pendingWordIndex = wordIndex;
      this.pendingNavigationContext = {
        text: selectedText,
        charOffset: charOffset,
        timestamp: Date.now()
      };

      console.log(`✅ Seleção viva capturada — palavra #${wordIndex} (charOffset: ${charOffset})`);
    } catch (error) {
      console.warn('⚠️ tryUseLiveSelectionAsPendingNavigation: erro ao capturar seleção', error);
    }
  },

  tryUsePointerPointAsPendingNavigation: function () {
    if (this.pendingWordIndex !== null || !this.lastEditorPointerPoint) return;

    const pointAgeMs = Date.now() - (this.lastEditorPointerPoint.timestamp || 0);
    if (pointAgeMs > 5000) return;

    const pointRangeData = this.resolveEditorRangeFromPoint(this.lastEditorPointerPoint);
    if (!pointRangeData) return;

    const range = pointRangeData.range;
    const editor = pointRangeData.editor;
    const node = range.startContainer;
    const wordIndex = this.calculateWordIndex(editor, range);
    if (wordIndex === null || wordIndex < 0) return;

    const charOffset = this.calculateCharacterOffset(editor, range.startContainer, range.startOffset);
    let contextText = '';

    if (node && node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent || '';
      const safeOffset = Math.max(0, Math.min(range.startOffset || 0, raw.length));
      const left = raw.slice(0, safeOffset).match(/\S+$/)?.[0] || '';
      const right = raw.slice(safeOffset).match(/^\S+/)?.[0] || '';
      contextText = (left + right).trim();
    }

    this.pendingWordIndex = wordIndex;
    this.pendingNavigationContext = {
      text: contextText,
      charOffset: charOffset,
      timestamp: Date.now()
    };

    console.log(`✅ Ponto do clique no editor capturado — palavra #${wordIndex} (charOffset: ${charOffset})`);
  },

  // ============================================================
  // FUNÇÃO: Calcular índice da palavra no texto
  // ============================================================
  /**
   * calculateWordIndex
   * -------------------
   * Percorre o texto do editor e conta as palavras até chegar
   * na posição do cursor/seleção.
   * 
   * @param {HTMLElement} editor - O elemento editor
   * @param {Range} range - O range da seleção
   * @returns {number|null} - Índice da palavra ou null se erro
   */
  calculateWordIndex: function (editor, range) {
    try {
      // Validação básica
      if (!editor || !range || !range.startContainer) {
        console.warn('calculateWordIndex: editor ou range inválido');
        return null;
      }

      const targetNode = range.startContainer;
      const targetOffset = range.startOffset;

      // Caminho principal: usa a mesma estratégia de tokenização por nós de texto
      // empregada em findWordByIndex, garantindo paridade Editor ↔ Operator.
      if (targetNode.nodeType === Node.TEXT_NODE) {
        const walker = document.createTreeWalker(
          editor,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );

        let wordIndex = 0;
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent || '';
          const words = text.match(/\S+/g) || [];

          if (node !== targetNode) {
            wordIndex += words.length;
            continue;
          }

          const safeOffset = Math.max(0, Math.min(targetOffset, text.length));
          let searchOffset = 0;

          for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const wordStart = text.indexOf(word, searchOffset);
            const wordEnd = wordStart + word.length;

            // Cursor antes ou dentro da palavra atual -> esse é o índice alvo
            if (safeOffset <= wordStart || (safeOffset > wordStart && safeOffset <= wordEnd)) {
              console.log(`📊 calculateWordIndex: índice calculado via tokenização = ${wordIndex}`);
              return wordIndex;
            }

            searchOffset = wordEnd;
            wordIndex++;
          }

          // Cursor após a última palavra do nó atual
          console.log(`📊 calculateWordIndex: índice calculado no fim do nó = ${wordIndex}`);
          return wordIndex;
        }
      }

      // Fallback para startContainer que não é nó de texto
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(editor);
      beforeRange.setEnd(targetNode, targetOffset);
      const textBeforeCursor = beforeRange.toString() || '';
      const wordsCount = textBeforeCursor.split(/\s+/).filter((w) => w.length > 0).length;
      console.log(`📊 calculateWordIndex: índice calculado via fallback = ${wordsCount}`);
      return wordsCount;
    } catch (error) {
      console.error('Erro ao calcular índice da palavra:', error);
      return null;
    }
  },

  // ============================================================
  // FUNÇÃO: Calcular offset de caractere absoluto no editor
  // ============================================================
  /**
   * calculateCharacterOffset
   * -------------------------
   * Retorna a quantidade de caracteres desde o início do editor
   * até a posição indicada (node+offset).
   */
  calculateCharacterOffset: function (editor, node, offset) {
    try {
      if (!editor || !node) return null;

      // Caminho principal: conta caracteres reais por nós de texto,
      // sem normalização de whitespace do Range.toString().
      if (node.nodeType === Node.TEXT_NODE) {
        const walker = document.createTreeWalker(
          editor,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );

        let totalChars = 0;
        let currentNode;
        while ((currentNode = walker.nextNode())) {
          const text = currentNode.textContent || '';
          if (currentNode === node) {
            const safeOffset = Math.max(0, Math.min(offset, text.length));
            return totalChars + safeOffset;
          }
          totalChars += text.length;
        }
      }

      // Fallback para nós não-texto
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(editor);
      beforeRange.setEnd(node, offset);
      const textBefore = beforeRange.toString() || '';
      return textBefore.length;
    } catch (error) {
      console.warn('calculateCharacterOffset: erro ao calcular offset', error);
      return null;
    }
  },

  // ============================================================
  // FUNÇÃO: Encontrar posição por offset de caractere no Operator
  // ============================================================
  /**
   * findWordByCharacterOffset
   * --------------------------
   * Mapeia um offset de caractere absoluto para um nó/offset no
   * container do Operator.
   */
  findWordByCharacterOffset: function (container, targetCharOffset) {
    try {
      if (!container || targetCharOffset === null || targetCharOffset === undefined) {
        return null;
      }

      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let acc = 0;
      let node;

      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const nextAcc = acc + text.length;

        if (targetCharOffset <= nextAcc) {
          const localOffset = Math.max(0, Math.min(text.length, targetCharOffset - acc));

          // Expande para os limites da palavra mais próxima
          const left = text.slice(0, localOffset);
          const right = text.slice(localOffset);

          const leftMatch = left.match(/\S+$/);
          const rightMatch = right.match(/^\S+/);

          let startOffset = localOffset;
          let endOffset = localOffset;
          if (leftMatch && rightMatch) {
            startOffset = localOffset - leftMatch[0].length;
            endOffset = localOffset + rightMatch[0].length;
          } else if (rightMatch) {
            startOffset = localOffset;
            endOffset = localOffset + rightMatch[0].length;
          } else if (leftMatch) {
            startOffset = localOffset - leftMatch[0].length;
            endOffset = localOffset;
          }

          const word = text.slice(startOffset, endOffset).trim();

          return {
            node,
            startOffset,
            endOffset,
            word
          };
        }

        acc = nextAcc;
      }

      return null;
    } catch (error) {
      console.warn('findWordByCharacterOffset: erro ao mapear offset', error);
      return null;
    }
  },

  // ============================================================
  // FUNÇÃO: Encontrar palavra por índice no Operator
  // ============================================================
  /**
   * findWordByIndex
   * ----------------
   * Encontra o nó de texto e offset correspondente ao índice
   * da palavra no container do Operator.
   * 
   * @param {HTMLElement} container - Container do prompter
   * @param {number} targetIndex - Índice da palavra a encontrar
   * @returns {Object|null} - {node, startOffset, endOffset, word} ou null
   */
  findWordByIndex: function (container, targetIndex) {
    try {
      if (!container || targetIndex < 0) {
        console.warn('findWordByIndex: container inválido ou índice negativo');
        return null;
      }

      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let currentWordIndex = 0;
      let node;

      while ((node = walker.nextNode())) {
        const text = node.textContent;
        const words = text.match(/\S+/g) || [];

        let offset = 0;
        for (let i = 0; i < words.length; i++) {
          if (currentWordIndex === targetIndex) {
            // Encontrou a palavra!
            const wordStart = text.indexOf(words[i], offset);
            const wordEnd = wordStart + words[i].length;

            console.log(`✅ findWordByIndex: Encontrou palavra #${targetIndex}: "${words[i]}" no nó de texto`);

            return {
              node: node,
              startOffset: wordStart,
              endOffset: wordEnd,
              word: words[i]
            };
          }

          offset = text.indexOf(words[i], offset) + words[i].length;
          currentWordIndex++;
        }
      }

      console.warn(`⚠️ findWordByIndex: Palavra #${targetIndex} não encontrada (total de palavras: ${currentWordIndex})`);
      return null;
    } catch (error) {
      console.error('Erro ao encontrar palavra por índice:', error);
      return null;
    }
  },

  // ============================================================
  // FUNÇÃO: Encontrar palavra por texto (fallback)
  // ============================================================
  /**
   * findWordByText
   * ----------------
   * Busca uma palavra específica no container, priorizando
   * ocorrências próximas ao índice esperado.
   * 
   * @param {HTMLElement} container - Container do prompter
   * @param {string} searchWord - Palavra a encontrar
   * @param {number} expectedIndex - Índice aproximado esperado
   * @returns {Object|null} - {node, startOffset, endOffset, word} ou null
   */
  findWordByText: function (container, searchWord, expectedIndex) {
    try {
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      const cleanSearch = searchWord.trim().toLowerCase();
      const matches = [];
      let currentWordIndex = 0;
      let node;

      while ((node = walker.nextNode())) {
        const text = node.textContent;
        const words = text.match(/\S+/g) || [];

        let offset = 0;
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const cleanWord = word.toLowerCase().replace(/[.,!?;:"'()]/g, '');

          if (cleanWord === cleanSearch || word.toLowerCase() === cleanSearch) {
            const wordStart = text.indexOf(word, offset);
            const wordEnd = wordStart + word.length;

            matches.push({
              node: node,
              startOffset: wordStart,
              endOffset: wordEnd,
              word: word,
              index: currentWordIndex,
              distance: Math.abs(currentWordIndex - expectedIndex)
            });
          }

          offset = text.indexOf(word, offset) + word.length;
          currentWordIndex++;
        }
      }

      // Retorna a ocorrência mais próxima do índice esperado
      if (matches.length > 0) {
        matches.sort((a, b) => a.distance - b.distance);
        console.log(`✅ Encontrada por texto: "${matches[0].word}" (índice ${matches[0].index}, esperado ${expectedIndex})`);
        return matches[0];
      }

      return null;
    } catch (error) {
      console.error('Erro ao encontrar palavra por texto:', error);
      return null;
    }
  },

  // ============================================================
  // FUNÇÃO: Mudar para aba Operator
  // ============================================================
  /**
   * switchToOperatorTab
   * --------------------
   * Ativa programaticamente a aba Operator.
   */
  switchToOperatorTab: function () {
    const operatorPane = document.getElementById('operator-tab-pane');
    const operatorTab = document.getElementById('operator-tab');
    const isOperatorAlreadyActive = !!(
      operatorPane &&
      (operatorPane.classList.contains('active') || operatorPane.classList.contains('show'))
    );

    if (isOperatorAlreadyActive) {
      this.cancelPendingTabWork();
      this.scheduleTransitionFrame(() => {
        this.restoreOrNavigate();
      });
      return;
    }

    if (operatorTab) {
      // Usa a API do Bootstrap para ativar a aba
      const bsTab = new bootstrap.Tab(operatorTab);
      bsTab.show();
    }
  },

  // ============================================================
  // FUNÇÃO: Limpar navegação pendente
  // ============================================================
  /**
   * clearPendingNavigation
   * ----------------------
   * Reseta o estado de navegação pendente.
   * Usado quando sai da aba Operator para evitar navegação indesejada.
   */
  clearPendingNavigation: function () {
    this.pendingWordIndex = null;
    this.pendingNavigationContext = null;
    console.log('🧹 Navegação pendente limpa');
  },

  clearEditorReference: function () {
    this.lastCaretEditor = null;
    this.lastCaretNode = null;
    this.lastCaretOffset = 0;
    this.lastCaretTimestamp = 0;
    this.editorReferenceArmed = false;
    this.lastEditorPointerPoint = null;

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      selection.removeAllRanges();
    }
  },

  applySingleSourceScrollPosition: function (position) {
    const normalizedPosition = Number.isFinite(position) ? Math.max(0, Number(position)) : 0;

    this.operatorSavedScrollPosition = normalizedPosition;
    if (typeof ScrollEngine !== 'undefined') {
      ScrollEngine.decimalScroll = normalizedPosition;
    }

    const container = document.querySelector('.prompter-in-control');
    if (container) {
      container.scrollTop = normalizedPosition;
    }

    const textControl = document.getElementById('prompterText-control');
    if (textControl) {
      textControl.style.transform = 'none';
    }

    return normalizedPosition;
  },

  hasPendingNavigation: function () {
    if (this.pendingWordIndex === null || this.pendingNavigationContext === null) return false;
    const age = Date.now() - (this.pendingNavigationContext.timestamp || 0);
    if (age > this.navigationStaleMs) {
      console.warn(`⚠️ Navegação pendente descartada por expirar (${age}ms > ${this.navigationStaleMs}ms)`);
      this.clearPendingNavigation();
      return false;
    }
    return true;
  },

  // ============================================================
  // FUNÇÃO: Salvar posição do scroll do Operator
  // ============================================================
  /**
   * saveOperatorScrollPosition
   * ---------------------------
   * Salva a posição atual do scroll do Operator.
   * Usa ScrollEngine.decimalScroll se disponível para precisão.
   */
  saveOperatorScrollPosition: function () {
    const container = document.querySelector('.prompter-in-control');
    const textControl = document.getElementById('prompterText-control');
    const livePosition = (typeof ScrollEngine !== 'undefined' && Number.isFinite(ScrollEngine.decimalScroll))
      ? ScrollEngine.decimalScroll
      : (container ? container.scrollTop : 0);

    if (!container && !textControl) return;

    this.applySingleSourceScrollPosition(livePosition);
    console.log('💾 Posição do Operator salva:', this.operatorSavedScrollPosition);
  },

  // ============================================================
  // FUNÇÃO: Pausar scroll se estiver rodando
  // ============================================================
  /**
   * pauseScrollIfRunning
   * ---------------------
   * Pausa o scroll automático ao sair do Operator.
   */
  pauseScrollIfRunning: function () {
    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.isRunning) {
      ScrollEngine.pause();
      ipcRenderer.send('control-prompter', 'pause');
      console.log('⏸️ Mudou de aba: Scroll pausado');
    }
  },

  /**
   * stopScrollIfRunning
   * ---------------------
   * Para completamente o scroll ao sair do Operator (sem resetar posição).
   * Sempre salva a posição atual, independente de estar rodando ou não.
   */
  stopScrollIfRunning: function () {
    const container = document.querySelector('.prompter-in-control');
    const textControl = document.getElementById('prompterText-control');

    let currentPosition = 0;

    if (typeof ScrollEngine !== 'undefined' && Number.isFinite(ScrollEngine.decimalScroll)) {
      currentPosition = ScrollEngine.decimalScroll;
      console.log('📍 Posição preservada via ScrollEngine.decimalScroll:', currentPosition);
    } else if (container) {
      currentPosition = container.scrollTop;
      console.log('📍 Posição preservada via container.scrollTop:', currentPosition);
    }

    this.applySingleSourceScrollPosition(currentPosition);

    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.isRunning) {
      if (typeof ScrollEngine.stopReadProgressHeartbeat === 'function') {
        ScrollEngine.stopReadProgressHeartbeat();
      }

      ScrollEngine.isRunning = false;
      ScrollEngine.setSpeed(0);

      if (container && textControl) {
        container.style.overflowY = 'auto';
        textControl.style.transform = 'none';
        container.scrollTop = currentPosition;
        ScrollEngine.decimalScroll = currentPosition;
      }

      const playBtn = document.getElementById('play-btn');
      const pauseBtn = document.getElementById('pause-btn');
      if (playBtn) playBtn.classList.remove('d-none');
      if (pauseBtn) pauseBtn.classList.add('d-none');

      ipcRenderer.send('control-prompter', 'pause');
    }

    if (typeof cancelPendingFullscreenAnchorRestore === 'function') {
      cancelPendingFullscreenAnchorRestore();
    }

    console.log('⏹️ Mudou de aba: Posição salva =', this.operatorSavedScrollPosition);
  },

  // ============================================================
  // FUNÇÃO: Capturar palavra visível no Operator
  // ============================================================
  /**
   * captureOperatorVisibleWord
   * ---------------------------
   * Detecta qual palavra está visível no centro/topo do Operator
   * quando o usuário sair da aba, para poder sincronizar com o Editor.
   */
  captureOperatorVisibleWord: function () {
    console.log('🎬 captureOperatorVisibleWord: INICIANDO captura...');

    const container = document.querySelector('.prompter-in-control');
    const textControl = document.getElementById('prompterText-control');

    if (!container) {
      console.log('❌ captureOperatorVisibleWord: container (.prompter-in-control) não encontrado');
      return;
    }

    if (!textControl) {
      console.log('❌ captureOperatorVisibleWord: textControl (#prompterText-control) não encontrado');
      return;
    }

    console.log('✅ Elementos encontrados:', {
      container: container.className,
      textControl: textControl.id
    });

    // Obtém a posição de scroll atual
    let currentPosition = 0;

    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.decimalScroll > 0) {
      currentPosition = ScrollEngine.decimalScroll;
      console.log(`📊 Posição via ScrollEngine.decimalScroll: ${currentPosition}px`);
    } else {
      currentPosition = container.scrollTop;
      console.log(`📊 Posição via container.scrollTop: ${currentPosition}px`);
    }

    // Se está no início, não precisa sincronizar
    if (currentPosition < 10) {
      this.operatorVisibleWordIndex = null;
      console.log('ℹ️ Operator no início (< 10px) - nenhuma sincronização necessária');
      return;
    }

    // Calcula a posição vertical do centro da viewport
    const containerRect = container.getBoundingClientRect();
    const targetY = containerRect.top + (container.clientHeight * 0.3); // 30% do topo

    console.log(`🎯 Buscando palavra na posição Y: ${targetY}px (30% do topo da viewport)`);
    console.log(`📐 Container rect:`, {
      top: containerRect.top,
      height: container.clientHeight
    });

    // Encontra qual palavra está nessa posição
    const wordIndex = this.findWordAtPosition(textControl, targetY, containerRect);

    if (wordIndex !== null && wordIndex >= 0) {
      this.operatorVisibleWordIndex = wordIndex;
      console.log(`✅✅ CAPTURADA palavra visível no Operator: índice ${wordIndex}`);
    } else {
      this.operatorVisibleWordIndex = null;
      console.log('❌ Não foi possível capturar palavra visível no Operator');
    }
  },

  // ============================================================
  // FUNÇÃO: Encontrar palavra em uma posição Y específica
  // ============================================================
  /**
   * findWordAtPosition
   * -------------------
   * Encontra qual palavra está em uma posição Y específica da tela.
   * 
   * @param {HTMLElement} container - Container com o texto
   * @param {number} targetY - Posição Y na tela
   * @param {DOMRect} containerRect - Retângulo do container
   * @returns {number|null} - Índice da palavra ou null
   */
  findWordAtPosition: function (container, targetY, containerRect) {
    try {
      console.log('🔍 findWordAtPosition: Buscando palavra...');

      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let wordIndex = 0;
      let node;
      let closestWord = null;
      let minDistance = Infinity;
      let totalWordsChecked = 0;
      let visibleWordsCount = 0;

      while ((node = walker.nextNode())) {
        const text = node.textContent;
        const words = text.match(/\S+/g) || [];

        let offset = 0;
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const wordStart = text.indexOf(word, offset);
          totalWordsChecked++;

          try {
            // Cria um range para obter a posição da palavra
            const range = document.createRange();
            range.setStart(node, wordStart);
            range.setEnd(node, wordStart + word.length);

            const rect = range.getBoundingClientRect();

            // Verifica se a palavra está visível
            if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
              visibleWordsCount++;
              const distance = Math.abs(rect.top - targetY);

              if (distance < minDistance) {
                minDistance = distance;
                closestWord = wordIndex;

                console.log(`🎯 Nova palavra mais próxima: #${wordIndex} "${word}" (distância: ${distance.toFixed(0)}px, top: ${rect.top.toFixed(0)}px)`);
              }
            }
          } catch (e) {
            // Ignora erros de range
          }

          offset = wordStart + word.length;
          wordIndex++;
        }
      }

      console.log(`📊 Estatísticas da busca:`, {
        totalPalavras: totalWordsChecked,
        palavrasVisiveis: visibleWordsCount,
        palavraMaisProxima: closestWord,
        distanciaMinima: minDistance.toFixed(0) + 'px'
      });

      return closestWord;
    } catch (error) {
      console.error('❌ Erro ao encontrar palavra na posição:', error);
      return null;
    }
  },

  // ============================================================
  // FUNÇÃO: Pré-aplicar posição antes da aba aparecer
  // ============================================================
  /**
   * preApplyScrollPosition
   * -----------------------
   * Aplica a posição de scroll ANTES da aba ficar visível
   * para evitar "salto" visual.
   */
  preApplyScrollPosition: function () {
    const container = document.querySelector('.prompter-in-control');
    const textControl = document.getElementById('prompterText-control');

    if (!container || !textControl) return;

    if (this.pendingWordIndex !== null) return;

    this.lastAppliedScrollTransitionId = this.tabTransitionId;
    this.applySingleSourceScrollPosition(this.operatorSavedScrollPosition);
    container.style.overflowY = 'auto';
    textControl.style.transform = 'none';

    console.log('🔄 preApplyScrollPosition:', this.operatorSavedScrollPosition);
  },

  // ============================================================
  // FUNÇÃO: Forçar reflow do texto
  // ============================================================
  /**
   * forceReflow
   * ------------
   * Força o navegador a redesenhar o texto para evitar
   * problemas de renderização após troca de aba.
   */
  forceReflow: function () {
    const textControl = document.getElementById('prompterText-control');
    const operatorPane = document.getElementById('operator-tab-pane');
    const container = document.querySelector('.prompter-in-control');

    // Força reflow completo do painel Operator
    if (operatorPane) {
      // Técnica 1: Ler propriedades que forçam recálculo
      void operatorPane.offsetHeight;
      void operatorPane.offsetWidth;
      void operatorPane.getBoundingClientRect();

      // Técnica 2: Toggle de classe para forçar recálculo CSS
      operatorPane.classList.add('force-reflow');
      void operatorPane.offsetHeight;
      operatorPane.classList.remove('force-reflow');
    }

    // Força reflow do container do prompter
    if (container) {
      void container.offsetHeight;
      void container.scrollHeight;
    }

    // Força reflow do textControl
    if (textControl) {
      // Salva o transform atual
      const currentTransform = textControl.style.transform;

      // Força recálculo sem alterar visualmente
      textControl.style.opacity = '0.99';
      void textControl.offsetHeight;
      textControl.style.opacity = '1';

      // Restaura transform se necessário
      if (currentTransform) {
        textControl.style.transform = currentTransform;
      }
    }

    // Dispara evento resize para forçar recálculo de layouts
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  },

  // ============================================================
  // FUNÇÃO: Encontrar palavra por índice no Editor
  // ============================================================
  /**
   * findWordByIndexInEditor
   * ------------------------
   * Similar ao findWordByIndex, mas otimizado para o Editor
   * que pode ter formatação HTML complexa.
   * 
   * @param {HTMLElement} editor - Elemento do editor
   * @param {number} targetIndex - Índice da palavra
   * @returns {Object|null} - {node, startOffset, endOffset, word} ou null
   */
  findWordByIndexInEditor: function (editor, targetIndex) {
    try {
      if (!editor || targetIndex < 0) {
        return null;
      }

      const walker = document.createTreeWalker(
        editor,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let currentWordIndex = 0;
      let node;

      while ((node = walker.nextNode())) {
        const text = node.textContent;
        const words = text.match(/\S+/g) || [];

        let offset = 0;
        for (let i = 0; i < words.length; i++) {
          if (currentWordIndex === targetIndex) {
            // Encontrou a palavra!
            const wordStart = text.indexOf(words[i], offset);
            const wordEnd = wordStart + words[i].length;

            return {
              node: node,
              startOffset: wordStart,
              endOffset: wordEnd,
              word: words[i]
            };
          }

          offset = text.indexOf(words[i], offset) + words[i].length;
          currentWordIndex++;
        }
      }

      return null;
    } catch (error) {
      console.error('Erro ao encontrar palavra no editor:', error);
      return null;
    }
  },

  // ============================================================
  // FUNÇÃO: Restaurar posição OU navegar para palavra
  // ============================================================
  /**
   * restoreOrNavigate
   * ------------------
   * Se há uma palavra pendente para navegação (do caret ou menu),
   * navega para ela. Caso contrário, restaura a posição salva.
   */
  restoreOrNavigate: function () {
    const container = document.querySelector('.prompter-in-control');
    const textControl = document.getElementById('prompterText-control');

    if (!container || !textControl) {
      console.warn('restoreOrNavigate: container ou textControl não encontrado');
      return;
    }

    if (!this.hasPendingNavigation()) {
      this.pendingWordIndex = null;
      this.pendingNavigationContext = null;
    }

    if (this.pendingWordIndex === null && this.lastAppliedScrollTransitionId === this.tabTransitionId) {
      console.log('ℹ️ Restauro da posição já aplicado neste ciclo de transição; ignorando duplicata.');
      return;
    }

    // =========================================
    // NAVEGAÇÃO PARA PALAVRA ESPECÍFICA
    // =========================================
    if (this.pendingWordIndex !== null) {
      const targetIndex = this.pendingWordIndex;
      const context = this.pendingNavigationContext;

      // Limpa para não repetir
      this.pendingWordIndex = null;
      this.pendingNavigationContext = null;
      this.clearEditorReference();

      console.log(`🎯 Tentando navegar para palavra #${targetIndex}...`);

      // Tenta primeiro por índice da palavra.
      // O índice é mais estável entre Edit/Operator quando há diferenças de
      // renderização de HTML (quebras de linha, spans, estilos).
      let wordLocation = null;
      wordLocation = this.findWordByIndex(textControl, targetIndex);

      // Se não encontrou pelo índice, tenta buscar pelo texto
      if (!wordLocation && context && context.text) {
        console.log(`⚠️ Palavra #${targetIndex} não encontrada por índice, tentando por texto ("${context.text}")...`);
        wordLocation = this.findWordByText(textControl, context.text, targetIndex);
      }

      // Último fallback: offset de caractere absoluto
      if (!wordLocation && context && context.charOffset !== null && context.charOffset !== undefined) {
        wordLocation = this.findWordByCharacterOffset(textControl, context.charOffset);
        if (wordLocation && wordLocation.word) {
          console.log(`✅ Encontrada por charOffset (fallback): "${wordLocation.word}" (offset ${context.charOffset})`);
        }
      }

      if (wordLocation) {
        // Cria um range para obter a posição Y exata
        const range = document.createRange();
        range.setStart(wordLocation.node, wordLocation.startOffset);
        range.setEnd(wordLocation.node, wordLocation.endOffset);

        const rect = range.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Calcula scroll para centralizar a palavra na tela
        const currentScroll = typeof ScrollEngine !== 'undefined'
          ? ScrollEngine.decimalScroll
          : container.scrollTop;

        // Alinha para a região de leitura (30% do topo), mais próxima do cue marker.
        const targetScroll = currentScroll + (rect.top - containerRect.top) - (container.clientHeight * 0.3);
        const finalScroll = Math.max(0, targetScroll);

        console.log(`📍 Navegando para: "${wordLocation.word}" | Scroll: ${currentScroll.toFixed(0)}px → ${finalScroll.toFixed(0)}px`);

        // Aplica o scroll
        if (typeof ScrollEngine !== 'undefined') {
          ScrollEngine.decimalScroll = finalScroll;
          textControl.style.transform = `translate3d(0, -${finalScroll}px, 0)`;
        }
        container.scrollTop = finalScroll;

        // --- CORREÇÃO: Libera o scroll manual imediatamente após o pulo ---
        // 1. Garante que o ScrollEngine está parado
        if (typeof ScrollEngine !== 'undefined') {
          ScrollEngine.isRunning = false;
        }
        // 2. Libera o overflow do container
        container.style.overflowY = 'auto';
        // 3. Remove qualquer transform para garantir scroll nativo
        textControl.style.transform = 'none';
        // 4. Sincroniza scrollTop e decimalScroll
        if (typeof ScrollEngine !== 'undefined') {
          ScrollEngine.decimalScroll = container.scrollTop;
          if (typeof ScrollEngine.syncFromDOM === 'function') {
            ScrollEngine.syncFromDOM();
          }
        }

        // Destaca temporariamente a palavra encontrada
        // Usa requestAnimationFrame duplo para garantir que o scroll já foi aplicado
        // e o navegador fez o repaint - assim as coordenadas estarão corretas
        const wordInfo = wordLocation;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Recria o range após o scroll ser aplicado e repaint completo
            try {
              const newRange = document.createRange();
              newRange.setStart(wordInfo.node, wordInfo.startOffset);
              newRange.setEnd(wordInfo.node, wordInfo.endOffset);
              this.highlightWord(newRange, container);
            } catch (e) {
              console.warn('Erro ao criar range para destaque:', e);
            }
          });
        });

        console.log(`✅ Navegado com sucesso para palavra #${targetIndex}: "${wordLocation.word}"`);

        // Salva a nova posição na fonte única de verdade
        this.applySingleSourceScrollPosition(finalScroll);
        return;
      } else {
        console.warn(`❌ Palavra #${targetIndex} não encontrada no Operator - usando posição salva`);
      }
    }

    // =========================================
    // RESTAURAÇÃO DE POSIÇÃO SALVA
    // =========================================
    if (this.operatorSavedScrollPosition >= 0) {
      console.log(`♻️ Restaurando posição salva: ${this.operatorSavedScrollPosition}px`);

      this.lastAppliedScrollTransitionId = this.tabTransitionId;
      this.applySingleSourceScrollPosition(this.operatorSavedScrollPosition);
      container.style.overflowY = 'auto';
      textControl.style.transform = 'none';

      if (typeof ScrollEngine !== 'undefined') {
        ScrollEngine.isRunning = false;
      }

      console.log(`✅ Posição restaurada com sucesso`);
    } else {
      console.log(`ℹ️ Sem posição salva - permanecendo no início`);
    }
  },

  // ============================================================
  // FUNÇÃO: Destacar palavra temporariamente
  // ============================================================
  /**
   * highlightWord
   * --------------
   * Cria um destaque visual temporário na palavra navegada.
   * Usa uma abordagem com span wrapper para garantir posição correta.
   * 
   * @param {Range} range - Range contendo a palavra
   * @param {HTMLElement} container - Container do prompter (opcional)
   */
  highlightWord: function (range, container) {
    try {
      // Remove destaque anterior se existir
      const oldHighlight = document.querySelector('.nav-word-highlight');
      if (oldHighlight) {
        // Restaura o texto original se foi wrappado
        const parent = oldHighlight.parentNode;
        if (parent) {
          const text = oldHighlight.textContent;
          const textNode = document.createTextNode(text);
          parent.replaceChild(textNode, oldHighlight);
          parent.normalize(); // Junta nós de texto adjacentes
        }
      }

      // Obtém o container se não foi passado
      if (!container) {
        container = document.querySelector('.prompter-in-control');
      }
      if (!container) return;

      const textControl = document.getElementById('prompterText-control');
      if (!textControl) return;

      // Extrai o conteúdo do range (a palavra)
      const wordText = range.toString();
      if (!wordText) return;

      // Cria um span de destaque que envolve a palavra
      const highlightSpan = document.createElement('span');
      highlightSpan.className = 'nav-word-highlight';
      highlightSpan.textContent = wordText;
      highlightSpan.style.cssText = `
                background: rgba(255, 215, 0, 0.5);
                border: 2px solid gold;
                border-radius: 4px;
                padding: 2px 4px;
                margin: -2px -4px;
                box-shadow: 0 0 15px rgba(255, 215, 0, 0.8);
                animation: nav-highlight-inline 2s ease-out forwards;
            `;

      // Substitui o conteúdo do range pelo span
      range.deleteContents();
      range.insertNode(highlightSpan);

      // Remove o destaque após 2 segundos, restaurando o texto original
      setTimeout(() => {
        try {
          const currentHighlight = document.querySelector('.nav-word-highlight');
          if (currentHighlight && currentHighlight.parentNode) {
            const text = currentHighlight.textContent;
            const textNode = document.createTextNode(text);
            currentHighlight.parentNode.replaceChild(textNode, currentHighlight);
            currentHighlight.parentNode.normalize();
          }
        } catch (e) {
          console.warn('Erro ao remover destaque:', e);
        }
      }, 2000);

      console.log('✨ Palavra destacada:', wordText);

    } catch (error) {
      console.error('Erro ao destacar palavra:', error);
    }
  },

  // ============================================================
  // FUNÇÃO: Navegar para posição específica (API pública)
  // ============================================================
  /**
   * navigateToPosition
   * -------------------
   * Navega para uma posição de scroll específica no Operator.
   * 
   * @param {number} scrollPosition - Posição em pixels
   */
  navigateToPosition: function (scrollPosition) {
    this.pendingWordIndex = null;
    this.applySingleSourceScrollPosition(scrollPosition);
    this.switchToOperatorTab();
  },

  // ============================================================
  // FUNÇÃO: Navegar para índice de palavra (API pública)
  // ============================================================
  /**
   * navigateToWordIndex
   * --------------------
   * Navega para uma palavra específica pelo índice.
   * 
   * @param {number} wordIndex - Índice da palavra (base 0)
   */
  navigateToWordIndex: function (wordIndex) {
    this.pendingWordIndex = wordIndex;
    this.pendingNavigationContext = {
      text: '',
      timestamp: Date.now()
    };
    this.switchToOperatorTab();
  },

  // ============================================================
  // FUNÇÃO: Resetar estado
  // ============================================================
  /**
   * reset
   * ------
   * Reseta o estado do módulo (usado ao criar novo documento).
   */
  reset: function () {
    this.operatorSavedScrollPosition = 0;
    this.pendingWordIndex = null;
    this.pendingNavigationContext = null;
    this.operatorVisibleWordIndex = null;
    console.log('🔄 TabNavigationManager resetado');
  }
};

// Exporta o módulo
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TabNavigationManager;
}

// Também disponibiliza globalmente
window.TabNavigationManager = TabNavigationManager;
