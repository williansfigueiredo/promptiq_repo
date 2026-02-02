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

    // ============================================================
    // MAPEAMENTO DE TECLAS
    // ============================================================
    // Converte nomes amigáveis para códigos de tecla
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
        'BracketRight': ']'
    };

    // Mapeamento de botões do mouse
    const mouseButtonMap = {
        'none': -1,
        'left': 0,
        'middle': 1,
        'right': 2,
        'back': 3,
        'forward': 4,
        'scroll-up': 'wheelUp',
        'scroll-down': 'wheelDown'
    };

    // ============================================================
    // FUNÇÕES INTERNAS
    // ============================================================

    /**
     * Normaliza nome de tecla para código
     */
    function normalizeKeyName(name) {
        if (!name || name === '[None]' || name === 'None') return '';
        
        // Se já é uma letra/número simples
        if (name.length === 1) {
            return 'Key' + name.toUpperCase();
        }
        
        // Verifica no mapa
        if (keyNameToCode[name]) {
            return keyNameToCode[name];
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
     * Handler de mouse click
     */
    function handleMouseDown(event) {
        if (!isEnabled) return;
        if (isInputFocused()) return;

        const button = event.button;

        // Verifica cada atalho de mouse
        if (mouseButtonMap[hotkeySettings.mouseStopExit] === button) {
            event.preventDefault();
            if (actions.stopExit) actions.stopExit();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mousePauseResume] === button) {
            event.preventDefault();
            if (actions.pauseResume) actions.pauseResume();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mouseScrollForward] === button) {
            event.preventDefault();
            if (actions.scrollForward) actions.scrollForward();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mouseScrollBackward] === button) {
            event.preventDefault();
            if (actions.scrollBackward) actions.scrollBackward();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mouseReverseScroll] === button) {
            event.preventDefault();
            if (actions.reverseScroll) actions.reverseScroll();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mousePreviousLine] === button) {
            event.preventDefault();
            if (actions.previousLine) actions.previousLine();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mouseNextLine] === button) {
            event.preventDefault();
            if (actions.nextLine) actions.nextLine();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mousePreviousCue] === button) {
            event.preventDefault();
            if (actions.previousCue) actions.previousCue();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mouseNextCue] === button) {
            event.preventDefault();
            if (actions.nextCue) actions.nextCue();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mouseJumpStart] === button) {
            event.preventDefault();
            if (actions.jumpStart) actions.jumpStart();
            return;
        }

        if (mouseButtonMap[hotkeySettings.mouseShowHideCue] === button) {
            event.preventDefault();
            if (actions.showHideCue) actions.showHideCue();
            return;
        }
    }

    /**
     * Handler de scroll do mouse
     */
    function handleWheel(event) {
        if (!isEnabled) return;
        if (isInputFocused()) return;

        const direction = event.deltaY > 0 ? 'scroll-down' : 'scroll-up';

        if (hotkeySettings.mouseScrollForward === direction) {
            event.preventDefault();
            if (actions.scrollForward) actions.scrollForward();
            return;
        }

        if (hotkeySettings.mouseScrollBackward === direction) {
            event.preventDefault();
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
        document.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('wheel', handleWheel, { passive: false });

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
        document.removeEventListener('mousedown', handleMouseDown);
        document.removeEventListener('wheel', handleWheel);
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
