// ============================================================
// === CORREÇÃO: preferences-module.js (SEM AUTO-SAVE)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const { ipcRenderer } = require('electron');

    // ============================================================
    // LISTENER PARA APLICAR TEMA (DARK/LIGHT)
    // ============================================================
    ipcRenderer.on('apply-theme', (event, theme) => {
        if (theme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
            document.body.classList.add('dark-mode');
        } else {
            document.documentElement.removeAttribute('data-theme');
            document.body.classList.remove('dark-mode');
        }
    });

    // === Seletores de TODOS os campos de Preferências ===
    // Style Settings
    const defaultFontInput = document.getElementById('default-font');
    const defaultFontSizeInput = document.getElementById('default-font-size');
    const defaultFontAttributesGroup = document.getElementById('default-font-attributes');
    const defaultFontColorInput = document.getElementById('default-font-color');
    const prompterFontScaleInput = document.getElementById('prompter-font-scale');
    const prompterScaleValueSpan = document.getElementById('prompter-scale-value'); 
    const prompterMarginInput = document.getElementById('prompter-margin');
    const lineSpacingInput = document.getElementById('line-spacing');
    const backgroundColorInput = document.getElementById('background-color');
    const cueColorInput = document.getElementById('cue-color');
    const cueTypeSelect = document.getElementById('cue-type');

    // Playback Settings
    const playbackTimerSelect = document.getElementById('playback-timer');
    const progressIndicatorCheck = document.getElementById('progress-indicator-check');
    const continuousLoopCheck = document.getElementById('continuous-loop-check');
    const accelerationLevelInput = document.getElementById('acceleration-level');
    const accelerationValueSpan = document.getElementById('acceleration-value');
    const overallSpeedInput = document.getElementById('overall-speed');
    const overallSpeedValueSpan = document.getElementById('overall-speed-value');

    // Debug: Verificar se checkboxes foram encontrados
    console.log("🔍 Checkboxes encontrados:");
    console.log("   progressIndicatorCheck:", progressIndicatorCheck);
    console.log("   continuousLoopCheck:", continuousLoopCheck);

    // Debug: Adiciona listener para ver quando checkbox muda
    if (progressIndicatorCheck) {
        progressIndicatorCheck.addEventListener('change', (e) => {
            console.log("🔄 Progress Indicator MUDOU para:", e.target.checked);
        });
    }
    if (continuousLoopCheck) {
        continuousLoopCheck.addEventListener('change', (e) => {
            console.log("🔄 Continuous Loop MUDOU para:", e.target.checked);
        });
    }

    // Display Settings
    const promptingWindowSelect = document.getElementById('prompting-window');
    const windowTransparencyInput = document.getElementById('window-transparency');
    const transparencyValueSpan = document.getElementById('transparency-value');
    const mirrorModeSelect = document.getElementById('mirror-mode');
    const hardwareSupportSelect = document.getElementById('hardware-support');

    // Controls Settings
    const keyStopExitInput = document.getElementById('key-stop-exit');
    const mousePauseResumeSelect = document.getElementById('mouse-pause-resume');
    const keyPauseResumeInput = document.getElementById('key-pause-resume');
    const keyScrollForwardInput = document.getElementById('key-scroll-forward');
    const mouseScrollForwardSelect = document.getElementById('mouse-scroll-forward');
    const keyScrollBackwardInput = document.getElementById('key-scroll-backward');
    const mouseScrollBackwardSelect = document.getElementById('mouse-scroll-backward');
    const keyReverseScrollInput = document.getElementById('key-reverse-scroll');
    const mouseReverseScrollSelect = document.getElementById('mouse-reverse-scroll');
    const keyPreviousLineInput = document.getElementById('key-previous-line');
    const keyNextLineInput = document.getElementById('key-next-line');
    const keyPreviousCueInput = document.getElementById('key-previous-cue');
    const keyNextCueInput = document.getElementById('key-next-cue');
    const keyJumpStartInput = document.getElementById('key-jump-start');
    const keyShowHideCueInput = document.getElementById('key-show-hide-cue');
    const mouseStopExitSelect = document.getElementById('mouse-stop-exit');
    const mousePreviousLineSelect = document.getElementById('mouse-previous-line');
    const mouseNextLineSelect = document.getElementById('mouse-next-line');
    const mousePreviousCueSelect = document.getElementById('mouse-previous-cue');
    const mouseNextCueSelect = document.getElementById('mouse-next-cue');
    const mouseJumpStartSelect = document.getElementById('mouse-jump-start');
    const mouseShowHideCueSelect = document.getElementById('mouse-show-hide-cue');

    // Standby Settings
    const customStandbyImageCheck = document.getElementById('custom-standby-image-check');
    const selectStandbyImageBtn = document.getElementById('select-standby-image-btn'); 
    const standbyImagePathInput = document.getElementById('standby-image-path'); 
    const standbyPathDisplay = document.getElementById('standby-path-display'); 
    const standbyPreviewDiv = document.getElementById('standby-preview-box'); 
    const standbyTimeoutSelect = document.getElementById('standby-timeout');

    // Auto Update Settings
    const autoUpdateCheck = document.getElementById('auto-update-check');
    const lastCheckSpan = document.getElementById('last-check-span');

    const defaultValuesBtn = document.getElementById('default-values-btn');
    const okBtn = document.getElementById('ok-btn');
    const cancelBtn = document.getElementById('cancel-btn');


    // ============================================================
    // ❌ REMOVIDO: Listeners que salvavam automaticamente
    // ✅ MANTIDO: Apenas listeners visuais (sliders, checkboxes B/I/U)
    // ============================================================

    // Lógica para toggle dos botões B/I/U (APENAS VISUAL - sem auto-save)
    if (defaultFontAttributesGroup) {
        defaultFontAttributesGroup.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', () => {
                const isActive = button.classList.toggle('active'); 
                
                if (isActive) {
                    button.classList.remove('btn-outline-secondary');
                    button.classList.add('btn-primary');
                } else {
                    button.classList.add('btn-outline-secondary');
                    button.classList.remove('btn-primary');
                }
            });
        });
    }
    
    // ============================================================
    // LISTENERS DE SLIDERS (APENAS ATUALIZAM O VALOR VISUAL)
    // ❌ NÃO SALVAM (ipcRenderer.send foi removido)
    // ============================================================
    
    if (prompterFontScaleInput && prompterScaleValueSpan) {
        prompterFontScaleInput.addEventListener('input', (e) => {
            prompterScaleValueSpan.textContent = `${e.target.value}%`;
            // ❌ REMOVIDO: ipcRenderer.send('save-settings', ...)
        });
    }
    
    if (overallSpeedInput && overallSpeedValueSpan) {
        overallSpeedInput.addEventListener('input', (e) => {
            overallSpeedValueSpan.textContent = `${e.target.value}%`;
            // ❌ REMOVIDO: ipcRenderer.send('save-settings', ...)
        });
    }

    if (accelerationLevelInput && accelerationValueSpan) {
        accelerationLevelInput.addEventListener('input', (e) => {
            accelerationValueSpan.textContent = `${e.target.value}%`;
            // ❌ REMOVIDO: ipcRenderer.send('save-settings', ...)
        });
    }

    if (windowTransparencyInput && transparencyValueSpan) {
        windowTransparencyInput.addEventListener('input', (e) => {
            transparencyValueSpan.textContent = `${e.target.value}%`;
            // ❌ REMOVIDO: ipcRenderer.send('save-settings', ...)
        });
    }

    // Função interna para aplicar a imagem no preview
    function applyStandbyImagePreview(path) {
        if (standbyPreviewDiv) {
            const textSpan = standbyPreviewDiv.querySelector('span');
            
            if (path) {
                standbyPreviewDiv.style.backgroundImage = `url("file://${path.replace(/\\/g, '/')}")`;
                standbyPreviewDiv.style.backgroundSize = 'contain';
                standbyPreviewDiv.style.backgroundRepeat = 'no-repeat';
                standbyPreviewDiv.style.backgroundPosition = 'center';
                standbyPreviewDiv.style.backgroundColor = 'transparent'; 
                if (textSpan) textSpan.style.display = 'none';
            } else {
                standbyPreviewDiv.style.backgroundImage = 'none';
                standbyPreviewDiv.style.backgroundColor = '#343a40';
                if (textSpan) textSpan.style.display = 'block'; 
            }
        }
    }

    // Lógica Específica da Aba Standby
    if (selectStandbyImageBtn) {
        selectStandbyImageBtn.addEventListener('click', () => {
            ipcRenderer.send('open-standby-image-dialog');
        });
    }

    // Receptor do caminho da imagem selecionada (do main.js)
    ipcRenderer.on('standby-image-selected', (event, filePath) => {
        if (standbyImagePathInput) standbyImagePathInput.value = filePath;
        if (standbyPathDisplay) standbyPathDisplay.textContent = filePath;
        if (customStandbyImageCheck) customStandbyImageCheck.checked = true;
        applyStandbyImagePreview(filePath);
    });
    
    // Adiciona listener para o checkbox
    if (customStandbyImageCheck) {
        customStandbyImageCheck.addEventListener('change', () => {
            if (!customStandbyImageCheck.checked) {
                if (standbyImagePathInput) standbyImagePathInput.value = '';
                if (standbyPathDisplay) standbyPathDisplay.textContent = '(Nenhuma imagem selecionada)';
                applyStandbyImagePreview(null);
            }
        });
    }

    // ============================================================
    // FUNÇÃO: Coletar e SALVAR (APENAS NO BOTÃO OK)
    // ============================================================
    function saveAndApplySettings() {
        try {
            console.log("🔍 Botão OK clicado - iniciando salvamento...");
            
            const collectedAttributes = defaultFontAttributesGroup 
                ? Array.from(defaultFontAttributesGroup.querySelectorAll('.btn.active'))
                    .map(btn => btn.getAttribute('data-attr'))
                    .filter(attr => attr !== null)
                : [];

            // Lê os checkboxes diretamente do DOM para garantir valores corretos
            const progressCheck = document.getElementById('progress-indicator-check');
            const loopCheck = document.getElementById('continuous-loop-check');
            
            console.log("🔍 Lendo checkboxes diretamente:");
            console.log("   progress-indicator-check:", progressCheck, "checked:", progressCheck?.checked);
            console.log("   continuous-loop-check:", loopCheck, "checked:", loopCheck?.checked);

            const settings = {
                // Style Settings
                defaultFont: defaultFontInput ? defaultFontInput.value : 'Arial',
                defaultFontSize: defaultFontSizeInput ? parseInt(defaultFontSizeInput.value) : 12,
                defaultFontAttributes: collectedAttributes, 
                defaultFontColor: defaultFontColorInput ? defaultFontColorInput.value : '#FFFFFF',
                prompterFontScale: prompterFontScaleInput ? parseInt(prompterFontScaleInput.value) : 30,
                prompterMargin: prompterMarginInput ? parseInt(prompterMarginInput.value) : 40,
                lineSpacing: lineSpacingInput ? parseFloat(lineSpacingInput.value) : 1.5,
                backgroundColor: backgroundColorInput ? backgroundColorInput.value : '#000000',
                cueColor: cueColorInput ? cueColorInput.value : '#00FF00',
                cueType: cueTypeSelect ? cueTypeSelect.value : 'arrow',

                // Playback Settings
                overallSpeed: overallSpeedInput ? parseInt(overallSpeedInput.value) : 50,
                playbackTimer: playbackTimerSelect ? playbackTimerSelect.value : 'off',
                showProgressIndicator: progressCheck ? progressCheck.checked : false,
                continuousLoop: loopCheck ? loopCheck.checked : false,
                accelerationLevel: accelerationLevelInput ? parseInt(accelerationLevelInput.value) : 50,

                // Display Settings
                mirrorMode: mirrorModeSelect ? mirrorModeSelect.value : 'none',
                promptingWindow: promptingWindowSelect ? promptingWindowSelect.value : 'dual-screen',
                windowTransparency: windowTransparencyInput ? parseInt(windowTransparencyInput.value) : 0,
                hardwareSupport: hardwareSupportSelect ? hardwareSupportSelect.value : 'opengl',

                // Controls Settings
                keyStopExit: keyStopExitInput ? keyStopExitInput.value : 'Esc',
                keyPauseResume: keyPauseResumeInput ? keyPauseResumeInput.value : 'Space',
                keyScrollForward: keyScrollForwardInput ? keyScrollForwardInput.value : 'Down',
                keyScrollBackward: keyScrollBackwardInput ? keyScrollBackwardInput.value : 'Up',
                keyReverseScroll: keyReverseScrollInput ? keyReverseScrollInput.value : 'Backspace',
                keyPreviousLine: keyPreviousLineInput ? keyPreviousLineInput.value : '[',
                keyNextLine: keyNextLineInput ? keyNextLineInput.value : ']',
                keyPreviousCue: keyPreviousCueInput ? keyPreviousCueInput.value : 'Left',
                keyNextCue: keyNextCueInput ? keyNextCueInput.value : 'Right',
                keyJumpStart: keyJumpStartInput ? keyJumpStartInput.value : 'Home',
                keyShowHideCue: keyShowHideCueInput ? keyShowHideCueInput.value : '[None]',
                mouseStopExit: mouseStopExitSelect ? mouseStopExitSelect.value : 'none',
                mousePauseResume: mousePauseResumeSelect ? mousePauseResumeSelect.value : 'left-click',
                mouseScrollForward: mouseScrollForwardSelect ? mouseScrollForwardSelect.value : 'scroll-wheel-down',
                mouseScrollBackward: mouseScrollBackwardSelect ? mouseScrollBackwardSelect.value : 'scroll-wheel-up',
                mouseReverseScroll: mouseReverseScrollSelect ? mouseReverseScrollSelect.value : 'right-click',
                mousePreviousLine: mousePreviousLineSelect ? mousePreviousLineSelect.value : 'none',
                mouseNextLine: mouseNextLineSelect ? mouseNextLineSelect.value : 'none',
                mousePreviousCue: mousePreviousCueSelect ? mousePreviousCueSelect.value : 'none',
                mouseNextCue: mouseNextCueSelect ? mouseNextCueSelect.value : 'none',
                mouseJumpStart: mouseJumpStartSelect ? mouseJumpStartSelect.value : 'none',
                mouseShowHideCue: mouseShowHideCueSelect ? mouseShowHideCueSelect.value : 'none',
                
                // Standby Settings
                useCustomStandbyImage: customStandbyImageCheck ? customStandbyImageCheck.checked : false,
                standbyImagePath: standbyImagePathInput ? standbyImagePathInput.value : null,
                standbyTimeout: standbyTimeoutSelect ? parseInt(standbyTimeoutSelect.value) : 5,

                // Auto Update Settings
                autoCheckForUpdates: autoUpdateCheck ? autoUpdateCheck.checked : true,
            };

            console.log("💾 Valores a salvar - showProgressIndicator:", settings.showProgressIndicator, "continuousLoop:", settings.continuousLoop);
            console.log("💾 Standby - useCustom:", settings.useCustomStandbyImage, "path:", settings.standbyImagePath, "timeout:", settings.standbyTimeout);
            ipcRenderer.send('save-settings', settings);
            console.log("✅ Settings enviadas, fechando janela...");
            window.close();
        } catch (error) {
            console.error("❌ Erro ao salvar preferências:", error);
            // Tenta fechar mesmo com erro
            window.close();
        }
    }
    
    // ============================================================
    // FUNÇÃO: Carregar as configurações (Preenche o modal)
    // ============================================================
    function loadSettings(settings) {
        if (!settings) return;

        // Style Settings
        if (defaultFontInput) defaultFontInput.value = settings.defaultFont || 'Arial';
        if (defaultFontSizeInput) defaultFontSizeInput.value = settings.defaultFontSize || 12;
        if (defaultFontColorInput) defaultFontColorInput.value = settings.defaultFontColor || '#FFFFFF';
        if (prompterFontScaleInput) {
            prompterFontScaleInput.value = settings.prompterFontScale || 30;
            if (prompterScaleValueSpan) prompterScaleValueSpan.textContent = `${prompterFontScaleInput.value}%`;
        }
        if (prompterMarginInput) prompterMarginInput.value = settings.prompterMargin || 40;
        if (lineSpacingInput) lineSpacingInput.value = settings.lineSpacing || 1.5;
        if (backgroundColorInput) backgroundColorInput.value = settings.backgroundColor || '#000000';
        if (cueColorInput) cueColorInput.value = settings.cueColor || '#00FF00';
        if (cueTypeSelect) cueTypeSelect.value = settings.cueType || 'arrow';
        
        // Atributos B/I/U
        const attributes = settings.defaultFontAttributes || [];
        if (defaultFontAttributesGroup) {
            defaultFontAttributesGroup.querySelectorAll('button').forEach(button => {
                const attr = button.getAttribute('data-attr');
                const isActive = attributes.includes(attr);
                button.classList.toggle('active', isActive);
                button.classList.toggle('btn-primary', isActive);
                button.classList.toggle('btn-outline-secondary', !isActive);
            });
        }
        
        // Playback Settings
        if (overallSpeedInput) {
            overallSpeedInput.value = settings.overallSpeed || 50;
            if (overallSpeedValueSpan) overallSpeedValueSpan.textContent = `${overallSpeedInput.value}%`;
        }
        if (accelerationLevelInput) {
            accelerationLevelInput.value = settings.accelerationLevel || 50;
            if (accelerationValueSpan) accelerationValueSpan.textContent = `${accelerationLevelInput.value}%`;
        }
        if (playbackTimerSelect) playbackTimerSelect.value = settings.playbackTimer || 'off';
        
        // Checkboxes - força marcação com dispatchEvent para Bootstrap
        const progressCheck = document.getElementById('progress-indicator-check');
        const loopCheck = document.getElementById('continuous-loop-check');
        
        if (progressCheck) {
            const shouldBeChecked = settings.showProgressIndicator === true;
            // Primeiro, desmarca
            progressCheck.checked = false;
            // Depois, se deve estar marcado, marca
            if (shouldBeChecked) {
                progressCheck.checked = true;
            }
            // Dispara evento de change para atualizar visual
            progressCheck.dispatchEvent(new Event('change', { bubbles: true }));
            console.log("✅ Progress Indicator setado para:", progressCheck.checked, "(valor recebido:", settings.showProgressIndicator, ")");
        }
        if (loopCheck) {
            const shouldBeChecked = settings.continuousLoop === true;
            // Primeiro, desmarca
            loopCheck.checked = false;
            // Depois, se deve estar marcado, marca
            if (shouldBeChecked) {
                loopCheck.checked = true;
            }
            // Dispara evento de change para atualizar visual
            loopCheck.dispatchEvent(new Event('change', { bubbles: true }));
            console.log("✅ Continuous Loop setado para:", loopCheck.checked, "(valor recebido:", settings.continuousLoop, ")");
        }
        
        // Display Settings
        if (mirrorModeSelect) mirrorModeSelect.value = settings.mirrorMode || 'none';
        if (promptingWindowSelect) promptingWindowSelect.value = settings.promptingWindow || 'dual-screen';
        if (windowTransparencyInput) {
            windowTransparencyInput.value = settings.windowTransparency || 0;
            if (transparencyValueSpan) transparencyValueSpan.textContent = `${windowTransparencyInput.value}%`;
        }
        if (hardwareSupportSelect) hardwareSupportSelect.value = settings.hardwareSupport || 'opengl';

        // Controls Settings
        if (keyStopExitInput) keyStopExitInput.value = settings.keyStopExit || 'Esc';
        if (keyPauseResumeInput) keyPauseResumeInput.value = settings.keyPauseResume || 'Space';
        if (keyScrollForwardInput) keyScrollForwardInput.value = settings.keyScrollForward || 'Down';
        if (keyScrollBackwardInput) keyScrollBackwardInput.value = settings.keyScrollBackward || 'Up';
        if (keyReverseScrollInput) keyReverseScrollInput.value = settings.keyReverseScroll || 'Backspace';
        if (keyPreviousLineInput) keyPreviousLineInput.value = settings.keyPreviousLine || '[';
        if (keyNextLineInput) keyNextLineInput.value = settings.keyNextLine || ']';
        if (keyPreviousCueInput) keyPreviousCueInput.value = settings.keyPreviousCue || 'Left';
        if (keyNextCueInput) keyNextCueInput.value = settings.keyNextCue || 'Right';
        if (keyJumpStartInput) keyJumpStartInput.value = settings.keyJumpStart || 'Home';
        if (keyShowHideCueInput) keyShowHideCueInput.value = settings.keyShowHideCue || '[None]';
        if (mouseStopExitSelect) mouseStopExitSelect.value = settings.mouseStopExit || 'none';
        if (mousePauseResumeSelect) mousePauseResumeSelect.value = settings.mousePauseResume || 'left-click';
        if (mouseScrollForwardSelect) mouseScrollForwardSelect.value = settings.mouseScrollForward || 'scroll-wheel-down';
        if (mouseScrollBackwardSelect) mouseScrollBackwardSelect.value = settings.mouseScrollBackward || 'scroll-wheel-up';
        if (mouseReverseScrollSelect) mouseReverseScrollSelect.value = settings.mouseReverseScroll || 'right-click';
        if (mousePreviousLineSelect) mousePreviousLineSelect.value = settings.mousePreviousLine || 'none';
        if (mouseNextLineSelect) mouseNextLineSelect.value = settings.mouseNextLine || 'none';
        if (mousePreviousCueSelect) mousePreviousCueSelect.value = settings.mousePreviousCue || 'none';
        if (mouseNextCueSelect) mouseNextCueSelect.value = settings.mouseNextCue || 'none';
        if (mouseJumpStartSelect) mouseJumpStartSelect.value = settings.mouseJumpStart || 'none';
        if (mouseShowHideCueSelect) mouseShowHideCueSelect.value = settings.mouseShowHideCue || 'none';
        
        // Standby Settings
        const path = settings.standbyImagePath;
        if (customStandbyImageCheck) customStandbyImageCheck.checked = settings.useCustomStandbyImage || false;
        if (standbyImagePathInput) standbyImagePathInput.value = path || '';
        if (standbyPathDisplay) {
            standbyPathDisplay.textContent = path ? path : '(Nenhuma imagem selecionada)';
        }
        if (standbyTimeoutSelect) standbyTimeoutSelect.value = settings.standbyTimeout || 5;
        applyStandbyImagePreview(path); 

        // Auto Update Settings
        if (autoUpdateCheck) {
            autoUpdateCheck.checked = settings.autoCheckForUpdates || true;
            console.log("✅ Auto Update marcado?", autoUpdateCheck.checked);
        }
        // Last Update Check - carrega data salva
        if (lastCheckSpan) {
            if (settings.lastUpdateCheck) {
                lastCheckSpan.textContent = new Date(settings.lastUpdateCheck).toLocaleString('pt-BR');
            } else {
                lastCheckSpan.textContent = 'Nunca';
            }
        }

        updateCheckboxVisuals();
    }
    
    // ============================================================
    // FUNÇÃO: Atualiza visual dos checkboxes
    // ============================================================
    function updateCheckboxVisuals() {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        
        checkboxes.forEach(checkbox => {
            if (checkbox.checked) {
                checkbox.classList.add('checked');
                const label = checkbox.closest('label');
                if (label) label.classList.add('checked');
            } else {
                checkbox.classList.remove('checked');
                const label = checkbox.closest('label');
                if (label) label.classList.remove('checked');
            }
        });
        
        console.log("🎨 Visual dos checkboxes atualizado");
    }
    
    // ============================================================
    // FUNÇÃO: Resetar aos valores padrão
    // ============================================================
    function loadDefaultSettings() {
        const defaultSettings = {
            defaultFont: 'Arial', defaultFontSize: 12, defaultFontAttributes: [], 
            defaultFontColor: '#FFFFFF', prompterFontScale: 30, prompterMargin: 40,
            lineSpacing: 1.5, backgroundColor: '#000000', cueColor: '#00FF00', 
            cueType: 'arrow', 
            overallSpeed: 50, playbackTimer: 'off', showProgressIndicator: false, continuousLoop: false, accelerationLevel: 50,
            mirrorMode: 'none', promptingWindow: 'dual-screen', windowTransparency: 0, hardwareSupport: 'opengl',
            keyStopExit: 'Esc', keyPauseResume: 'Space', keyScrollForward: 'Down', keyScrollBackward: 'Up', keyReverseScroll: 'Backspace', keyPreviousLine: '[', keyNextLine: ']', keyPreviousCue: 'Left', keyNextCue: 'Right', keyJumpStart: 'Home', keyShowHideCue: '[None]',
            mouseStopExit: 'none', mousePauseResume: 'left-click', mouseScrollForward: 'scroll-wheel-down', mouseScrollBackward: 'scroll-wheel-up', mouseReverseScroll: 'right-click', mousePreviousLine: 'none', mouseNextLine: 'none', mousePreviousCue: 'none', mouseNextCue: 'none', mouseJumpStart: 'none', mouseShowHideCue: 'none',
            useCustomStandbyImage: false,
            standbyImagePath: null, 
            autoCheckForUpdates: true, lastCheckDate: '14 de out. de 2025 09:03:20'
        };
        loadSettings(defaultSettings);
    }

    // ============================================================
    // LISTENERS (APENAS OK, CANCEL E DEFAULT)
    // ============================================================

    console.log("🔧 Registrando listeners...");
    console.log("   okBtn encontrado?", okBtn);
    console.log("   cancelBtn encontrado?", cancelBtn);
    console.log("   defaultValuesBtn encontrado?", defaultValuesBtn);

    if (okBtn) { 
        okBtn.addEventListener('click', () => {
            console.log("✅ Botão OK clicado!");
            saveAndApplySettings();
        }); 
        console.log("✅ Listener do OK registrado");
    } else {
        console.error("❌ okBtn não encontrado!");
    }
    
    if (cancelBtn) { 
        cancelBtn.addEventListener('click', () => { window.close(); }); 
    }
    
    if (defaultValuesBtn) { 
        defaultValuesBtn.addEventListener('click', loadDefaultSettings); 
    }

    // ============================================================
    // AUTO-UPDATE: Botão "Check Now"
    // ============================================================
    const checkNowBtn = document.getElementById('check-now-btn');
    // lastCheckSpan já declarado no topo do arquivo (linha 101)
    
    if (checkNowBtn) {
        checkNowBtn.addEventListener('click', () => {
            // Feedback visual - botão em loading
            const originalText = checkNowBtn.textContent;
            checkNowBtn.disabled = true;
            checkNowBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Checking...';
            
            // Envia comando para main process
            ipcRenderer.send('check-for-updates');
            
            // Atualiza data do último check e salva
            const now = new Date().toISOString();
            if (lastCheckSpan) {
                lastCheckSpan.textContent = new Date(now).toLocaleString('pt-BR');
            }
            // Salva a data nas configurações
            ipcRenderer.send('save-setting', { key: 'lastUpdateCheck', value: now });
        });
    }
    
    // Listener para resultado da verificação de updates
    ipcRenderer.on('update-check-result', (event, result) => {
        console.log('[AutoUpdater] Resultado:', result);
        
        // Restaura botão
        if (checkNowBtn) {
            checkNowBtn.disabled = false;
            checkNowBtn.textContent = 'Check Now';
        }
        
        // Exibe resultado com alert colorido
        let alertClass = 'alert-info';
        let icon = 'bi-info-circle';
        
        if (result.status === 'available') {
            alertClass = 'alert-success';
            icon = 'bi-arrow-down-circle';
        } else if (result.status === 'up-to-date') {
            alertClass = 'alert-primary';
            icon = 'bi-check-circle';
        } else if (result.status === 'error') {
            alertClass = 'alert-danger';
            icon = 'bi-exclamation-triangle';
        } else if (result.status === 'dev-mode') {
            alertClass = 'alert-warning';
            icon = 'bi-tools';
        }
        
        // Remove alert anterior se existir
        const existingAlert = document.getElementById('update-result-alert');
        if (existingAlert) existingAlert.remove();
        
        // Cria novo alert
        const alertDiv = document.createElement('div');
        alertDiv.id = 'update-result-alert';
        alertDiv.className = `alert ${alertClass} d-flex align-items-center mx-5 mt-3`;
        alertDiv.innerHTML = `
            <i class="bi ${icon} me-2"></i>
            <span>${result.message}</span>
        `;
        
        // Insere após o botão Check Now
        const checkNowContainer = checkNowBtn?.parentElement;
        if (checkNowContainer) {
            checkNowContainer.parentElement.insertBefore(alertDiv, checkNowContainer.nextSibling);
            
            // Remove após 8 segundos
            setTimeout(() => alertDiv.remove(), 8000);
        }
    });

    // Listener para receber configurações do Main
    ipcRenderer.on('load-settings', (event, settings) => {
        console.log("📥 Recebendo settings do Main:", JSON.stringify(settings));
        console.log("📥 showProgressIndicator:", settings.showProgressIndicator);
        console.log("📥 continuousLoop:", settings.continuousLoop);
        
        // Pequeno delay para garantir que o DOM está pronto
        setTimeout(() => {
            loadSettings(settings);
            
            // Força marcação dos checkboxes novamente após loadSettings
            const progressCheck = document.getElementById('progress-indicator-check');
            const loopCheck = document.getElementById('continuous-loop-check');
            
            if (progressCheck && settings.showProgressIndicator === true) {
                progressCheck.checked = true;
                console.log("🔧 Forçando Progress Indicator para TRUE");
            }
            if (loopCheck && settings.continuousLoop === true) {
                loopCheck.checked = true;
                console.log("🔧 Forçando Continuous Loop para TRUE");
            }
            
            console.log("✅ Settings carregadas com sucesso");
        }, 100);
    });

}); // Fim do DOMContentLoaded