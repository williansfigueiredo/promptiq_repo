// ============================================================
// hotkey-handler.js
// ============================================================
// DESCRIÇÃO: Gerenciador de atalhos de teclado e mouse
// FUNÇÃO: Mapeia teclas e botões do mouse para ações do prompter
//         baseado nas configurações do usuário em Preferences
// ============================================================

console.log('🎹 hotkey-handler.js carregando...');

const HotkeyHandler = (function() {

    // ============================================================
    // ESTADO INTERNO
    // ============================================================
    let hotkeySettings = {
        // Keyboard
        keyStopExit: 'Escape',
        keyPauseResume: 'Space',
        keyScrollForward: 'ArrowDown',
        keyScrollBackward: 'ArrowUp',
        keyReverseScroll: 'Backspace',
        keyPreviousLine: 'BracketLeft',
        keyNextLine: 'BracketRight',
        keyPreviousCue: 'ArrowLeft',
        keyNextCue: 'ArrowRight',
        keyJumpStart: 'Home',
        keyShowHideCue: '',
        // Mouse
        mouseStopExit: 'none',
        mousePauseResume: 'none',
        mouseScrollForward: 'none',
        mouseScrollBackward: 'none',
        mouseReverseScroll: 'none',
        mousePreviousLine: 'none',
        mouseNextLine: 'none',
        mousePreviousCue: 'none',
        mouseNextCue: 'none',
        mouseJumpStart: 'none',
        mouseShowHideCue: 'none'
    };

    // Callbacks para ações
    let actions = {
        stopExit: null,
        pauseResume: null,
        scrollForward: null,
        scrollBackward: null,
        reverseScroll: null,
        previousLine: null,
        nextLine: null,
        previousCue: null,
        nextCue: null,
        jumpStart: null,
        showHideCue: null
    };

    let isEnabled = false;

    /**
     * Verifica se o evento ocorreu na área do prompter (aba Operator).
     */
    function isPrompterTarget(event) {
        const pane = document.getElementById("operator-tab-pane");
        if (!pane || !pane.classList.contains("show")) return false;
        const prompter = document.querySelector(".prompter-in-control");
        if (!prompter) return false;
        return prompter.contains(event.target) || event.target === prompter;
    }

    function getMouseButtonFromSetting(setting) {
        return mouseButtonMap[normalizeMouseSetting(setting)];
    }

    function runMouseAction(event, setting, actionName) {
        if (getMouseButtonFromSetting(setting) !== event.button) return false;
        event.preventDefault();
        event.stopPropagation();
        if (actions[actionName]) actions[actionName]();
        return true;
    }

    // ============================================================
    // MAPEAMENTO DE TECLAS
    // ============================================================
    // Converte nomes amigáveis (como gravados na UI/Preferences) em
    // event.code do KeyboardEvent.
    const keyNameToCode = {
        'Esc': 'Escape',
        'Escape': 'Escape',
        'Space': 'Space',
        'Enter': 'Enter',
        'Tab': 'Tab',
        'Backspace': 'Backspace',
        'Delete': 'Delete',
        'Home': 'Home',
        'End': 'End',
        'PageUp': 'PageUp',
        'PageDown': 'PageDown',
        'Up': 'ArrowUp',
        'Down': 'ArrowDown',
        'Left': 'ArrowLeft',
        'Right': 'ArrowRight',
        '[': 'BracketLeft',
        ']': 'BracketRight',
        ';': 'Semicolon',
        "'": 'Quote',
        ',': 'Comma',
        '.': 'Period',
        '/': 'Slash',
        '\\': 'Backslash',
        '-': 'Minus',
        '=': 'Equal',
        '`': 'Backquote',
        '*': '*',
        '[None]': '',
        'None': ''
    };

    // Mapeamento reverso para exibição
    const codeToKeyName = {
        'Escape': 'Esc',
        'Space': 'Space',
        'ArrowUp': 'Up',
        'ArrowDown': 'Down',
        'ArrowLeft': 'Left',
        'ArrowRight': 'Right',
        'BracketLeft': '[',
        'BracketRight': ']',
        'Semicolon': ';',
        'Quote': "'",
        'Comma': ',',
        'Period': '.',
        'Slash': '/',
        'Backslash': '\\',
        'Minus': '-',
        'Equal': '=',
        'Backquote': '`'
    };

    // Mapeamento de botões do mouse (aceita valores da UI e aliases internos)
    const mouseButtonMap = {
        'none': -1,
        'left': 0,
        'left-click': 0,
        'middle': 1,
        'right': 2,
        'right-click': 2,
        'back': 3,
        'forward': 4,
        'scroll-up': 'wheelUp',
        'scroll-down': 'wheelDown',
        'scroll-wheel-up': 'wheelUp',
        'scroll-wheel-down': 'wheelDown'
    };

    function normalizeMouseSetting(value) {
        if (!value || value === 'none') return 'none';
        const v = String(value).toLowerCase().trim();
        return mouseButtonMap.hasOwnProperty(v) ? v : 'none';
    }

    function matchesMouseWheel(setting, direction) {
        const n = normalizeMouseSetting(setting);
        if (direction === 'scroll-down') {
            return n === 'scroll-wheel-down' || n === 'scroll-down';
        }
        if (direction === 'scroll-up') {
            return n === 'scroll-wheel-up' || n === 'scroll-up';
        }
        return false;
    }

    // ============================================================
    // FUNÇÕES INTERNAS
    // ============================================================

    /**
     * Normaliza nome de tecla para código
     */
    function normalizeKeyName(name) {
        if (!name || name === '[None]' || name === 'None') return '';

        // Mapa primeiro (cobre teclas especiais e símbolos)
        if (keyNameToCode[name]) {
            return keyNameToCode[name];
        }

        // Letra única → KeyA, KeyB, ...
        if (/^[A-Za-z]$/.test(name)) {
            return 'Key' + name.toUpperCase();
        }

        // Dígito único → Digit0..Digit9
        if (/^\d$/.test(name)) {
            return 'Digit' + name;
        }

        // Numpad ex.: "Num1"
        if (/^Num\d$/.test(name)) {
            return 'Numpad' + name.slice(3);
        }

        // Teclas de função F1-F12
        if (/^F\d+$/i.test(name)) {
            return name.toUpperCase();
        }

        return name;
    }

    /**
     * Verifica se a tecla pressionada corresponde ao atalho
     */
    function matchesKey(event, settingValue) {
        if (!settingValue) return false;
        
        const normalizedSetting = normalizeKeyName(settingValue);
        if (!normalizedSetting) return false;

        // Comparação por code ou key
        return event.code === normalizedSetting || 
               event.key === settingValue ||
               event.key === codeToKeyName[normalizedSetting];
    }

    /**
     * Verifica se o foco está em um campo de input
     */
    function isInputFocused() {
        // No modo edição o prompter está coberto: nenhum atalho dele deve agir.
        if (document.body.classList.contains('operator-edit-mode')) return true;

        const active = document.activeElement;
        if (!active) return false;
        
        const tag = active.tagName.toLowerCase();
        const isEditable = active.isContentEditable;
        
        return tag === 'input' || 
               tag === 'textarea' || 
               tag === 'select' ||
               isEditable;
    }

    /**
     * Handler de teclas
     */
    function handleKeyDown(event) {
        if (!isEnabled) return;
        
        // Ignora se estiver digitando em input
        if (isInputFocused()) return;

        // Verifica cada atalho configurado
        if (matchesKey(event, hotkeySettings.keyStopExit)) {
            event.preventDefault();
            if (actions.stopExit) actions.stopExit();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyPauseResume)) {
            event.preventDefault();
            if (actions.pauseResume) actions.pauseResume();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyScrollForward)) {
            event.preventDefault();
            if (actions.scrollForward) actions.scrollForward();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyScrollBackward)) {
            event.preventDefault();
            if (actions.scrollBackward) actions.scrollBackward();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyReverseScroll)) {
            event.preventDefault();
            if (actions.reverseScroll) actions.reverseScroll();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyPreviousLine)) {
            event.preventDefault();
            if (actions.previousLine) actions.previousLine();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyNextLine)) {
            event.preventDefault();
            if (actions.nextLine) actions.nextLine();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyPreviousCue)) {
            event.preventDefault();
            if (actions.previousCue) actions.previousCue();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyNextCue)) {
            event.preventDefault();
            if (actions.nextCue) actions.nextCue();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyJumpStart)) {
            event.preventDefault();
            if (actions.jumpStart) actions.jumpStart();
            return;
        }

        if (matchesKey(event, hotkeySettings.keyShowHideCue)) {
            event.preventDefault();
            if (actions.showHideCue) actions.showHideCue();
            return;
        }
    }

    /**
     * Clique do mouse: ações discretas (respeita Preferences).
     */
    function handleClick(event) {
        if (!isEnabled || !isPrompterTarget(event)) return;
        if (isInputFocused()) return;
        if (event.target.closest("#cueMarker-control")) return;

        if (runMouseAction(event, hotkeySettings.mouseStopExit, "stopExit")) return;
        if (runMouseAction(event, hotkeySettings.mousePauseResume, "pauseResume")) return;
        // Reverse Scroll no mouse = pausa/retoma com um clique (ex.: botão direito)
        if (runMouseAction(event, hotkeySettings.mouseReverseScroll, "pauseResume")) return;
        if (runMouseAction(event, hotkeySettings.mouseScrollForward, "scrollForward")) return;
        if (runMouseAction(event, hotkeySettings.mouseScrollBackward, "scrollBackward")) return;
        if (runMouseAction(event, hotkeySettings.mousePreviousLine, "previousLine")) return;
        if (runMouseAction(event, hotkeySettings.mouseNextLine, "nextLine")) return;
        if (runMouseAction(event, hotkeySettings.mousePreviousCue, "previousCue")) return;
        if (runMouseAction(event, hotkeySettings.mouseNextCue, "nextCue")) return;
        if (runMouseAction(event, hotkeySettings.mouseJumpStart, "jumpStart")) return;
        if (runMouseAction(event, hotkeySettings.mouseShowHideCue, "showHideCue")) return;
    }

    function handleContextMenu(event) {
        if (!isEnabled || !isPrompterTarget(event)) return;
        event.preventDefault();
    }

    /**
     * Handler de scroll do mouse
     */
    function handleWheel(event) {
        if (!isEnabled || !isPrompterTarget(event)) return;
        if (isInputFocused()) return;

        const direction = event.deltaY > 0 ? 'scroll-down' : 'scroll-up';

        if (matchesMouseWheel(hotkeySettings.mouseScrollForward, direction)) {
            event.preventDefault();
            event.stopPropagation();
            if (actions.scrollForward) actions.scrollForward();
            return;
        }

        if (matchesMouseWheel(hotkeySettings.mouseScrollBackward, direction)) {
            event.preventDefault();
            event.stopPropagation();
            if (actions.scrollBackward) actions.scrollBackward();
            return;
        }
    }

    // ============================================================
    // API PÚBLICA
    // ============================================================

    /**
     * Inicializa o handler de atalhos
     * @param {Object} opts - Opções de configuração
     */
    function init(opts = {}) {
        // Registra callbacks de ações
        if (opts.actions) {
            actions = { ...actions, ...opts.actions };
        }

        // Carrega configurações se fornecidas
        if (opts.settings) {
            updateSettings(opts.settings);
        }

        // Registra listeners
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('click', handleClick, true);
        document.addEventListener('contextmenu', handleContextMenu, true);
        document.addEventListener('wheel', handleWheel, { passive: false, capture: true });

        console.log('🎹 HotkeyHandler inicializado');
    }

    /**
     * Atualiza configurações de atalhos
     * @param {Object} settings - Novas configurações
     */
    function updateSettings(settings) {
        if (!settings) return;

        // Mapeia as configurações recebidas
        const keyMap = {
            keyStopExit: settings.keyStopExit,
            keyPauseResume: settings.keyPauseResume,
            keyScrollForward: settings.keyScrollForward,
            keyScrollBackward: settings.keyScrollBackward,
            keyReverseScroll: settings.keyReverseScroll,
            keyPreviousLine: settings.keyPreviousLine,
            keyNextLine: settings.keyNextLine,
            keyPreviousCue: settings.keyPreviousCue,
            keyNextCue: settings.keyNextCue,
            keyJumpStart: settings.keyJumpStart,
            keyShowHideCue: settings.keyShowHideCue,
            mouseStopExit: settings.mouseStopExit,
            mousePauseResume: settings.mousePauseResume,
            mouseScrollForward: settings.mouseScrollForward,
            mouseScrollBackward: settings.mouseScrollBackward,
            mouseReverseScroll: settings.mouseReverseScroll,
            mousePreviousLine: settings.mousePreviousLine,
            mouseNextLine: settings.mouseNextLine,
            mousePreviousCue: settings.mousePreviousCue,
            mouseNextCue: settings.mouseNextCue,
            mouseJumpStart: settings.mouseJumpStart,
            mouseShowHideCue: settings.mouseShowHideCue
        };

        // Atualiza apenas os campos definidos
        Object.keys(keyMap).forEach(key => {
            if (keyMap[key] !== undefined) {
                hotkeySettings[key] = keyMap[key];
            }
        });

        console.log('🎹 Hotkeys atualizados:', hotkeySettings);
    }

    /**
     * Ativa os atalhos (geralmente na aba Operator)
     */
    function enable() {
        isEnabled = true;
        console.log('🎹 Hotkeys ATIVADOS');
    }

    /**
     * Desativa os atalhos (quando sair da aba Operator)
     */
    function disable() {
        isEnabled = false;
        console.log('🎹 Hotkeys DESATIVADOS');
    }

    /**
     * Verifica se está ativo
     */
    function isActive() {
        return isEnabled;
    }

    /**
     * Retorna configurações atuais
     */
    function getSettings() {
        return { ...hotkeySettings };
    }

    /**
     * Registra uma ação específica
     */
    function registerAction(actionName, callback) {
        if (actions.hasOwnProperty(actionName)) {
            actions[actionName] = callback;
        }
    }

    /**
     * Remove listeners (cleanup)
     */
    function destroy() {
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('contextmenu', handleContextMenu, true);
        document.removeEventListener('wheel', handleWheel, true);
        isEnabled = false;
    }

    // ============================================================
    // RETORNO DO MÓDULO
    // ============================================================
    return {
        init,
        updateSettings,
        enable,
        disable,
        isActive,
        getSettings,
        registerAction,
        destroy
    };

})();

// Exporta para uso global no browser
if (typeof window !== 'undefined') {
    window.HotkeyHandler = HotkeyHandler;
    console.log('🎹 HotkeyHandler exportado para window');
}

// Exporta para Node.js/CommonJS
if (typeof module !== 'undefined' && module.exports) {
    module.exports = HotkeyHandler;
}
