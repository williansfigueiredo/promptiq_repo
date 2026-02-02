// ============================================================
// find-replace-module.js
// ============================================================
// DESCRIÇÃO: Módulo de busca e substituição de texto
// FUNÇÃO: Implementa funcionalidade de Find & Replace similar
//         a editores de texto profissionais, com destaque
//         de matches, navegação e substituição em lote.
// ============================================================

/**
 * FindReplaceModule
 * ------------------
 * Módulo que gerencia busca e substituição de texto no editor.
 * Inclui highlight de matches, navegação entre resultados e
 * substituição individual ou em massa.
 */
const FindReplaceModule = (function() {
    
    // ============================================================
    // ESTADO INTERNO
    // ============================================================
    let searchState = {
        isReplaceMode: false,     // Se está em modo Find ou Find+Replace
        currentMatchIndex: -1,    // Índice do match atual
        matches: [],              // Array de elementos <span> destacados
    };
    
    // ============================================================
    // REFERÊNCIAS DOM (serão inicializadas pelo init)
    // ============================================================
    let findReplaceModal = null;
    let findReplaceBootstrapModal = null;
    let modalFindInput = null;
    let modalReplaceInput = null;
    let modalReplaceGroup = null;
    let modalReplaceBtn = null;
    let modalReplaceAllBtn = null;
    let modalFindNextBtn = null;
    let modalFindPrevBtn = null;
    let modalFindCountSpan = null;
    let modalTitle = null;
    let modalReplaceActions = null;
    
    // ============================================================
    // CALLBACKS EXTERNOS
    // ============================================================
    let getActiveTextEditorArea = null;
    let markDocumentAsUnsaved = null;
    let activeDocumentId = null;
    let syncContentToPrompter = null;
    let scheduleAutoSave = null;

    // ============================================================
    // INICIALIZAÇÃO DO MÓDULO
    // ============================================================
    /**
     * init
     * -----
     * Inicializa o módulo com referências DOM e callbacks.
     */
    function init(options) {
        findReplaceModal = options.findReplaceModal;
        findReplaceBootstrapModal = options.findReplaceBootstrapModal;
        modalFindInput = options.modalFindInput;
        modalReplaceInput = options.modalReplaceInput;
        modalReplaceGroup = options.modalReplaceGroup;
        modalReplaceBtn = options.modalReplaceBtn;
        modalReplaceAllBtn = options.modalReplaceAllBtn;
        modalFindNextBtn = options.modalFindNextBtn;
        modalFindPrevBtn = options.modalFindPrevBtn;
        modalFindCountSpan = options.modalFindCountSpan;
        modalTitle = options.modalTitle;
        modalReplaceActions = options.modalReplaceActions;
        
        getActiveTextEditorArea = options.getActiveTextEditorArea;
        markDocumentAsUnsaved = options.markDocumentAsUnsaved;
        syncContentToPrompter = options.syncContentToPrompter;
        scheduleAutoSave = options.scheduleAutoSave;
        
        // Configura listeners
        setupEventListeners();
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
    // FUNÇÃO: Limpar Highlights de Busca
    // ============================================================
    /**
     * clearSearchHighlights
     * ----------------------
     * Remove todos os destaques de busca do editor.
     * Restaura o texto original dos spans destacados.
     */
    function clearSearchHighlights() {
        const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
        if (!editor) return;
        
        let nodeToRestore = null;
        const activeSpan = searchState.matches[searchState.currentMatchIndex];
        
        // ========================================
        // CONVERTE SPANS DE VOLTA PARA TEXTO
        // ========================================
        const highlights = editor.querySelectorAll(".find-match");
        highlights.forEach((span) => {
            const parent = span.parentNode;
            if (parent) {
                const textNode = document.createTextNode(span.textContent);
                parent.replaceChild(textNode, span);
                if (span === activeSpan) nodeToRestore = textNode;
            }
        });
        
        // Limpa estado
        searchState.matches = [];
        searchState.currentMatchIndex = -1;
        
        // Restaura cursor na posição do último match
        if (nodeToRestore) {
            const range = document.createRange();
            range.selectNodeContents(nodeToRestore);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            if (nodeToRestore.parentElement) {
                nodeToRestore.parentElement.scrollIntoView({
                    behavior: "auto",
                    block: "nearest",
                });
            }
        }
    }

    // ============================================================
    // FUNÇÃO: Obter Conteúdo Limpo (Sem Highlights)
    // ============================================================
    /**
     * getCleanContent
     * ----------------
     * Retorna o HTML do editor sem os spans de highlight.
     * Usado para salvar o arquivo sem marcações de busca.
     */
    function getCleanContent(editor) {
        if (!editor) return "";
        
        // Clona o editor para não modificar o original
        const clone = editor.cloneNode(true);
        
        // Remove spans de highlight
        const highlights = clone.querySelectorAll(".find-match");
        highlights.forEach((span) => {
            const parent = span.parentNode;
            parent.replaceChild(document.createTextNode(span.textContent), span);
        });
        
        return clone.innerHTML;
    }

    // ============================================================
    // FUNÇÃO: Destacar Matches
    // ============================================================
    /**
     * highlightMatches
     * -----------------
     * Busca o termo no editor e destaca todos os matches.
     * Usa regex com suporte a Unicode para boundary de palavras.
     * 
     * @param {string} term - Termo de busca
     */
    function highlightMatches(term) {
        clearSearchHighlights();
        
        if (!term) {
            if (modalFindCountSpan) modalFindCountSpan.textContent = "0 of 0";
            return;
        }
        
        const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
        if (!editor) return;
        
        // Escapa caracteres especiais de regex
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        
        // Regex com boundary de palavra (suporte Unicode)
        const regex = new RegExp(`(?<!\\p{L})${escapedTerm}(?!\\p{L})`, "giu");

        // ========================================
        // COLETA TODOS OS NÓS DE TEXTO
        // ========================================
        const textNodes = [];
        const walker = document.createTreeWalker(
            editor,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        // ========================================
        // PROCESSA DE TRÁS PARA FRENTE
        // ========================================
        // (Evita problemas com índices ao modificar o DOM)
        let matchCount = 0;
        for (let i = textNodes.length - 1; i >= 0; i--) {
            const textNode = textNodes[i];
            const text = textNode.nodeValue;
            let match;
            const matchesInNode = [];
            
            while ((match = regex.exec(text)) !== null) {
                matchesInNode.push({
                    index: match.index,
                    length: match[0].length,
                    text: match[0],
                });
            }
            
            if (matchesInNode.length > 0) {
                const parent = textNode.parentNode;
                
                // Processa matches de trás para frente
                for (let j = matchesInNode.length - 1; j >= 0; j--) {
                    const m = matchesInNode[j];
                    const matchNode = textNode.splitText(m.index);
                    matchNode.splitText(m.length);
                    
                    // Cria span de highlight
                    const span = document.createElement("span");
                    span.className = "find-match";
                    span.textContent = matchNode.textContent;
                    parent.replaceChild(span, matchNode);
                    matchCount++;
                }
            }
        }
        
        // Atualiza estado e UI
        searchState.matches = Array.from(editor.querySelectorAll(".find-match"));
        if (modalFindCountSpan) {
            modalFindCountSpan.textContent = matchCount > 0 ? `Found: ${matchCount}` : "0 of 0";
        }
    }

    // ============================================================
    // FUNÇÃO: Navegar para Match
    // ============================================================
    /**
     * navigateToMatch
     * ----------------
     * Move para o próximo ou anterior match.
     * 
     * @param {string} direction - 'next' ou 'prev'
     */
    function navigateToMatch(direction) {
        if (searchState.matches.length === 0) return;

        // Remove destaque do match atual
        if (searchState.currentMatchIndex >= 0 && searchState.matches[searchState.currentMatchIndex]) {
            searchState.matches[searchState.currentMatchIndex].classList.remove("active");
        }

        // Calcula novo índice
        if (direction === "next") {
            searchState.currentMatchIndex++;
            if (searchState.currentMatchIndex >= searchState.matches.length) {
                searchState.currentMatchIndex = 0; // Loop para o início
            }
        } else {
            searchState.currentMatchIndex--;
            if (searchState.currentMatchIndex < 0) {
                searchState.currentMatchIndex = searchState.matches.length - 1; // Loop para o fim
            }
        }

        // Destaca e scrolla para o novo match
        const currentSpan = searchState.matches[searchState.currentMatchIndex];
        if (currentSpan) {
            currentSpan.classList.add("active");
            currentSpan.scrollIntoView({ behavior: "smooth", block: "center" });
            
            if (modalFindCountSpan) {
                modalFindCountSpan.textContent = `${searchState.currentMatchIndex + 1} of ${searchState.matches.length}`;
            }
        }
    }

    // ============================================================
    // FUNÇÃO: Substituir Atual
    // ============================================================
    /**
     * replaceCurrent
     * ---------------
     * Substitui o match atualmente selecionado.
     * Se nenhum selecionado, seleciona o primeiro.
     */
    function replaceCurrent() {
        // Se não há matches, faz nova busca
        if (searchState.matches.length === 0) {
            highlightMatches(modalFindInput.value);
            if (searchState.matches.length > 0) {
                navigateToMatch("next");
            }
            return;
        }

        if (searchState.currentMatchIndex === -1) {
            searchState.currentMatchIndex = 0;
        }

        const currentSpan = searchState.matches[searchState.currentMatchIndex];
        if (!currentSpan) return;

        // ========================================
        // SUBSTITUI O TEXTO
        // ========================================
        const replaceText = modalReplaceInput.value || "";
        const textNode = document.createTextNode(replaceText);
        currentSpan.parentNode.replaceChild(textNode, currentSpan);

        // Marca documento como modificado
        if (markDocumentAsUnsaved && activeDocumentId) {
            markDocumentAsUnsaved(activeDocumentId);
        }
        if (syncContentToPrompter) syncContentToPrompter();
        if (scheduleAutoSave) scheduleAutoSave();

        // Refaz a busca e navega para o próximo
        let nextIndex = searchState.currentMatchIndex;
        highlightMatches(modalFindInput.value);

        if (searchState.matches.length > 0) {
            if (nextIndex >= searchState.matches.length) nextIndex = 0;
            searchState.currentMatchIndex = nextIndex;

            const nextSpan = searchState.matches[searchState.currentMatchIndex];
            if (nextSpan) {
                nextSpan.classList.add("active");
                nextSpan.scrollIntoView({ behavior: "smooth", block: "center" });
                if (modalFindCountSpan) {
                    modalFindCountSpan.textContent = `${searchState.currentMatchIndex + 1} of ${searchState.matches.length}`;
                }
            }
        } else {
            searchState.currentMatchIndex = -1;
        }
    }

    // ============================================================
    // FUNÇÃO: Substituir Todos
    // ============================================================
    /**
     * replaceAll
     * -----------
     * Substitui todos os matches de uma vez.
     */
    function replaceAll() {
        const replaceText = modalReplaceInput.value || "";
        
        const highlights = document.querySelectorAll(".find-match");
        highlights.forEach((span) => {
            const textNode = document.createTextNode(replaceText);
            span.parentNode.replaceChild(textNode, span);
        });
        
        if (markDocumentAsUnsaved && activeDocumentId) {
            markDocumentAsUnsaved(activeDocumentId);
        }
        if (syncContentToPrompter) syncContentToPrompter();
        if (scheduleAutoSave) scheduleAutoSave();
        
        // Refaz busca (deve retornar 0 matches agora)
        highlightMatches(modalFindInput.value);
    }

    // ============================================================
    // FUNÇÃO: Mostrar Modal de Busca
    // ============================================================
    /**
     * showFindModal
     * --------------
     * Abre o modal de Find ou Find+Replace.
     * 
     * @param {boolean} replace - Se true, abre em modo Replace
     */
    function showFindModal(replace = false) {
        const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
        if (!editor) return;
        
        searchState.isReplaceMode = replace;
        
        // Configura título e visibilidade dos campos
        modalTitle.textContent = replace ? "Find & Replace" : "Find";
        
        if (replace) {
            modalReplaceGroup.classList.remove("d-none");
            modalReplaceActions.classList.remove("d-none");
        } else {
            modalReplaceGroup.classList.add("d-none");
            modalReplaceActions.classList.add("d-none");
        }
        
        // Limpa estado anterior
        clearSearchHighlights();
        modalFindInput.value = "";
        if (modalFindCountSpan) modalFindCountSpan.textContent = "";
        
        // Abre o modal
        findReplaceBootstrapModal.show();
        setTimeout(() => modalFindInput?.focus(), 100);
    }

    // ============================================================
    // CONFIGURAÇÃO DE EVENT LISTENERS
    // ============================================================
    function setupEventListeners() {
        // Limpa highlights ao fechar modal
        if (findReplaceModal) {
            findReplaceModal.addEventListener("hidden.bs.modal", () => {
                clearSearchHighlights();
                const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
                if (editor) editor.focus();
            });
        }

        // Busca enquanto digita
        if (modalFindInput) {
            modalFindInput.addEventListener("input", (e) => {
                if (e.target.value.length > 0) {
                    highlightMatches(e.target.value);
                } else {
                    clearSearchHighlights();
                    if (modalFindCountSpan) modalFindCountSpan.textContent = "";
                }
            });

            // Enter = próximo match, Shift+Enter = anterior
            modalFindInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    if (e.shiftKey) {
                        navigateToMatch("prev");
                    } else {
                        navigateToMatch("next");
                    }
                }
            });
        }

        // Botões de navegação
        if (modalFindNextBtn) {
            modalFindNextBtn.addEventListener("click", () => navigateToMatch("next"));
        }
        if (modalFindPrevBtn) {
            modalFindPrevBtn.addEventListener("click", () => navigateToMatch("prev"));
        }
        
        // Botões de substituição
        if (modalReplaceBtn) {
            modalReplaceBtn.addEventListener("click", replaceCurrent);
        }
        if (modalReplaceAllBtn) {
            modalReplaceAllBtn.addEventListener("click", replaceAll);
        }
    }

    // ============================================================
    // API PÚBLICA DO MÓDULO
    // ============================================================
    return {
        init,
        setActiveDocumentId,
        clearSearchHighlights,
        getCleanContent,
        highlightMatches,
        navigateToMatch,
        replaceCurrent,
        replaceAll,
        showFindModal,
        getSearchState: () => searchState
    };
    
})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FindReplaceModule;
}
