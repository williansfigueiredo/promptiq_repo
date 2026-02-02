// ============================================================
// color-service.js
// ============================================================
// DESCRIÇÃO: Serviço de gerenciamento de cores do editor
// FUNÇÃO: Implementa a lógica de paleta de cores híbrida
//         com presets e picker nativo do sistema operacional.
//         Permite colorir texto (foreground) ou fundo (background).
// ============================================================

/**
 * ColorService
 * -------------
 * Módulo responsável pela seleção e aplicação de cores no editor.
 * Inclui paleta de cores predefinidas e acesso ao color picker nativo.
 */
const ColorService = (function() {
    
    // ============================================================
    // PALETA DE CORES PREDEFINIDAS
    // ============================================================
    // Cores inspiradas na paleta do Google Docs
    const presetColors = [
        "#000000", "#434343", "#666666", "#999999", "#CCCCCC", "#EFEFEF", "#FFFFFF",
        "#980000", "#FF0000", "#FF9900", "#FFFF00", "#00FF00", "#00FFFF", "#4A86E8",
        "#0000FF", "#9900FF", "#FF00FF", "#E6B8AF", "#F4CCCC", "#FCE5CD", "#FFF2CC",
        "#D9EAD3", "#D0E0E3", "#C9DAF8", "#CFE2F3", "#D9D2E9", "#EAD1DC", "#DD7E6B",
        "#EA9999", "#F9CB9C", "#FFE599", "#B6D7A8", "#A2C4C9", "#A4C2F4", "#9FC5E8",
        "#B4A7D6", "#D5A6BD", "#CC4125", "#E06666", "#F6B26B", "#FFD966", "#93C47D",
        "#76A5AF", "#6D9EEB", "#6FA8DC", "#8E7CC3", "#C27BA0", "#A61C00", "#CC0000",
        "#E69138", "#F1C232", "#6AA84F", "#45818E", "#3C78D8", "#3D85C6", "#674EA7",
        "#A64D79",
    ];

    // ============================================================
    // REFERÊNCIAS DOM E ESTADO
    // ============================================================
    let colorButtons = null;           // Botões de cor na toolbar
    let palettePopup = null;           // Popup da paleta de cores
    let modeButtons = null;            // Botões de modo (letra/fundo)
    let btnResetColor = null;          // Botão da borracha
    let hiddenPicker = null;           // Input color oculto (picker nativo)
    let targetButton = null;           // Botão alvo para alteração de cor
    let paintingMode = "foreground";   // Modo atual: "foreground" ou "background"

    // ============================================================
    // CALLBACKS EXTERNOS
    // ============================================================
    let getActiveTextEditorArea = null;
    let syncContentToPrompter = null;
    let saveSelection = null;
    let restoreSelection = null;

    // ============================================================
    // INICIALIZAÇÃO DO MÓDULO
    // ============================================================
    /**
     * init
     * -----
     * Inicializa o serviço de cores com referências e callbacks.
     */
    function init(options) {
        colorButtons = options.colorButtons || document.querySelectorAll(".color-btn");
        palettePopup = options.palettePopup || document.getElementById("custom-color-palette");
        modeButtons = options.modeButtons || document.querySelectorAll(".btn-mode");
        btnResetColor = options.btnResetColor || document.getElementById("btn-reset-color");
        
        getActiveTextEditorArea = options.getActiveTextEditorArea;
        syncContentToPrompter = options.syncContentToPrompter;
        saveSelection = options.saveSelection;
        restoreSelection = options.restoreSelection;
        
        // Inicializa componentes
        setupHiddenPicker();
        setupPalettePopup();
        setupModeButtons();
        setupResetButton();
        setupColorButtons();
        setupOutsideClickHandler();
    }

    // ============================================================
    // CONFIGURAÇÃO DO PICKER NATIVO (OCULTO)
    // ============================================================
    /**
     * setupHiddenPicker
     * ------------------
     * Cria e configura o input type="color" invisível que
     * dispara o color picker nativo do sistema operacional.
     */
    function setupHiddenPicker() {
        hiddenPicker = document.getElementById("hidden-color-picker");
        if (!hiddenPicker) {
            hiddenPicker = document.createElement("input");
            hiddenPicker.type = "color";
            hiddenPicker.id = "hidden-color-picker";
            hiddenPicker.style.opacity = "0";
            hiddenPicker.style.position = "absolute";
            hiddenPicker.style.pointerEvents = "none";
            document.body.appendChild(hiddenPicker);
        }
        
        // Quando o usuário seleciona uma cor no picker nativo
        hiddenPicker.addEventListener("input", (e) => {
            applyColorToButton(e.target.value);
        });
    }

    // ============================================================
    // FUNÇÃO: Aplicar Cor ao Botão
    // ============================================================
    /**
     * applyColorToButton
     * -------------------
     * Aplica a cor selecionada ao botão alvo e fecha o popup.
     * 
     * @param {string} color - Cor em formato hexadecimal
     */
    function applyColorToButton(color) {
        if (targetButton) {
            targetButton.style.backgroundColor = color;
            targetButton.dataset.color = color;
            if (palettePopup) palettePopup.style.display = "none";
        }
    }

    // ============================================================
    // CONFIGURAÇÃO DA PALETA POPUP
    // ============================================================
    /**
     * setupPalettePopup
     * ------------------
     * Gera os quadradinhos de cores (swatches) dentro do popup.
     * Também adiciona o botão "Mais Cores..." para o picker nativo.
     */
    function setupPalettePopup() {
        if (!palettePopup) return;
        
        palettePopup.innerHTML = "";
        
        // ========================================
        // 1. GERA OS SWATCHES DE CORES
        // ========================================
        presetColors.forEach((color) => {
            const swatch = document.createElement("div");
            swatch.className = "palette-swatch";
            swatch.style.backgroundColor = color;
            
            // Impede que o clique no swatch feche o modal antes da hora
            swatch.addEventListener("mousedown", (e) => e.preventDefault());
            swatch.addEventListener("click", (e) => {
                e.stopPropagation();
                applyColorToButton(color);
            });
            
            palettePopup.appendChild(swatch);
        });

        // ========================================
        // 2. BOTÃO "MAIS CORES..."
        // ========================================
        const moreBtn = document.createElement("div");
        moreBtn.className = "palette-more-btn";
        moreBtn.innerHTML = "Mais Cores...";
        
        moreBtn.addEventListener("mousedown", (e) => e.preventDefault());
        
        // Abre o picker nativo posicionado ao lado do popup
        moreBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            
            if (targetButton) {
                hiddenPicker.value = targetButton.dataset.color || "#000000";
            }

            // Posiciona o picker ao lado do popup
            const rect = palettePopup.getBoundingClientRect();

            hiddenPicker.style.display = "block";
            hiddenPicker.style.position = "fixed";
            hiddenPicker.style.left = `${rect.right + 5}px`;  // 5px à direita do popup
            hiddenPicker.style.top = `${rect.top}px`;         // Alinhado ao topo
            hiddenPicker.style.width = "0px";
            hiddenPicker.style.height = "0px";
            hiddenPicker.style.opacity = "0";
            hiddenPicker.style.zIndex = "-1";

            // Clica no input e fecha o popup
            setTimeout(() => {
                hiddenPicker.click();
                palettePopup.style.display = "none";
            }, 50);
        });

        palettePopup.appendChild(moreBtn);
    }

    // ============================================================
    // CONFIGURAÇÃO DOS BOTÕES DE MODO (LETRA/FUNDO)
    // ============================================================
    /**
     * setupModeButtons
     * -----------------
     * Configura os botões que alternam entre pintar letra ou fundo.
     */
    function setupModeButtons() {
        if (!modeButtons) return;
        
        modeButtons.forEach((btn) => {
            btn.addEventListener("click", (e) => {
                // Salva seleção antes de trocar
                if (saveSelection) saveSelection();

                // Atualiza estado visual
                modeButtons.forEach((b) => b.classList.remove("active"));
                const clickedBtn = e.target.closest(".btn-mode");
                clickedBtn.classList.add("active");
                
                // Atualiza modo
                paintingMode = clickedBtn.dataset.mode;

                // Devolve foco ao editor
                if (restoreSelection) restoreSelection();
            });
        });
    }

    // ============================================================
    // CONFIGURAÇÃO DO BOTÃO BORRACHA (RESET DE CORES)
    // ============================================================
    /**
     * setupResetButton
     * -----------------
     * Configura o botão que remove cores do texto selecionado.
     * Remove fundo (transparente) e reseta letra para preto.
     */
    function setupResetButton() {
        if (!btnResetColor) return;
        
        btnResetColor.addEventListener("click", (e) => {
            e.preventDefault();

            const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
            if (editor) editor.focus();

            // Habilita CSS para precisão
            document.execCommand("styleWithCSS", false, true);

            // Remove cor de fundo (transparente)
            document.execCommand("hiliteColor", false, "transparent");

            // Reseta cor do texto para preto (mantém negrito/itálico)
            document.execCommand("foreColor", false, "#000000");

            // Sincroniza com o prompter
            if (syncContentToPrompter) syncContentToPrompter();
            if (saveSelection) saveSelection();
        });
    }

    // ============================================================
    // CONFIGURAÇÃO DOS BOTÕES DE COR
    // ============================================================
    /**
     * setupColorButtons
     * ------------------
     * Configura os botões de cor na toolbar.
     * Clique esquerdo = aplica cor | Clique direito = abre paleta
     */
    function setupColorButtons() {
        if (!colorButtons) return;
        
        colorButtons.forEach((btn) => {
            // ========================================
            // CLIQUE ESQUERDO: APLICAR COR
            // ========================================
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                if (restoreSelection) restoreSelection();

                const color = e.target.dataset.color;

                // Força criação de <span style="..."> para compatibilidade
                document.execCommand("styleWithCSS", false, true);

                if (paintingMode === "background") {
                    // Pinta fundo (marca-texto)
                    document.execCommand("hiliteColor", false, color);
                } else {
                    // Pinta letra
                    document.execCommand("foreColor", false, color);
                }

                // Sincroniza com prompter
                if (syncContentToPrompter) syncContentToPrompter();
                if (saveSelection) saveSelection();
                
                const editor = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
                if (editor) editor.focus();
            });

            // ========================================
            // CLIQUE DIREITO: ABRIR PALETA
            // ========================================
            btn.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();

                targetButton = e.currentTarget;

                // Torna visível mas transparente para calcular tamanho
                palettePopup.style.display = "flex";
                palettePopup.style.visibility = "hidden";

                // Medidas exatas
                const rect = targetButton.getBoundingClientRect();
                const modalHeight = palettePopup.offsetHeight || 150;
                const windowHeight = window.innerHeight;

                // Posição horizontal: alinha com a esquerda do botão
                palettePopup.style.left = `${rect.left}px`;

                // Posição vertical: embaixo ou em cima dependendo do espaço
                const spaceBelow = windowHeight - rect.bottom;
                if (spaceBelow >= modalHeight) {
                    // Abre embaixo (padrão)
                    palettePopup.style.top = `${rect.bottom + 5}px`;
                } else {
                    // Abre em cima
                    palettePopup.style.top = `${rect.top - modalHeight - 5}px`;
                }

                // Torna visível
                palettePopup.style.visibility = "visible";
            });
        });
    }

    // ============================================================
    // HANDLER PARA FECHAR POPUP AO CLICAR FORA
    // ============================================================
    function setupOutsideClickHandler() {
        document.addEventListener("mousedown", (e) => {
            if (palettePopup && palettePopup.style.display !== "none") {
                // Se o clique não foi dentro do popup nem num botão de cor
                if (!palettePopup.contains(e.target) && !e.target.classList.contains("color-btn")) {
                    palettePopup.style.display = "none";
                }
            }
        });
    }

    // ============================================================
    // API PÚBLICA DO MÓDULO
    // ============================================================
    return {
        init,
        applyColorToButton,
        getPaintingMode: () => paintingMode,
        setPaintingMode: (mode) => { paintingMode = mode; },
        getPresetColors: () => presetColors
    };
    
})();

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ColorService;
}
