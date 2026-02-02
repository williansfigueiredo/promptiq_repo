// ============================================================
// tab-navigation.js
// ============================================================
// DESCRIÇÃO: Módulo de navegação entre abas com memória de posição
// FUNÇÃO: 
//   1. Persiste posição do scroll do Operator ao trocar de aba
//   2. Permite navegação contextual: duplo clique no Editor vai 
//      para a posição correspondente no Operator
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
    
    // ============================================================
    // FUNÇÃO: Inicializar o módulo
    // ============================================================
    /**
     * init
     * -----
     * Configura todos os event listeners para navegação entre abas.
     * Deve ser chamado após o DOM estar carregado.
     */
    init: function() {
        if (this.isInitialized) return;
        
        const tabEditTrigger = document.getElementById('edit-tab');
        const tabOperatorTrigger = document.getElementById('operator-tab');
        const tabHomeTrigger = document.getElementById('home-tab');
        
        // =========================================
        // DUPLO CLIQUE NO EDITOR -> NAVEGAR NO OPERATOR
        // =========================================
        // Usa event delegation no container para pegar editores dinâmicos
        const documentContentContainer = document.getElementById('document-content-container');
        if (documentContentContainer) {
            documentContentContainer.addEventListener('dblclick', (e) => {
                this.handleEditorDoubleClick(e);
            });
        }
        
        // =========================================
        // EVENTOS DE TROCA DE ABA
        // =========================================
        
        // Ao sair do Operator -> Edit (salva posição)
        if (tabEditTrigger) {
            tabEditTrigger.addEventListener('show.bs.tab', () => {
                this.saveOperatorScrollPosition();
            });
            
            tabEditTrigger.addEventListener('shown.bs.tab', () => {
                // Pausa o scroll ao sair do Operator
                this.pauseScrollIfRunning();
            });
        }
        
        // Ao sair do Operator -> Home (salva posição)
        if (tabHomeTrigger) {
            tabHomeTrigger.addEventListener('show.bs.tab', () => {
                this.saveOperatorScrollPosition();
            });
        }
        
        // Ao voltar para o Operator
        if (tabOperatorTrigger) {
            // Pré-aplica posição ANTES da aba aparecer (evita salto visual)
            tabOperatorTrigger.addEventListener('show.bs.tab', () => {
                this.preApplyScrollPosition();
            });
            
            tabOperatorTrigger.addEventListener('shown.bs.tab', () => {
                // Força reflow para evitar texto cortado
                this.forceReflow();
                
                // Restaura posição OU navega para palavra clicada
                this.restoreOrNavigate();
                
                // Devolve foco para o teclado funcionar
                document.querySelector('.prompter-in-control')?.focus();
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
     * Captura o duplo clique em uma palavra do editor,
     * calcula o índice da palavra e muda para aba Operator.
     * 
     * @param {MouseEvent} e - Evento do duplo clique
     */
    handleEditorDoubleClick: function(e) {
        // Verifica se o clique foi dentro de um editor de texto
        const editor = e.target.closest('.text-editor-area');
        if (!editor) return;
        
        // Aguarda a seleção automática do navegador
        setTimeout(() => {
            const selection = window.getSelection();
            if (!selection || selection.toString().trim().length === 0) return;
            
            const selectedText = selection.toString().trim();
            const range = selection.getRangeAt(0);
            
            // Calcula o índice da palavra clicada
            const wordIndex = this.calculateWordIndex(editor, range);
            
            if (wordIndex !== null) {
                this.pendingWordIndex = wordIndex;
                this.pendingNavigationContext = {
                    text: selectedText,
                    timestamp: Date.now()
                };
                
                console.log(`📍 Palavra capturada: "${selectedText}" (índice: ${wordIndex})`);
                
                // Muda automaticamente para a aba Operator
                this.switchToOperatorTab();
            }
        }, 10);
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
    calculateWordIndex: function(editor, range) {
        try {
            const walker = document.createTreeWalker(
                editor,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            let wordIndex = 0;
            let node;
            let foundNode = range.startContainer;
            let foundOffset = range.startOffset;
            
            // Percorre todos os nós de texto
            while ((node = walker.nextNode())) {
                const text = node.textContent;
                
                if (node === foundNode) {
                    // Conta palavras até o offset da seleção
                    const textBeforeCursor = text.substring(0, foundOffset);
                    const wordsBeforeCursor = textBeforeCursor.split(/\s+/).filter(w => w.length > 0);
                    wordIndex += wordsBeforeCursor.length;
                    
                    // Se o cursor está no meio de uma palavra, não adiciona
                    // Se está no início de uma palavra, o índice já está correto
                    return wordIndex;
                }
                
                // Conta todas as palavras deste nó
                const words = text.split(/\s+/).filter(w => w.length > 0);
                wordIndex += words.length;
            }
            
            return null;
        } catch (error) {
            console.error('Erro ao calcular índice da palavra:', error);
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
     * @returns {Object|null} - {node, startOffset, endOffset} ou null
     */
    findWordByIndex: function(container, targetIndex) {
        try {
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
            console.error('Erro ao encontrar palavra por índice:', error);
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
    switchToOperatorTab: function() {
        const operatorTab = document.getElementById('operator-tab');
        if (operatorTab) {
            // Usa a API do Bootstrap para ativar a aba
            const bsTab = new bootstrap.Tab(operatorTab);
            bsTab.show();
        }
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
    saveOperatorScrollPosition: function() {
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
    pauseScrollIfRunning: function() {
        if (typeof ScrollEngine !== 'undefined' && ScrollEngine.isRunning) {
            ScrollEngine.pause();
            ipcRenderer.send('control-prompter', 'pause');
            console.log('⏸️ Mudou de aba: Scroll pausado');
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
    preApplyScrollPosition: function() {
        const container = document.querySelector('.prompter-in-control');
        const textControl = document.getElementById('prompterText-control');
        
        if (!container || !textControl) return;
        
        // Se há navegação pendente, não pré-aplica (será calculado depois)
        if (this.pendingWordIndex !== null) return;
        
        // Aplica a posição salva
        if (this.operatorSavedScrollPosition > 0) {
            if (typeof ScrollEngine !== 'undefined') {
                ScrollEngine.decimalScroll = this.operatorSavedScrollPosition;
                textControl.style.transform = `translate3d(0, -${this.operatorSavedScrollPosition}px, 0)`;
            }
            container.scrollTop = this.operatorSavedScrollPosition;
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
    forceReflow: function() {
        const textControl = document.getElementById('prompterText-control');
        if (textControl) {
            textControl.style.display = 'none';
            textControl.offsetHeight; // Força reflow
            textControl.style.display = 'block';
        }
    },
    
    // ============================================================
    // FUNÇÃO: Restaurar posição OU navegar para palavra
    // ============================================================
    /**
     * restoreOrNavigate
     * ------------------
     * Se há uma palavra pendente para navegação (duplo clique),
     * navega para ela. Caso contrário, restaura a posição salva.
     */
    restoreOrNavigate: function() {
        const container = document.querySelector('.prompter-in-control');
        const textControl = document.getElementById('prompterText-control');
        
        if (!container || !textControl) return;
        
        // =========================================
        // NAVEGAÇÃO PARA PALAVRA ESPECÍFICA
        // =========================================
        if (this.pendingWordIndex !== null) {
            const targetIndex = this.pendingWordIndex;
            const context = this.pendingNavigationContext;
            // Limpa para não repetir
            this.pendingWordIndex = null;
            this.pendingNavigationContext = null;
            // Encontra a palavra no Operator pelo índice
            const wordLocation = this.findWordByIndex(textControl, targetIndex);
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
                // Centraliza: pega a posição relativa e subtrai metade da altura do container
                const targetScroll = currentScroll + (rect.top - containerRect.top) - (container.clientHeight / 2);
                const finalScroll = Math.max(0, targetScroll);
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
                console.log(`🎯 Navegado para palavra #${targetIndex}: "${wordLocation.word}" (scroll: ${finalScroll.toFixed(0)}px)`);
                // Salva a nova posição
                this.operatorSavedScrollPosition = finalScroll;
                return;
            } else {
                console.warn(`⚠️ Palavra #${targetIndex} não encontrada no Operator`);
            }
        }
        
        // =========================================
        // RESTAURAÇÃO DE POSIÇÃO SALVA
        // =========================================
        if (this.operatorSavedScrollPosition > 0) {
            if (typeof ScrollEngine !== 'undefined') {
                ScrollEngine.decimalScroll = this.operatorSavedScrollPosition;
                textControl.style.transform = `translate3d(0, -${this.operatorSavedScrollPosition}px, 0)`;
            }
            container.scrollTop = this.operatorSavedScrollPosition;
            
            console.log('♻️ Posição do Operator restaurada:', this.operatorSavedScrollPosition);
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
    highlightWord: function(range, container) {
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
    navigateToPosition: function(scrollPosition) {
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
    navigateToWordIndex: function(wordIndex) {
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
    reset: function() {
        this.operatorSavedScrollPosition = 0;
        this.pendingWordIndex = null;
        this.pendingNavigationContext = null;
        console.log('🔄 TabNavigationManager resetado');
    }
};

// Exporta o módulo
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TabNavigationManager;
}

// Também disponibiliza globalmente
window.TabNavigationManager = TabNavigationManager;
