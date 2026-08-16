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

    const tabEditTrigger = document.getElementById('edit-tab');
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
    ipcRenderer.on('go-to-operator-at-selection', () => {
      this.goToOperatorAtCurrentSelection();
    });

    // =========================================
    // RASTREIO DO CARET (CURSOR PISCANDO) NO EDITOR
    // =========================================
    // Rastreia o caret no editor de forma mais robusta
    // Ativa em múltiplos eventos para garantir captura
    const updateCaretPosition = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      try {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const parent = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        const editor = parent && parent.closest ? parent.closest('.text-editor-area') : null;

        if (editor && editor.contains(node)) {
          this.lastCaretEditor = editor;
          this.lastCaretNode = node;
          this.lastCaretOffset = range.startOffset;
          this.lastCaretTimestamp = Date.now();
        }
      } catch (err) {
        // Ignorar erros de seleção inválida
      }
    };

    // Rastreia em múltiplos eventos para máxima cobertura
    document.addEventListener('selectionchange', updateCaretPosition);
    document.addEventListener('click', updateCaretPosition);
    document.addEventListener('keyup', updateCaretPosition);
    document.addEventListener('mouseup', updateCaretPosition);

    // =========================================
    // EVENTOS DE TROCA DE ABA
    // =========================================

    // Ao sair do Operator -> Edit (salva posição e para scroll)
    if (tabEditTrigger) {
      tabEditTrigger.addEventListener('show.bs.tab', () => {
        // Para o scroll e salva posição ANTES de sair da aba Operator
        this.clearPendingNavigation();
        this.stopScrollIfRunning();

        // 🆕 Captura qual palavra está visível no Operator para sincronizar com o Editor
        this.captureOperatorVisibleWord();
      });

      tabEditTrigger.addEventListener('shown.bs.tab', () => {
        this.currentTabTriggerId = 'edit-tab';

        // Força reflow completo da aba Edit
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.forceEditTabReflow();

            // 🆕 Sincroniza a posição do Editor com o Operator
            setTimeout(() => {
              this.syncOperatorPositionToEditor();
            }, 100);

            // Dispara resize para recalcular layouts
            window.dispatchEvent(new Event('resize'));

            // Foca no editor de texto
            setTimeout(() => {
              const activeEditor = document.querySelector('.text-editor-area');
              if (activeEditor) {
                activeEditor.focus({ preventScroll: true });
              }
            }, 50);
          });
        });
      });
    }

    // Ao sair do Operator -> Home (salva posição e para scroll)
    if (tabHomeTrigger) {
      tabHomeTrigger.addEventListener('show.bs.tab', () => {
        // Para o scroll e salva posição ANTES de sair da aba Operator
        this.clearPendingNavigation();
        this.stopScrollIfRunning();

        // 🆕 Captura qual palavra está visível no Operator para possível sincronização futura
        this.captureOperatorVisibleWord();
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
        // Limpa palavra capturada do Operator (não queremos sincronizar ao voltar)
        this.operatorVisibleWordIndex = null;

        // ===================================================================
        // CORREÇÃO: Tentar usar caret do editor se não há navegação pendente
        // ===================================================================
        // Se o usuário saiu da aba edit deixando o cursor em uma posição,
        // detectar isso e navegar automaticamente
        if (this.pendingWordIndex === null && this.currentTabTriggerId === 'edit-tab') {
          // 1) Prioriza a seleção viva atual (inclui duplo clique em palavra)
          this.tryUseLiveSelectionAsPendingNavigation();
          // 2) Fallback para caret rastreado
          if (this.pendingWordIndex === null) {
            this.tryUseCaretAsPendingNavigation();
          }
        }

        // Restaura a posição salva ao voltar — sem saltar para o caret do Edit.
        // Navegação por palavra só via menu "Go to Operator" ou navigateToWordIndex().
        this.preApplyScrollPosition();
      });

      tabOperatorTrigger.addEventListener('shown.bs.tab', () => {
        this.currentTabTriggerId = 'operator-tab';
        // Usa requestAnimationFrame duplo para garantir renderização completa
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Força reflow para evitar texto cortado
            this.forceReflow();

            // Se há navegação pendente, aguarda um pouco mais para o conteúdo estar pronto
            if (this.pendingWordIndex !== null) {
              setTimeout(() => {
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
            setTimeout(() => {
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
  goToOperatorAtCurrentSelection: function () {
    const selection = window.getSelection();
    if (!selection || selection.toString().trim().length === 0) {
      console.log('🚨 Nenhuma palavra selecionada');
      return;
    }

    const selectedText = selection.toString().trim();
    const range = selection.getRangeAt(0);

    // Encontra o editor mais próximo
    const editor = range.startContainer.parentElement?.closest('.text-editor-area');
    if (!editor) {
      console.log('🚨 Seleção não está em um editor');
      return;
    }

    // Calcula o índice da palavra
    const wordIndex = this.calculateWordIndex(editor, range);

    if (wordIndex !== null) {
      const charOffset = this.calculateCharacterOffset(editor, range.startContainer, range.startOffset);

      this.pendingWordIndex = wordIndex;
      this.pendingNavigationContext = {
        text: selectedText,
        charOffset: charOffset,
        timestamp: Date.now()
      };

      console.log(`📍 Palavra capturada: "${selectedText}" (índice: ${wordIndex}, charOffset: ${charOffset})`);

      // Muda para a aba Operator
      this.switchToOperatorTab();
    }
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
    if (!this.lastCaretEditor || !this.lastCaretNode) {
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
    if (this.pendingWordIndex !== null) return;

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

      // Estratégia robusta: usa Range do início do editor até o caret.
      // Isso evita erros com nós de formatação e não conta palavra parcial.
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(editor);
      beforeRange.setEnd(range.startContainer, range.startOffset);

      const textBeforeCursor = beforeRange.toString() || '';
      let wordsCount = textBeforeCursor.split(/\s+/).filter(w => w.length > 0).length;

      // Se o caret está no meio/fim de uma palavra (sem whitespace no final),
      // desconta 1 para apontar para a palavra atual e não para a próxima.
      if (range.collapsed && textBeforeCursor.length > 0 && !/\s$/.test(textBeforeCursor)) {
        wordsCount = Math.max(0, wordsCount - 1);
      }

      console.log(`📊 calculateWordIndex: palavras completas antes do caret = ${wordsCount}`);
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
    const operatorTab = document.getElementById('operator-tab');
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
    if (!container) return;

    // Prioriza a posição do ScrollEngine (mais precisa)
    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.decimalScroll !== undefined) {
      this.operatorSavedScrollPosition = ScrollEngine.decimalScroll;
    } else {
      this.operatorSavedScrollPosition = container.scrollTop;
    }

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

    // ============================================
    // DETECTA A POSIÇÃO CORRETA
    // ============================================
    // Quando scroll automático está ativo: posição está em decimalScroll (transform)
    // Quando scroll manual: posição está em container.scrollTop

    let currentPosition = 0;

    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.isRunning) {
      // Scroll automático ativo - usa decimalScroll
      currentPosition = ScrollEngine.decimalScroll || 0;
      console.log('📍 Modo automático - posição via decimalScroll:', currentPosition);
    } else if (typeof ScrollEngine !== 'undefined' && ScrollEngine.decimalScroll > 0) {
      // Scroll foi pausado mas tem posição salva - usa decimalScroll
      currentPosition = ScrollEngine.decimalScroll;
      console.log('📍 Scroll pausado - posição via decimalScroll:', currentPosition);
    } else if (container) {
      // Scroll manual - usa scrollTop
      currentPosition = container.scrollTop;
      console.log('📍 Modo manual - posição via scrollTop:', currentPosition);
    }

    // Sempre persiste a posição atual (inclui 0 no início do roteiro)
    this.operatorSavedScrollPosition = currentPosition;
    if (typeof ScrollEngine !== 'undefined') {
      ScrollEngine.decimalScroll = currentPosition;
    }

    // ============================================
    // PARA O SCROLL SE ESTIVER RODANDO
    // ============================================
    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.isRunning) {
      // Para o heartbeat de leitura (evita cálculo com aba oculta)
      if (typeof ScrollEngine.stopReadProgressHeartbeat === 'function') {
        ScrollEngine.stopReadProgressHeartbeat();
      }

      // Para o scroll MAS preserva a posição
      ScrollEngine.isRunning = false;
      ScrollEngine.setSpeed(0);

      // Restaura o scroll nativo com a posição atual
      if (container && textControl) {
        container.style.overflowY = 'auto';
        textControl.style.transform = 'none';
        container.scrollTop = currentPosition;
        ScrollEngine.decimalScroll = currentPosition;
      }

      // Atualiza botões
      const playBtn = document.getElementById('play-btn');
      const pauseBtn = document.getElementById('pause-btn');
      if (playBtn) playBtn.classList.remove('d-none');
      if (pauseBtn) pauseBtn.classList.add('d-none');

      ipcRenderer.send('control-prompter', 'pause');
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

    // Se há navegação pendente, não pré-aplica (será calculado depois)
    if (this.pendingWordIndex !== null) return;

    // Aplica a posição salva usando scroll nativo (não transform)
    if (this.operatorSavedScrollPosition > 0) {
      container.style.overflowY = 'auto';
      textControl.style.transform = 'none';
      container.scrollTop = this.operatorSavedScrollPosition;

      if (typeof ScrollEngine !== 'undefined') {
        ScrollEngine.decimalScroll = this.operatorSavedScrollPosition;
        if (typeof ScrollEngine.syncFromDOM === 'function') {
          ScrollEngine.syncFromDOM();
        }
      }

      console.log('🔄 preApplyScrollPosition:', this.operatorSavedScrollPosition);
    }
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
  // FUNÇÃO: Forçar reflow da aba Edit
  // ============================================================
  /**
   * forceEditTabReflow
   * -------------------
   * Força o navegador a redesenhar a aba Edit para evitar
   * problemas de renderização após troca de aba.
   */
  forceEditTabReflow: function () {
    const editPane = document.getElementById('edit-tab-pane');
    const formatBar = document.querySelector('.format-bar, .toolbar-format');
    const editorContainer = document.getElementById('document-content-container');
    const textEditor = document.querySelector('.text-editor-area');

    // Força reflow do painel Edit
    if (editPane) {
      void editPane.offsetHeight;
      void editPane.offsetWidth;
      void editPane.getBoundingClientRect();

      editPane.classList.add('force-reflow');
      void editPane.offsetHeight;
      editPane.classList.remove('force-reflow');
    }

    // Força reflow da barra de formatação
    if (formatBar) {
      void formatBar.offsetHeight;
      formatBar.style.visibility = 'visible';
      formatBar.style.opacity = '1';
    }

    // Força reflow do container do editor
    if (editorContainer) {
      void editorContainer.offsetHeight;
      void editorContainer.scrollHeight;
    }

    // Força reflow do editor de texto
    if (textEditor) {
      textEditor.style.opacity = '0.99';
      void textEditor.offsetHeight;
      textEditor.style.opacity = '1';
    }

    console.log('✅ forceEditTabReflow executado');
  },

  // ============================================================
  // FUNÇÃO: Sincronizar posição do Operator para o Editor
  // ============================================================
  /**
   * syncOperatorPositionToEditor
   * -----------------------------
   * Quando voltar do Operator para o Edit, sincroniza a posição
   * do texto no Editor para mostrar a palavra que estava visível
   * no Operator.
   */
  syncOperatorPositionToEditor: function () {
    console.log('🔄 syncOperatorPositionToEditor: INICIANDO sincronização...');

    // Se não há palavra capturada, não faz nada
    if (this.operatorVisibleWordIndex === null) {
      console.log('ℹ️ Nenhuma palavra do Operator para sincronizar com o Editor (operatorVisibleWordIndex é null)');
      return;
    }

    console.log(`📍 Palavra capturada do Operator: índice ${this.operatorVisibleWordIndex}`);

    const editor = document.querySelector('.editor-container.active .text-editor-area');
    if (!editor) {
      console.log('❌ syncOperatorPositionToEditor: editor ativo não encontrado');
      console.log('Tentando buscar qualquer .text-editor-area...');
      const anyEditor = document.querySelector('.text-editor-area');
      if (anyEditor) {
        console.log('⚠️ Encontrado .text-editor-area mas sem .editor-container.active');
      } else {
        console.log('❌ Nenhum .text-editor-area encontrado no DOM');
      }
      return;
    }

    console.log('✅ Editor ativo encontrado:', editor.className);

    const targetIndex = this.operatorVisibleWordIndex;
    console.log(`🎯 Buscando palavra #${targetIndex} no Editor...`);

    // Encontra a palavra no editor
    const wordLocation = this.findWordByIndexInEditor(editor, targetIndex);

    if (wordLocation) {
      console.log(`✅ Palavra encontrada no Editor: "${wordLocation.word}" (node: ${wordLocation.node.nodeType})`);

      try {
        // Cria um range para obter a posição Y da palavra
        const range = document.createRange();
        range.setStart(wordLocation.node, wordLocation.startOffset);
        range.setEnd(wordLocation.node, wordLocation.endOffset);

        // Obtém a posição da palavra no editor
        const rect = range.getBoundingClientRect();
        const editorRect = editor.getBoundingClientRect();

        console.log('📐 Posições:', {
          wordRect: { top: rect.top, bottom: rect.bottom },
          editorRect: { top: editorRect.top, height: editor.clientHeight },
          editorScrollTop: editor.scrollTop
        });

        // Calcula o scroll necessário para posicionar a palavra próxima ao topo (30%)
        const targetScroll = editor.scrollTop + (rect.top - editorRect.top) - (editor.clientHeight * 0.3);
        const finalScroll = Math.max(0, targetScroll);

        console.log(`📍 Scroll calculado: atual=${editor.scrollTop}px, alvo=${finalScroll.toFixed(0)}px`);
        console.log(`🎬 Aplicando scroll para: ${finalScroll.toFixed(0)}px (palavra: "${wordLocation.word}")`);

        // Aplica o scroll suavemente (o próprio editor é scrollável)
        editor.scrollTo({
          top: finalScroll,
          behavior: 'smooth'
        });

        // Verifica após um momento se o scroll foi aplicado
        setTimeout(() => {
          console.log(`✅ Scroll aplicado. Posição final: ${editor.scrollTop}px`);
        }, 300);

        console.log(`✅✅ Editor sincronizado com sucesso para palavra #${targetIndex}`);
      } catch (error) {
        console.error('❌ Erro ao sincronizar posição:', error);
      }
    } else {
      console.warn(`❌ Palavra #${targetIndex} não encontrada no Editor`);
    }

    // Limpa a palavra capturada após usar
    console.log('🧹 Limpando operatorVisibleWordIndex...');
    this.operatorVisibleWordIndex = null;
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

    // =========================================
    // NAVEGAÇÃO PARA PALAVRA ESPECÍFICA
    // =========================================
    if (this.pendingWordIndex !== null) {
      const targetIndex = this.pendingWordIndex;
      const context = this.pendingNavigationContext;

      // Limpa para não repetir
      this.pendingWordIndex = null;
      this.pendingNavigationContext = null;

      console.log(`🎯 Tentando navegar para palavra #${targetIndex}...`);

      // Tenta primeiro por offset absoluto de caractere (mais preciso)
      let wordLocation = null;
      if (context && context.charOffset !== null && context.charOffset !== undefined) {
        wordLocation = this.findWordByCharacterOffset(textControl, context.charOffset);
        if (wordLocation && wordLocation.word) {
          console.log(`✅ Encontrada por charOffset: "${wordLocation.word}" (offset ${context.charOffset})`);
        }
      }

      // Tenta encontrar a palavra no Operator pelo índice
      if (!wordLocation) {
        wordLocation = this.findWordByIndex(textControl, targetIndex);
      }

      // Se não encontrou pelo índice, tenta buscar pelo texto
      if (!wordLocation && context && context.text) {
        console.log(`⚠️ Palavra #${targetIndex} não encontrada por índice, tentando por texto ("${context.text}")...`);
        wordLocation = this.findWordByText(textControl, context.text, targetIndex);
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

        // Salva a nova posição
        this.operatorSavedScrollPosition = finalScroll;
        return;
      } else {
        console.warn(`❌ Palavra #${targetIndex} não encontrada no Operator - usando posição salva`);
      }
    }

    // =========================================
    // RESTAURAÇÃO DE POSIÇÃO SALVA
    // =========================================
    if (this.operatorSavedScrollPosition > 0) {
      console.log(`♻️ Restaurando posição salva: ${this.operatorSavedScrollPosition}px`);

      // Garante que está em modo scroll manual (não transform)
      container.style.overflowY = 'auto';
      textControl.style.transform = 'none';

      // Aplica a posição
      container.scrollTop = this.operatorSavedScrollPosition;

      // Sincroniza o ScrollEngine
      if (typeof ScrollEngine !== 'undefined') {
        ScrollEngine.decimalScroll = this.operatorSavedScrollPosition;
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
    this.operatorSavedScrollPosition = scrollPosition;
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
