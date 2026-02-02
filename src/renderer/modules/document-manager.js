// ============================================================
// document-manager.js
// ============================================================
// DESCRIÇÃO: Gerenciador de documentos/abas do editor
// FUNÇÃO: Controla criação, ativação, fechamento e salvamento
//         de documentos. Gerencia múltiplas abas de edição
//         simultâneas e sincroniza com o teleprompter.
// ============================================================

const { ipcRenderer } = require('electron');

/**
 * DocumentManager
 * ----------------
 * Módulo que gerencia o ciclo de vida dos documentos abertos no editor.
 * Exporta funções e estado para serem usados pelo app.js principal.
 */
const DocumentManager = (function() {
    
    // ============================================================
    // ESTADO INTERNO DO MÓDULO
    // ============================================================
    
    let documents = [];           // Array de documentos abertos
    let activeDocumentId = null;  // ID do documento ativo no momento
    let nextDocumentId = 1;       // Contador para IDs únicos
    let isAutoSaveEnabled = false; // Flag de auto-salvamento
    let autoSaveTimeoutId = null; // Timer do auto-save
    
    // ============================================================
    // REFERÊNCIAS DOM (serão inicializadas pelo init)
    // ============================================================
    let documentTabsBar = null;
    let documentContentContainer = null;
    
    // ============================================================
    // CALLBACKS EXTERNOS (funções injetadas do app.js)
    // ============================================================
    let syncContentToPrompter = null;
    let applySettingsToVisuals = null;
    let syncInterfaceWithPreferences = null;
    let updateFormatMenuState = null;
    let updateEditMenuState = null;
    let applySpellCheckSettings = null;
    let getCleanContent = null;
    let cleanOldFormatting = null;
    let bootstrap = null;
    let globalPrefs = {};
    let currentFontSizePT = 12;

    // ============================================================
    // INICIALIZAÇÃO DO MÓDULO
    // ============================================================
    /**
     * init
     * -----
     * Inicializa o módulo com referências DOM e callbacks.
     * Deve ser chamado uma vez quando o DOM estiver pronto.
     */
    function init(options) {
        documentTabsBar = options.documentTabsBar;
        documentContentContainer = options.documentContentContainer;
        syncContentToPrompter = options.syncContentToPrompter;
        applySettingsToVisuals = options.applySettingsToVisuals;
        syncInterfaceWithPreferences = options.syncInterfaceWithPreferences;
        updateFormatMenuState = options.updateFormatMenuState;
        updateEditMenuState = options.updateEditMenuState;
        applySpellCheckSettings = options.applySpellCheckSettings;
        getCleanContent = options.getCleanContent;
        cleanOldFormatting = options.cleanOldFormatting;
        bootstrap = options.bootstrap;
        globalPrefs = options.globalPrefs || {};
        currentFontSizePT = options.currentFontSizePT || 12;
        
        // Configura listener de clique nas abas
        if (documentTabsBar) {
            documentTabsBar.addEventListener('click', handleTabClick);
        }
    }

    // ============================================================
    // FUNÇÃO: Criar Novo Documento
    // ============================================================
    /**
     * createNewDocument
     * ------------------
     * Cria um novo documento/aba no editor.
     * 
     * @param {string} content - Conteúdo inicial do documento (HTML)
     * @param {string} name - Nome do arquivo (ou null para "Untitled X")
     * @param {string} path - Caminho do arquivo no disco (ou null)
     * @returns {Object} - O objeto do documento criado
     */
    function createNewDocument(content = "", name = null, path = null) {
        console.log("📝 Criando novo documento:", { name, path });

        // ========================================
        // GERA NOME ÚNICO SE NÃO FORNECIDO
        // ========================================
        let finalName = name;
        if (!finalName) {
            let num = 1;
            while (documents.some((d) => d.name === `Untitled ${num}.txt`)) num++;
            finalName = `Untitled ${num}.txt`;
        }

        const newId = nextDocumentId++;

        // ========================================
        // CRIA OBJETO DO DOCUMENTO
        // ========================================
        const newDoc = {
            id: newId,
            name: finalName,
            path: path,
            saved: !!path,              // Se tem path, considera salvo
            isSpellCheckActive: true,   // Corretor ligado por padrão
            detectedLanguage: "pt-BR",  // Idioma padrão
            content: content,
        };
        documents.push(newDoc);

        // ========================================
        // CRIA ABA NA BARRA DE ABAS
        // ========================================
        const newTab = document.createElement("div");
        newTab.classList.add("document-tab", "d-inline-flex");
        newTab.dataset.target = newId;
        newTab.innerHTML = `<span>${finalName}</span> <i class="bi bi-x-lg close-tab" data-id="${newId}"></i>`;
        documentTabsBar.appendChild(newTab);

        // ========================================
        // CRIA CONTAINER DO EDITOR
        // ========================================
        const editorContainer = document.createElement("div");
        editorContainer.id = `doc-${newId}`;
        editorContainer.classList.add("editor-container");

        // ========================================
        // CRIA ÁREA DE TEXTO EDITÁVEL
        // ========================================
        const editor = document.createElement("div");
        editor.classList.add("text-editor-area");
        editor.contentEditable = "true";
        
        // Limpa formatação antiga se houver conteúdo
        if (content && typeof cleanOldFormatting === 'function') {
            editor.innerHTML = cleanOldFormatting(content);
        } else {
            editor.innerHTML = content || "";
        }
        
        editor.style.outline = "none";
        editor.style.overflowY = "auto";
        editor.spellcheck = true;

        // ========================================
        // LISTENERS DO EDITOR
        // ========================================
        
        // Evento: Colar texto (limpa formatação indesejada apenas do conteúdo colado)
        editor.addEventListener("paste", (e) => {
            // Marca os elementos existentes antes do paste
            const existingElements = new Set(editor.querySelectorAll("*"));
            
            setTimeout(() => {
                // Só limpa formatação dos elementos NOVOS (colados)
                const allElements = editor.querySelectorAll("*");
                allElements.forEach((el) => {
                    if (!existingElements.has(el)) {
                        // Elemento novo (colado) - remove apenas background e margens
                        // MANTÉM a cor do texto intacta!
                        el.style.backgroundColor = "transparent";
                        el.style.background = "";
                        el.style.marginTop = "0";
                        el.style.marginBottom = "0";
                    }
                });
                window.getSelection().removeAllRanges();
                if (syncContentToPrompter) syncContentToPrompter();
                if (updateFormatMenuState) updateFormatMenuState();
            }, 10);
        });

        // Evento: Digitação (marca como não salvo)
        editor.addEventListener("input", () => {
            markDocumentAsUnsaved(newId);
            if (syncContentToPrompter) syncContentToPrompter();
            scheduleAutoSave();
        });

        // Eventos de seleção
        editor.addEventListener("mouseup", () => {
            if (typeof saveSelection === 'function') saveSelection();
            if (updateFormatMenuState) updateFormatMenuState();
        });

        editor.addEventListener("keyup", () => {
            if (typeof saveSelection === 'function') saveSelection();
            if (updateFormatMenuState) updateFormatMenuState();
        });

        editor.addEventListener("click", () => {
            if (typeof saveSelection === 'function') saveSelection();
            if (updateFormatMenuState) updateFormatMenuState();
        });

        // Evento: Foco no editor
        editor.addEventListener("focus", () => {
            console.log("✅ Editor recebeu foco");
            if (updateEditMenuState) updateEditMenuState();
            document.execCommand("styleWithCSS", false, true);
            if (applySpellCheckSettings) applySpellCheckSettings();
            if (updateFormatMenuState) updateFormatMenuState();
        });

        editor.addEventListener("blur", () => {
            if (typeof saveSelection === 'function') saveSelection();
        });

        // ========================================
        // MONTA DOM E ATIVA DOCUMENTO
        // ========================================
        editorContainer.appendChild(editor);
        documentContentContainer.appendChild(editorContainer);

        if (applySettingsToVisuals) applySettingsToVisuals();
        if (syncInterfaceWithPreferences) syncInterfaceWithPreferences();
        if (syncContentToPrompter) syncContentToPrompter();

        activateDocument(newId);
        ipcRenderer.send("request-initial-settings");

        console.log("✅✅ DOCUMENTO CRIADO COM SUCESSO - ID:", newId);
        return newDoc;
    }

    // ============================================================
    // FUNÇÃO: Ativar Documento (Trocar Aba)
    // ============================================================
    /**
     * activateDocument
     * -----------------
     * Ativa um documento específico (troca de aba).
     * 
     * @param {number} targetId - ID do documento a ativar
     */
    function activateDocument(targetId) {
        console.log("🎯 Ativando documento:", targetId);

        // Se já está ativo, não faz nada
        if (activeDocumentId === targetId) {
            console.log("⏭️ Documento já estava ativo");
            return;
        }

        // Limpa highlights de busca (se houver função)
        if (typeof clearSearchHighlights === 'function') {
            clearSearchHighlights();
        }

        // ========================================
        // ATUALIZA CLASSES CSS DAS ABAS
        // ========================================
        document.querySelectorAll(".document-tab").forEach((t) => {
            t.classList.remove("active");
        });
        document.querySelectorAll(".editor-container").forEach((e) => {
            e.classList.remove("active");
        });

        // Adiciona "active" ao documento escolhido
        const tab = document.querySelector(`.document-tab[data-target="${targetId}"]`);
        const container = document.getElementById(`doc-${targetId}`);

        if (tab) {
            tab.classList.add("active");
            console.log("✅ Aba marcada como ativa");
        }

        if (container) {
            container.classList.add("active");
            console.log("✅ Container marcado como ativo");
        }

        // ========================================
        // ATUALIZA ESTADO E SINCRONIZA
        // ========================================
        activeDocumentId = targetId;
        const doc = getActiveDocument();

        console.log("📄 Documento ativo agora:", doc);

        if (doc) {
            updateTitle();
            if (syncContentToPrompter) syncContentToPrompter();

            // Coloca foco no editor
            const editor = getActiveTextEditorArea();
            if (editor) {
                editor.focus();
                console.log("✅ Foco no editor");
            }

            if (updateEditMenuState) updateEditMenuState();
            if (applySpellCheckSettings) applySpellCheckSettings();
            if (updateFormatMenuState) updateFormatMenuState();

            console.log("✅ Tudo sincronizado!");
        }
    }

    // ============================================================
    // FUNÇÃO: Fechar Documento
    // ============================================================
    /**
     * closeDocument
     * --------------
     * Inicia processo de fechamento de documento.
     * Se não salvo, mostra diálogo de confirmação.
     * 
     * @param {number} editorId - ID do documento a fechar
     */
    function closeDocument(editorId) {
        const doc = documents.find((d) => d.id === editorId);
        
        if (doc && !doc.saved) {
            // Documento tem alterações não salvas - pede confirmação
            ipcRenderer.send("confirm-close-dialog", editorId, doc.name);
        } else {
            // Documento salvo - fecha direto
            removeDocumentFromDOM(editorId);
        }
    }

    // ============================================================
    // FUNÇÃO: Remover Documento do DOM
    // ============================================================
    /**
     * removeDocumentFromDOM
     * ----------------------
     * Remove um documento da memória e do DOM.
     * Ativa outro documento se houver, senão mostra tela inicial.
     * 
     * @param {number} editorId - ID do documento a remover
     */
    function removeDocumentFromDOM(editorId) {
        // Remove do array
        documents = documents.filter((d) => d.id !== editorId);
        
        // Remove elementos DOM
        document.getElementById(`doc-${editorId}`)?.remove();
        document.querySelector(`.document-tab[data-target="${editorId}"]`)?.remove();

        // Ativa outro documento ou mostra Home
        if (documents.length > 0) {
            activateDocument(documents[documents.length - 1].id);
        } else {
            activeDocumentId = null;
            updateTitle();
            if (syncContentToPrompter) syncContentToPrompter();
            if (bootstrap) {
                bootstrap.Tab.getOrCreateInstance(
                    document.getElementById("home-tab")
                ).show();
            }
        }
    }

    // ============================================================
    // FUNÇÕES: Getters de Estado
    // ============================================================
    
    /**
     * getActiveDocument
     * ------------------
     * Retorna o objeto do documento atualmente ativo.
     */
    function getActiveDocument() {
        return documents.find((doc) => doc.id === activeDocumentId);
    }

    /**
     * getActiveTextEditorArea
     * ------------------------
     * Retorna o elemento DOM do editor ativo.
     */
    function getActiveTextEditorArea() {
        if (!activeDocumentId) return null;
        const container = document.getElementById(`doc-${activeDocumentId}`);
        return container ? container.querySelector(".text-editor-area") : null;
    }

    /**
     * getDocuments
     * -------------
     * Retorna array de todos os documentos abertos.
     */
    function getDocuments() {
        return documents;
    }

    /**
     * getActiveDocumentId
     * --------------------
     * Retorna o ID do documento ativo.
     */
    function getActiveDocumentId() {
        return activeDocumentId;
    }

    // ============================================================
    // FUNÇÕES: Auto-Save
    // ============================================================
    
    /**
     * scheduleAutoSave
     * -----------------
     * Agenda um salvamento automático após 1 segundo de inatividade.
     */
    function scheduleAutoSave() {
        if (!isAutoSaveEnabled) return;
        if (autoSaveTimeoutId) clearTimeout(autoSaveTimeoutId);
        
        autoSaveTimeoutId = setTimeout(() => {
            const editor = getActiveTextEditorArea();
            const doc = getActiveDocument();
            if (editor && doc && getCleanContent) {
                const rawContent = getCleanContent(editor);
                saveCurrentDocumentDirect(rawContent, doc);
            }
        }, 1000);
    }

    /**
     * saveCurrentDocumentDirect
     * --------------------------
     * Salva o documento diretamente (se tem caminho) ou abre diálogo.
     */
    function saveCurrentDocumentDirect(content, doc) {
        if (!content) content = "";
        
        if (doc.path) {
            // Já tem caminho - salva direto
            ipcRenderer.send("save-file-direct", content, doc.id, doc.path);
            doc.saved = true;
            updateTabTitle(doc.id, doc.name, true);
        } else {
            // Sem caminho - abre "Salvar Como"
            ipcRenderer.send("save-file-dialog", content, doc.id, doc.name);
        }
    }

    /**
     * setAutoSaveEnabled
     * -------------------
     * Liga ou desliga o auto-save.
     */
    function setAutoSaveEnabled(enabled) {
        isAutoSaveEnabled = enabled;
    }

    // ============================================================
    // FUNÇÕES: Atualização Visual
    // ============================================================
    
    /**
     * updateTabTitle
     * ---------------
     * Atualiza o título da aba (mostra bolinha se não salvo).
     */
    function updateTabTitle(id, name, saved) {
        const tabSpan = document.querySelector(`.document-tab[data-target="${id}"] span`);
        
        if (tabSpan) {
            if (saved) {
                // Salvo: mostra apenas o nome
                tabSpan.innerHTML = name;
            } else {
                // Não salvo: mostra bolinha + nome
                tabSpan.innerHTML = `<span class="unsaved-dot"></span>${name}`;
            }
        }

        // Atualiza título da janela se for o documento ativo
        if (id === activeDocumentId) updateTitle();
    }

    /**
     * updateTitle
     * ------------
     * Atualiza o título da janela com nome do documento.
     */
    function updateTitle() {
        const doc = getActiveDocument();
        const title = doc ? `Editor: ${doc.name}${doc.saved ? "" : "*"}` : "Editor";
        
        const titleDisplay = document.getElementById("window-title-display");
        if (titleDisplay) titleDisplay.textContent = title;
        
        ipcRenderer.send("set-window-title", title);
    }

    /**
     * markDocumentAsUnsaved
     * ----------------------
     * Marca um documento como tendo alterações não salvas.
     */
    function markDocumentAsUnsaved(id) {
        const doc = documents.find((d) => d.id === id);
        if (doc && doc.saved) {
            doc.saved = false;
            updateTabTitle(id, doc.name, false);
        }
    }

    // ============================================================
    // HANDLER: Clique nas Abas
    // ============================================================
    function handleTabClick(e) {
        const closeBtn = e.target.closest(".close-tab");
        const tab = e.target.closest(".document-tab");
        
        if (closeBtn) {
            e.stopPropagation();
            closeDocument(parseInt(closeBtn.dataset.id));
        } else if (tab) {
            activateDocument(parseInt(tab.dataset.target));
        }
    }

    // ============================================================
    // API PÚBLICA DO MÓDULO
    // ============================================================
    return {
        init,
        createNewDocument,
        activateDocument,
        closeDocument,
        removeDocumentFromDOM,
        getActiveDocument,
        getActiveTextEditorArea,
        getDocuments,
        getActiveDocumentId,
        scheduleAutoSave,
        saveCurrentDocumentDirect,
        setAutoSaveEnabled,
        updateTabTitle,
        updateTitle,
        markDocumentAsUnsaved
    };
    
})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DocumentManager;
}
