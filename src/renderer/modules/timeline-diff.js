// ============================================================
// timeline-diff.js
// ============================================================
// DESCRIÇÃO: Módulo de Timeline e Comparação de Versões
// FUNÇÃO: Permite comparar diferentes versões de um documento
//         lado a lado, mostrando diferenças com destaque visual.
//         Usa a biblioteca diff.js para calcular as diferenças.
// ============================================================

/**
 * TimelineDiffModule
 * -------------------
 * Módulo que gerencia o modal de timeline e comparação
 * de versões do documento. Suporta comparação entre:
 * - Documento atual
 * - Outras abas abertas
 * - Histórico de versões salvas
 */
const TimelineDiffModule = (function() {
    
    // ============================================================
    // REFERÊNCIAS DOM
    // ============================================================
    let timelineBtn = null;           // Botão para abrir modal
    let timelineModalEl = null;       // Elemento do modal
    let timelineModal = null;         // Instância Bootstrap do modal
    let timelineList = null;          // Lista de versões disponíveis
    let diffLeftPanel = null;         // Painel esquerdo (versão antiga)
    let diffRightPanel = null;        // Painel direito (versão nova)
    let diffTitleLeft = null;         // Título do painel esquerdo
    let diffTitleRight = null;        // Título do painel direito
    let diffStatusText = null;        // Texto de status da comparação
    let btnRestoreVersion = null;     // Botão para restaurar versão

    // ============================================================
    // CALLBACKS EXTERNOS
    // ============================================================
    let getActiveDocument = null;
    let getActiveTextEditorArea = null;
    let getDocuments = null;  // Função que retorna array de documentos

    // ============================================================
    // INICIALIZAÇÃO DO MÓDULO
    // ============================================================
    /**
     * init
     * -----
     * Inicializa o módulo de timeline e diff.
     */
    function init(options) {
        // Referências DOM
        timelineBtn = options.timelineBtn || document.getElementById("timeline-btn");
        timelineModalEl = options.timelineModalEl || document.getElementById("timelineModal");
        timelineList = options.timelineList || document.getElementById("timeline-list");
        diffLeftPanel = options.diffLeftPanel || document.getElementById("diff-left-panel");
        diffRightPanel = options.diffRightPanel || document.getElementById("diff-right-panel");
        diffTitleLeft = options.diffTitleLeft || document.getElementById("diff-title-left");
        diffTitleRight = options.diffTitleRight || document.getElementById("diff-title-right");
        diffStatusText = options.diffStatusText || document.getElementById("diff-status-text");
        btnRestoreVersion = options.btnRestoreVersion || document.getElementById("btn-restore-version");
        
        // Inicializa modal Bootstrap
        if (timelineModalEl && typeof bootstrap !== 'undefined') {
            timelineModal = new bootstrap.Modal(timelineModalEl);
        }
        
        // Callbacks
        getActiveDocument = options.getActiveDocument;
        getActiveTextEditorArea = options.getActiveTextEditorArea;
        getDocuments = options.getDocuments;
        
        // Configura listener do botão
        setupEventListeners();
    }

    // ============================================================
    // HELPER: Obter Nome da Aba pelo ID
    // ============================================================
    /**
     * getTabNameFromDOM
     * ------------------
     * Retorna o nome visual de uma aba pelo ID do documento.
     * 
     * @param {string|number} id - ID do documento
     * @returns {string} Nome da aba
     */
    function getTabNameFromDOM(id) {
        const activeDoc = getActiveDocument ? getActiveDocument() : null;
        
        // Se for o documento ativo
        if (activeDoc && activeDoc.id == id) {
            if (activeDoc.name) return activeDoc.name;
            if (activeDoc.filename) return activeDoc.filename;
            if (activeDoc.path) return activeDoc.path.replace(/^.*[\\\/]/, "");
        }

        // Procura na lista de documentos
        const documents = getDocuments ? getDocuments() : [];
        const docObj = documents.find((d) => d.id == id);
        if (docObj) return docObj.name || docObj.filename || "Sem Título";

        return "Documento";
    }

    // ============================================================
    // HELPER: Obter Conteúdo da Aba pelo ID
    // ============================================================
    /**
     * getTabContentFromDOM
     * ---------------------
     * Retorna o conteúdo de texto de uma aba pelo ID.
     * Procura o container e extrai o texto do editor.
     * 
     * @param {string|number} id - ID do documento
     * @returns {string} Conteúdo textual
     */
    function getTabContentFromDOM(id) {
        // Tenta encontrar o container
        let container = document.getElementById(`doc-${id}`);
        if (!container) {
            container = document.getElementById(`document-content-${id}`);
        }

        if (!container) return "";

        // Procura o editor dentro do container
        const editor = container.querySelector(
            '.text-editor-area, .editor-content, textarea, [contenteditable="true"]'
        );

        if (editor) return editor.innerText;
        return "";
    }

    // ============================================================
    // FUNÇÃO: Resetar View de Diff
    // ============================================================
    /**
     * resetDiffView
     * --------------
     * Limpa os painéis de comparação e volta ao estado inicial.
     */
    function resetDiffView() {
        if (diffLeftPanel) {
            diffLeftPanel.innerHTML = '<p class="text-muted text-center mt-5">Select the first item (Original/Old)</p>';
        }
        if (diffRightPanel) {
            diffRightPanel.innerHTML = '<p class="text-muted text-center mt-5">Select the second item (New/Current)</p>';
        }
        if (diffTitleLeft) diffTitleLeft.innerText = "-";
        if (diffTitleRight) diffTitleRight.innerText = "-";
        if (diffStatusText) diffStatusText.innerText = "Select 2 boxes in the left list.";
        if (btnRestoreVersion) btnRestoreVersion.classList.add("d-none");
    }

    // ============================================================
    // FUNÇÃO: Renderizar Lista de Timeline
    // ============================================================
    /**
     * renderTimelineList
     * -------------------
     * Popula a lista lateral com todas as versões disponíveis.
     * 
     * @param {object} activeDoc - Documento ativo
     */
    function renderTimelineList(activeDoc) {
        if (!timelineList) return;
        
        timelineList.innerHTML = "";

        // ========================================
        // 1. DOCUMENTO ATUAL (TOPO DA LISTA)
        // ========================================
        const editorArea = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
        const currentText = editorArea ? editorArea.innerText : "";
        const currentName = activeDoc.name || activeDoc.filename || "Current File";

        const currentItem = {
            id: "current",
            displayName: currentName,
            subInfo: "Editing now (Active Tab)",
            content: currentText,
            type: "current",
            timestamp: Date.now(),
        };

        // ========================================
        // 2. OUTRAS ABAS ABERTAS
        // ========================================
        const documents = getDocuments ? getDocuments() : [];
        const otherTabs = documents
            .filter((d) => d.id !== activeDoc.id)
            .map((d) => ({
                id: `tab-${d.id}`,
                displayName: d.name || d.filename || `Doc ${d.id}`,
                subInfo: "Other Open Tab",
                content: getTabContentFromDOM(d.id) || d.content,
                type: "tab",
                timestamp: Date.now() - 100,
            }));

        // ========================================
        // 3. HISTÓRICO DE VERSÕES SALVAS
        // ========================================
        const history = (activeDoc.history || [])
            .slice()
            .reverse()
            .map((h) => ({
                id: `hist-${h.id}`,
                displayName: h.date,
                subInfo: "Versão Salva",
                content: h.content,
                type: "history",
                timestamp: h.id,
            }));

        // Junta tudo
        const allItems = [currentItem, ...otherTabs, ...history];

        // ========================================
        // RENDERIZA CADA ITEM
        // ========================================
        allItems.forEach((item) => {
            const row = document.createElement("div");
            row.className = "list-group-item list-group-item-action timeline-entry d-flex gap-2 align-items-center";
            row.style.cursor = "pointer";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "form-check-input my-0 flex-shrink-0";
            checkbox.value = item.id;

            // Badge colorida por tipo
            let badgeHtml = "";
            if (item.type === "current") {
                badgeHtml = '<span class="badge bg-primary rounded-pill ms-auto">Atual</span>';
            } else if (item.type === "tab") {
                badgeHtml = '<span class="badge bg-info text-dark rounded-pill ms-auto">Aba</span>';
            } else {
                badgeHtml = '<span class="badge bg-secondary rounded-pill ms-auto">Hist</span>';
            }

            row.innerHTML = `
                <div class="d-flex align-items-center w-100 p-1">
                    <div class="me-3 pointer-events-none">${checkbox.outerHTML}</div>
                    <div class="flex-grow-1">
                        <div class="d-flex justify-content-between align-items-center">
                            <span class="fw-bold text-dark" style="font-size: 0.9rem;">${item.displayName}</span>
                            ${badgeHtml}
                        </div>
                        <small class="text-muted">${item.subInfo}</small>
                    </div>
                </div>
            `;

            // Clique na linha inteira
            const injectedCheckbox = row.querySelector("input");
            row.addEventListener("click", (e) => {
                if (e.target !== injectedCheckbox) {
                    injectedCheckbox.checked = !injectedCheckbox.checked;
                }
                handleSelection(allItems);
            });

            timelineList.appendChild(row);
        });
    }

    // ============================================================
    // FUNÇÃO: Tratar Seleção de Itens
    // ============================================================
    /**
     * handleSelection
     * -----------------
     * Gerencia a seleção de itens para comparação.
     * Limita a 2 itens selecionados simultaneamente.
     * 
     * @param {array} allItems - Todos os itens disponíveis
     */
    function handleSelection(allItems) {
        const checkedBoxes = Array.from(
            document.querySelectorAll("#timeline-list input:checked")
        );

        // Regra: máximo 2 itens. Se marcar 3º, desmarca o 1º
        if (checkedBoxes.length > 2) {
            const first = checkedBoxes.shift();
            first.checked = false;
        }

        // Atualiza classes CSS (azul quando selecionado)
        document.querySelectorAll("#timeline-list .list-group-item").forEach((el) => {
            const inp = el.querySelector("input");
            if (inp.checked) el.classList.add("active");
            else el.classList.remove("active");
        });

        // Obtém IDs selecionados
        const finalChecked = document.querySelectorAll("#timeline-list input:checked");
        const selectedIds = Array.from(finalChecked).map((cb) => cb.value);

        // Filtra dados originais
        const selectedData = allItems.filter((i) => selectedIds.includes(i.id));

        updateSplitView(selectedData);
    }

    // ============================================================
    // FUNÇÃO: Atualizar Split View (Comparação)
    // ============================================================
    /**
     * updateSplitView
     * ----------------
     * Renderiza a comparação lado a lado usando diff.
     * 
     * @param {array} items - Itens selecionados (0 a 2)
     */
    function updateSplitView(items) {
        // ========================================
        // CASO 1: NENHUM OU 1 ITEM
        // ========================================
        if (items.length < 2) {
            if (items.length === 1) {
                // Modo leitura: mostra só na esquerda
                if (diffTitleLeft) diffTitleLeft.innerText = items[0].displayName;
                if (diffLeftPanel) diffLeftPanel.innerText = items[0].content;
                if (diffTitleRight) diffTitleRight.innerText = "-";
                if (diffRightPanel) {
                    diffRightPanel.innerHTML = '<p class="text-muted text-center mt-5">Selecione mais um para comparar</p>';
                }
            } else {
                resetDiffView();
            }
            return;
        }

        // ========================================
        // CASO 2: DOIS ITENS -> COMPARAÇÃO
        // ========================================
        // Ordena por timestamp (antigo na esquerda, novo na direita)
        items.sort((a, b) => a.timestamp - b.timestamp);

        const oldVer = items[0];  // Mais antigo
        const newVer = items[1];  // Mais recente

        // Atualiza títulos
        if (diffTitleLeft) diffTitleLeft.innerText = oldVer.displayName;
        if (diffTitleRight) diffTitleRight.innerText = newVer.displayName;
        if (diffStatusText) diffStatusText.innerText = `Comparando: ${oldVer.displayName} -> ${newVer.displayName}`;

        // ========================================
        // EXECUTA DIFF (biblioteca diff.js)
        // ========================================
        if (typeof Diff === 'undefined') {
            console.error("Biblioteca Diff não carregada!");
            return;
        }
        
        const diff = Diff.diffWords(oldVer.content, newVer.content);

        // Limpa painéis
        if (diffLeftPanel) diffLeftPanel.innerHTML = "";
        if (diffRightPanel) diffRightPanel.innerHTML = "";

        // ========================================
        // LOOP DE RENDERIZAÇÃO DO DIFF
        // ========================================
        diff.forEach((part) => {
            if (part.removed) {
                // REMOVIDO: aparece na esquerda (vermelho)
                const span = document.createElement("span");
                span.className = "diff-removed-highlight";
                span.innerText = part.value;
                if (diffLeftPanel) diffLeftPanel.appendChild(span);
            } else if (part.added) {
                // ADICIONADO: aparece na direita (verde)
                const span = document.createElement("span");
                span.className = "diff-added-highlight";
                span.innerText = part.value;
                if (diffRightPanel) diffRightPanel.appendChild(span);
            } else {
                // IGUAL: aparece nos dois
                const spanLeft = document.createElement("span");
                spanLeft.innerText = part.value;
                if (diffLeftPanel) diffLeftPanel.appendChild(spanLeft);

                const spanRight = document.createElement("span");
                spanRight.innerText = part.value;
                if (diffRightPanel) diffRightPanel.appendChild(spanRight);
            }
        });

        // ========================================
        // BOTÃO RESTAURAR VERSÃO
        // ========================================
        if (btnRestoreVersion) {
            btnRestoreVersion.classList.remove("d-none");
            btnRestoreVersion.onclick = () => {
                if (confirm(`Reverter o editor atual para o conteúdo de "${oldVer.displayName}"?`)) {
                    const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
                    if (editor) {
                        editor.innerText = oldVer.content;
                        if (timelineModal) timelineModal.hide();
                    }
                }
            };
        }
    }

    // ============================================================
    // CONFIGURAÇÃO DE EVENT LISTENERS
    // ============================================================
    function setupEventListeners() {
        if (timelineBtn) {
            timelineBtn.addEventListener("click", () => {
                const doc = getActiveDocument ? getActiveDocument() : null;
                if (!doc) {
                    alert("Nenhum documento ativo.");
                    return;
                }

                renderTimelineList(doc);
                resetDiffView();
                if (timelineModal) timelineModal.show();
            });
        }
    }

    // ============================================================
    // API PÚBLICA DO MÓDULO
    // ============================================================
    return {
        init,
        resetDiffView,
        renderTimelineList,
        handleSelection,
        updateSplitView,
        getTabNameFromDOM,
        getTabContentFromDOM
    };
    
})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TimelineDiffModule;
}
