// ============================================================
// quick-messages.js
// ============================================================
// DESCRIÇÃO: Módulo de Mensagens Rápidas (Quick Messages)
// FUNÇÃO: Gerencia o menu de mensagens rápidas para enviar
//         avisos visuais ao apresentador durante a leitura
//         do teleprompter. Suporta mensagens pré-definidas
//         e mensagens personalizadas.
// ============================================================

/**
 * QuickMessagesModule
 * --------------------
 * Módulo que implementa o sistema de mensagens rápidas
 * para comunicação com o apresentador em tempo real.
 */
const QuickMessagesModule = (function() {
    
    // ============================================================
    // REFERÊNCIAS DOM
    // ============================================================
    let quickMsgModal = null;        // Modal principal
    let quickMsgCatList = null;      // Lista de categorias (esquerda)
    let quickMsgActionList = null;   // Lista de ações (direita)
    let closeQuickMsgBtn = null;     // Botão de fechar

    // ============================================================
    // ESTADO INTERNO
    // ============================================================
    let activeCategory = null;       // Categoria atualmente selecionada

    // ============================================================
    // CALLBACKS EXTERNOS
    // ============================================================
    let ipcRenderer = null;
    let quickMessageConfig = null;   // Configuração de categorias/mensagens

    // ============================================================
    // INICIALIZAÇÃO DO MÓDULO
    // ============================================================
    /**
     * init
     * -----
     * Inicializa o módulo de mensagens rápidas.
     */
    function init(options) {
        // Referências DOM
        quickMsgModal = options.quickMsgModal || document.getElementById('quick-message-modal');
        quickMsgCatList = options.quickMsgCatList || document.getElementById('quick-msg-cat-list');
        quickMsgActionList = options.quickMsgActionList || document.getElementById('quick-msg-action-list');
        closeQuickMsgBtn = options.closeQuickMsgBtn || document.getElementById('close-quick-msg');
        
        // Callbacks
        ipcRenderer = options.ipcRenderer;
        quickMessageConfig = options.quickMessageConfig;
        
        // Configura listeners
        setupEventListeners();
        setupKeyboardShortcuts();
    }

    // ============================================================
    // FUNÇÃO: Toggle do Menu
    // ============================================================
    /**
     * toggleQuickMenu
     * ----------------
     * Abre ou fecha o menu de mensagens rápidas.
     */
    function toggleQuickMenu() {
        if (!quickMsgModal) return;
        
        if (quickMsgModal.classList.contains('d-none')) {
            // Abre o menu
            quickMsgModal.classList.remove('d-none');
            renderCategories();
            
            // Seleciona a primeira categoria por padrão
            if (quickMessageConfig && quickMessageConfig.categories.length > 0) {
                selectCategory(quickMessageConfig.categories[0].id);
            }
        } else {
            // Fecha o menu
            quickMsgModal.classList.add('d-none');
        }
    }

    // ============================================================
    // FUNÇÃO: Renderizar Categorias
    // ============================================================
    /**
     * renderCategories
     * -----------------
     * Popula a coluna esquerda com as categorias disponíveis.
     */
    function renderCategories() {
        if (!quickMsgCatList || !quickMessageConfig) return;
        
        quickMsgCatList.innerHTML = '';
        
        quickMessageConfig.categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'cat-btn';
            if (activeCategory === cat.id) btn.classList.add('active');
            btn.innerHTML = `<i class="bi ${cat.icon}"></i> ${cat.name}`;
            
            btn.onclick = () => selectCategory(cat.id);
            quickMsgCatList.appendChild(btn);
        });
    }

    // ============================================================
    // FUNÇÃO: Selecionar Categoria
    // ============================================================
    /**
     * selectCategory
     * ---------------
     * Seleciona uma categoria e renderiza suas ações.
     * 
     * @param {string} catId - ID da categoria
     */
    function selectCategory(catId) {
        activeCategory = catId;
        renderCategories();  // Atualiza visual dos botões
        
        if (!quickMsgActionList) return;
        quickMsgActionList.innerHTML = '';

        // ========================================
        // LÓGICA ESPECIAL: MENSAGEM PERSONALIZADA
        // ========================================
        if (catId === 'custom') {
            renderCustomMessageUI();
            return;
        }

        // ========================================
        // LÓGICA PADRÃO: OUTRAS CATEGORIAS
        // ========================================
        const category = quickMessageConfig.categories.find(c => c.id === catId);
        if (category) {
            category.items.forEach(item => {
                const btn = document.createElement('button');
                btn.className = 'action-btn';
                btn.innerHTML = `
                    <i class="bi ${item.icon}" style="color: ${item.bg}"></i> 
                    <span>${item.label}</span>
                `;
                btn.onclick = () => triggerOverlayMessage(item);
                quickMsgActionList.appendChild(btn);
            });
        }
    }

    // ============================================================
    // FUNÇÃO: Renderizar UI de Mensagem Personalizada
    // ============================================================
    /**
     * renderCustomMessageUI
     * ----------------------
     * Renderiza a interface para escrever mensagens personalizadas.
     */
    function renderCustomMessageUI() {
        const container = document.createElement('div');
        container.className = 'p-3';
        
        container.innerHTML = `
            <label style="color: #ffffff !important; font-weight: bold; display: block; margin-bottom: 10px;">
                Digite o aviso para o apresentador:
            </label>
            
            <div class="input-group mb-3">
                <input type="text" id="custom-msg-input" 
                       class="form-control" 
                       style="background-color: #1e1f22; color: #fff; border: 1px solid #555;"
                       placeholder="Ex: Ajeitar gravata..." autocomplete="off">
                
                <button class="btn btn-primary" id="btn-send-custom">
                    <i class="bi bi-send-fill"></i>
                </button>
            </div>

            <label style="color: #cccccc !important; font-size: 0.8rem; margin-bottom: 5px; display:block;">Atalhos Rápidos:</label>
            <div class="d-grid gap-2 mb-3">
                <button id="btn-preset-louder" class="btn btn-outline-warning fw-bold">
                    <i class="bi bi-volume-up-fill"></i> FALE MAIS ALTO
                </button>
                <button id="btn-preset-smile" class="btn btn-outline-info fw-bold">
                    <i class="bi bi-emoji-smile-fill"></i> SORRIA
                </button>
            </div>

            <p style="color: #999 !important; font-size: 0.8rem; margin-top: 5px;">
                <i class="bi bi-info-circle"></i> Digite e pressione ENTER para enviar.
            </p>
        `;
        
        quickMsgActionList.appendChild(container);

        // Foca no input automaticamente
        setTimeout(() => {
            const input = document.getElementById('custom-msg-input');
            if (input) input.focus();
        }, 100);

        // ========================================
        // LÓGICA DE ENVIO DO INPUT
        // ========================================
        const sendCustomText = () => {
            const input = document.getElementById('custom-msg-input');
            if (input && input.value.trim() !== '') {
                triggerOverlayMessage({
                    message: input.value.toUpperCase(),
                    bg: '#6f42c1',  // Roxo
                    color: '#ffffff',
                    icon: 'bi-chat-quote-fill'
                });
                input.value = '';
            }
        };

        // Botão enviar
        document.getElementById('btn-send-custom').onclick = sendCustomText;

        // Enter para enviar
        document.getElementById('custom-msg-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                sendCustomText();
            }
            e.stopPropagation();
        });

        // ========================================
        // BOTÕES DE ATALHO PRÉ-DEFINIDOS
        // ========================================
        
        // Botão FALE MAIS ALTO
        document.getElementById('btn-preset-louder').onclick = () => {
            triggerOverlayMessage({
                message: 'FALE MAIS ALTO',
                bg: '#ffc107',  // Amarelo
                color: '#000000',
                icon: 'bi-volume-up-fill'
            });
        };

        // Botão SORRIA
        document.getElementById('btn-preset-smile').onclick = () => {
            triggerOverlayMessage({
                message: 'SORRIA',
                bg: '#0dcaf0',  // Ciano
                color: '#000000',
                icon: 'bi-emoji-smile-fill'
            });
        };
    }

    // ============================================================
    // FUNÇÃO: Definir Texto Preset no Input
    // ============================================================
    /**
     * setCustomPreset
     * ----------------
     * Preenche o input com um texto preset.
     * 
     * @param {string} text - Texto a ser preenchido
     */
    function setCustomPreset(text) {
        const input = document.getElementById('custom-msg-input');
        if (input) {
            input.value = text;
            input.focus();
        }
    }

    // ============================================================
    // FUNÇÃO: Disparar Mensagem de Overlay
    // ============================================================
    /**
     * triggerOverlayMessage
     * ----------------------
     * Envia a mensagem para o main process distribuir.
     * 
     * @param {object} item - Objeto com message, bg, color, icon
     */
    function triggerOverlayMessage(item) {
        if (ipcRenderer) {
            ipcRenderer.send('broadcast-overlay-message', item);
        }
    }

    // ============================================================
    // FUNÇÃO: Mostrar Overlay na Tela
    // ============================================================
    /**
     * showOverlayMessage
     * -------------------
     * Exibe a mensagem na tela do prompter.
     * 
     * @param {object} item - Objeto com message, bg, color, icon
     */
    function showOverlayMessage(item) {
        const overlay = document.getElementById('prompter-message-overlay');
        const box = document.getElementById('prompter-message-box');
        const text = document.getElementById('prompter-message-text');
        const icon = document.getElementById('prompter-message-icon');

        if (overlay && box) {
            // Configura o visual
            text.innerText = item.message;
            box.style.backgroundColor = item.bg;
            box.style.color = item.color;
            
            // Ícone
            icon.className = `bi mb-2 ${item.icon}`;
            
            // Mostra
            overlay.classList.remove('d-none');

            // Esconde após 4 segundos
            setTimeout(() => {
                overlay.classList.add('d-none');
            }, 4000);
        }
    }

    // ============================================================
    // CONFIGURAÇÃO DE EVENT LISTENERS
    // ============================================================
    function setupEventListeners() {
        // Botão de fechar
        if (closeQuickMsgBtn) {
            closeQuickMsgBtn.addEventListener('click', toggleQuickMenu);
        }
    }

    // ============================================================
    // CONFIGURAÇÃO DE ATALHOS DE TECLADO
    // ============================================================
    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Shift + M abre o menu
            if (e.shiftKey && e.key.toLowerCase() === 'm') {
                e.preventDefault();
                // Só abre se estiver na aba Operator
                const operatorTab = document.getElementById('operator-tab-pane');
                if (operatorTab && operatorTab.classList.contains('active')) {
                    toggleQuickMenu();
                } else {
                    // Se quiser abrir em qualquer lugar, descomente:
                    toggleQuickMenu();
                }
            }
            
            // ESC fecha o menu
            if (e.key === 'Escape' && quickMsgModal && !quickMsgModal.classList.contains('d-none')) {
                toggleQuickMenu();
            }
        });
    }

    // ============================================================
    // CONFIGURAÇÃO DE IPC LISTENER (RECEBER MENSAGENS)
    // ============================================================
    /**
     * setupIPCListener
     * -----------------
     * Configura listener para receber mensagens do main process.
     */
    function setupIPCListener() {
        if (ipcRenderer) {
            ipcRenderer.on('show-overlay-message', (event, item) => {
                showOverlayMessage(item);
            });
        }
    }

    // ============================================================
    // API PÚBLICA DO MÓDULO
    // ============================================================
    return {
        init,
        toggleQuickMenu,
        renderCategories,
        selectCategory,
        triggerOverlayMessage,
        showOverlayMessage,
        setCustomPreset,
        setupIPCListener,
        getActiveCategory: () => activeCategory
    };
    
})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = QuickMessagesModule;
}
