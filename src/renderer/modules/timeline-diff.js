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
    let btnRestoreLeft = null;        // Botão para restaurar versão esquerda
    let btnRestoreRight = null;       // Botão para restaurar versão direita

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
        btnRestoreLeft = options.btnRestoreLeft || document.getElementById("btn-restore-left");
        btnRestoreRight = options.btnRestoreRight || document.getElementById("btn-restore-right");
        
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

        if (!container) {
            console.log(`[Timeline] Container não encontrado para doc-${id}`);
            return { html: "", text: "" };
        }

        // Procura o editor dentro do container
        const editor = container.querySelector('.text-editor-area');
        
        if (!editor) {
            // Tenta buscar por contenteditable
            const fallbackEditor = container.querySelector('[contenteditable="true"]');
            if (fallbackEditor) {
                return {
                    html: fallbackEditor.innerHTML,
                    text: fallbackEditor.innerText
                };
            }
            console.log(`[Timeline] Editor não encontrado no container doc-${id}`);
            return { html: "", text: "" };
        }

        return {
            html: editor.innerHTML,
            text: editor.innerText
        };
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
        if (btnRestoreLeft) btnRestoreLeft.classList.add("d-none");
        if (btnRestoreRight) btnRestoreRight.classList.add("d-none");
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
        const currentHtml = editorArea ? editorArea.innerHTML : "";
        const currentText = editorArea ? editorArea.innerText : "";
        const currentName = activeDoc.name || activeDoc.filename || "Current File";

        const currentItem = {
            id: "current",
            displayName: currentName,
            subInfo: "Editing now (Active Tab)",
            content: currentHtml,       // HTML para restauração
            textContent: currentText,   // Texto para comparação visual
            type: "current",
            timestamp: Date.now(),
        };

        // ========================================
        // 2. OUTRAS ABAS ABERTAS
        // ========================================
        const documents = getDocuments ? getDocuments() : [];
        const otherTabs = documents
            .filter((d) => d.id !== activeDoc.id)
            .map((d) => {
                const tabContent = getTabContentFromDOM(d.id);
                // Se não pegou do DOM, o conteúdo do documento pode ser texto puro
                const hasHtmlFromDOM = tabContent.html && tabContent.html.length > 0;
                
                console.log(`[Timeline] Aba ${d.id}: hasHtmlFromDOM=${hasHtmlFromDOM}, tabContent.html.length=${tabContent.html?.length || 0}`);
                if (hasHtmlFromDOM) {
                    console.log(`[Timeline] Aba ${d.id} HTML (primeiros 200 chars):`, tabContent.html.substring(0, 200));
                }
                
                return {
                    id: `tab-${d.id}`,
                    displayName: d.name || d.filename || `Doc ${d.id}`,
                    subInfo: "Other Open Tab",
                    content: hasHtmlFromDOM ? tabContent.html : d.content,
                    textContent: hasHtmlFromDOM ? tabContent.text : (typeof d.content === 'string' ? d.content : ''),
                    type: "tab",
                    timestamp: Date.now() - 100,
                };
            });

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
                content: h.content,         // HTML para restauração
                textContent: h.content,     // Texto (histórico pode ser texto puro)
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
     * PRESERVA A ORDEM DE SELEÇÃO: primeiro = esquerda, segundo = direita
     * 
     * @param {array} allItems - Todos os itens disponíveis
     */
    
    // Guarda a ordem de seleção
    let selectionOrder = [];
    
    function handleSelection(allItems) {
        const checkedBoxes = Array.from(
            document.querySelectorAll("#timeline-list input:checked")
        );

        // Obtém IDs atualmente marcados
        const currentIds = checkedBoxes.map(cb => cb.value);
        
        // Atualiza a ordem de seleção
        // Remove IDs que foram desmarcados
        selectionOrder = selectionOrder.filter(id => currentIds.includes(id));
        // Adiciona novos IDs no final
        currentIds.forEach(id => {
            if (!selectionOrder.includes(id)) {
                selectionOrder.push(id);
            }
        });

        // Regra: máximo 2 itens. Se marcar 3º, desmarca o 1º
        if (selectionOrder.length > 2) {
            const removedId = selectionOrder.shift();
            const checkboxToUncheck = document.querySelector(`#timeline-list input[value="${removedId}"]`);
            if (checkboxToUncheck) checkboxToUncheck.checked = false;
        }

        // Atualiza classes CSS (azul quando selecionado)
        document.querySelectorAll("#timeline-list .list-group-item").forEach((el) => {
            const inp = el.querySelector("input");
            if (inp.checked) el.classList.add("active");
            else el.classList.remove("active");
        });

        // Filtra dados originais NA ORDEM DE SELEÇÃO
        const selectedData = selectionOrder
            .map(id => allItems.find(item => item.id === id))
            .filter(Boolean);

        updateSplitView(selectedData);
    }
    
    // Reseta a ordem de seleção quando o modal abre
    function resetSelectionOrder() {
        selectionOrder = [];
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
        // USA A ORDEM DE SELEÇÃO (primeiro selecionado = esquerda/referência, segundo = direita/comparado)

        const oldVer = items[0];  // Primeiro selecionado (v1 - referência)
        const newVer = items[1];  // Segundo selecionado (v2 - comparado)

        // Debug: mostra os itens selecionados
        console.log('[Timeline] Referência (v1):', oldVer.displayName);
        console.log('[Timeline] Comparado (v2):', newVer.displayName);

        // Atualiza títulos
        if (diffTitleLeft) diffTitleLeft.innerText = oldVer.displayName + ' (Referência)';
        if (diffTitleRight) diffTitleRight.innerText = newVer.displayName + ' (Diferenças)';

        // ========================================
        // EXECUTA DIFF (biblioteca diff.js)
        // ========================================
        if (typeof Diff === 'undefined') {
            console.error("Biblioteca Diff não carregada!");
            return;
        }
        
        // Usa textContent para comparação visual (não HTML)
        const oldText = oldVer.textContent || oldVer.content;
        const newText = newVer.textContent || newVer.content;
        
        // Usa diffWords para comparação mais granular
        const diff = Diff.diffWords(oldText, newText);

        // Limpa painéis
        if (diffLeftPanel) diffLeftPanel.innerHTML = "";
        if (diffRightPanel) diffRightPanel.innerHTML = "";

        // Estatísticas
        let addedCount = 0;
        let removedCount = 0;

        // ========================================
        // PAINEL ESQUERDO: TEXTO V1 (REFERÊNCIA) - COMPLETAMENTE LIMPO
        // Mostra APENAS o texto original, sem NENHUMA marcação
        // ========================================
        const leftContainer = document.createElement('div');
        leftContainer.className = 'diff-text-clean';
        leftContainer.style.cssText = 'white-space: pre-wrap; padding: 12px; line-height: 1.6; font-family: inherit;';
        leftContainer.textContent = oldText;  // Texto puro, sem marcações
        if (diffLeftPanel) {
            diffLeftPanel.innerHTML = '';  // Garante que está limpo
            diffLeftPanel.appendChild(leftContainer);
        }

        // ========================================
        // PAINEL DIREITO: TEXTO V2 COM DIFERENÇAS INLINE
        // 
        // Lógica do diff.js (comparando v1 -> v2):
        // - part.removed = existe no v1, NÃO existe no v2 (foi REMOVIDO do script)
        // - part.added = NÃO existe no v1, existe no v2 (foi ADICIONADO ao script)
        // 
        // Exibição no painel direito:
        // - VERMELHO TACHADO = texto que foi REMOVIDO (estava no v1, não está mais no v2)
        // - VERDE = texto que foi ADICIONADO (não existia no v1, agora existe no v2)
        // ========================================
        const rightContainer = document.createElement('div');
        rightContainer.className = 'diff-text-marked';
        rightContainer.style.cssText = 'white-space: pre-wrap; padding: 12px; line-height: 1.6; font-family: inherit;';

        diff.forEach((part) => {
            const span = document.createElement('span');
            
            if (part.removed) {
                // part.removed = texto que EXISTIA no v1 mas NÃO existe no v2
                // Significa que foi REMOVIDO do documento
                // Mostra em VERMELHO TACHADO
                span.className = 'diff-inline-removed';
                span.textContent = part.value;
                removedCount++;
            } else if (part.added) {
                // part.added = texto que NÃO existia no v1 mas EXISTE no v2
                // Significa que foi ADICIONADO ao documento
                // Mostra em VERDE
                span.className = 'diff-inline-added';
                span.textContent = part.value;
                addedCount++;
            } else {
                // IGUAL = texto sem alteração (existe em ambos)
                span.textContent = part.value;
            }
            
            rightContainer.appendChild(span);
        });

        if (diffRightPanel) {
            diffRightPanel.innerHTML = '';  // Garante que está limpo
            diffRightPanel.appendChild(rightContainer);
        }

        // ========================================
        // SINCRONIZA SCROLL DOS PAINÉIS
        // ========================================
        if (diffLeftPanel && diffRightPanel) {
            let isSyncing = false;
            
            diffLeftPanel.addEventListener('scroll', () => {
                if (isSyncing) return;
                isSyncing = true;
                diffRightPanel.scrollTop = diffLeftPanel.scrollTop;
                isSyncing = false;
            });
            
            diffRightPanel.addEventListener('scroll', () => {
                if (isSyncing) return;
                isSyncing = true;
                diffLeftPanel.scrollTop = diffRightPanel.scrollTop;
                isSyncing = false;
            });
        }

        // Atualiza status com estatísticas
        if (diffStatusText) {
            if (addedCount === 0 && removedCount === 0) {
                diffStatusText.innerHTML = '<span class="text-muted">✓ Textos idênticos</span>';
            } else {
                diffStatusText.innerHTML = `
                    <span class="text-success fw-bold">+${addedCount} adicionado${addedCount !== 1 ? 's' : ''}</span> 
                    <span class="text-danger fw-bold ms-2">-${removedCount} removido${removedCount !== 1 ? 's' : ''}</span>
                `;
            }
        }

        // ========================================
        // BOTÕES RESTAURAR VERSÃO (Esquerda e Direita)
        // ========================================
        // Botão Restaurar Esquerda (versão antiga)
        if (btnRestoreLeft) {
            btnRestoreLeft.classList.remove("d-none");
            btnRestoreLeft.onclick = () => {
                if (confirm(`Reverter o editor atual para o conteúdo de "${oldVer.displayName}"?`)) {
                    const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
                    if (editor) {
                        console.log('[Timeline] Restaurando versão ESQUERDA:', oldVer.content.substring(0, 200));
                        editor.innerHTML = oldVer.content;
                        editor.dispatchEvent(new Event('input', { bubbles: true }));
                        if (timelineModal) timelineModal.hide();
                    }
                }
            };
        }

        // Botão Restaurar Direita (versão nova/atual)
        if (btnRestoreRight) {
            btnRestoreRight.classList.remove("d-none");
            btnRestoreRight.onclick = () => {
                if (confirm(`Reverter o editor atual para o conteúdo de "${newVer.displayName}"?`)) {
                    const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
                    if (editor) {
                        console.log('[Timeline] Restaurando versão DIREITA:', newVer.content.substring(0, 200));
                        editor.innerHTML = newVer.content;
                        editor.dispatchEvent(new Event('input', { bubbles: true }));
                        if (timelineModal) timelineModal.hide();
                    }
                }
            };
        }
    }

    // ============================================================
    // HELPER: Criar Linha de Diff
    // ============================================================
    /**
     * createDiffLine
     * ---------------
     * Cria um elemento de linha estilo Git/GitHub
     * 
     * @param {number|string} lineNum - Número da linha
     * @param {string} prefix - '+', '-', ou '' (igual)
     * @param {string} text - Conteúdo da linha
     * @param {string} type - 'added', 'removed', 'unchanged', 'placeholder'
     */
    function createDiffLine(lineNum, prefix, text, type) {
        const line = document.createElement('div');
        line.className = `diff-line diff-line-${type}`;
        
        // Número da linha
        const lineNumSpan = document.createElement('span');
        lineNumSpan.className = 'diff-line-num';
        lineNumSpan.textContent = lineNum;
        
        // Prefixo (+/-)
        const prefixSpan = document.createElement('span');
        prefixSpan.className = 'diff-line-prefix';
        prefixSpan.textContent = prefix;
        
        // Conteúdo
        const contentSpan = document.createElement('span');
        contentSpan.className = 'diff-line-content';
        contentSpan.textContent = text || (type === 'placeholder' ? '' : ' ');
        
        line.appendChild(lineNumSpan);
        line.appendChild(prefixSpan);
        line.appendChild(contentSpan);
        
        return line;
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

                // Reseta a ordem de seleção ao abrir o modal
                resetSelectionOrder();
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
        resetSelectionOrder,
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
