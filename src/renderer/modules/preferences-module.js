// ============================================================
// === CORREÇÃO: preferences-module.js (SEM AUTO-SAVE)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const { ipcRenderer } = require('electron');

  // ============================================================
  // LISTENER PARA APLICAR TEMA (DARK/LIGHT)
  // ============================================================
  function applyTheme(theme) {
    console.log('🎨 Aplicando tema:', theme);
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.classList.add('dark-mode');
    } else {
      document.documentElement.removeAttribute('data-theme');
      document.body.classList.remove('dark-mode');
    }
  }

  ipcRenderer.on('apply-theme', (event, theme) => {
    applyTheme(theme);
  });

  // Solicita o tema atual ao main process imediatamente
  ipcRenderer.send('request-current-theme');

  ipcRenderer.on('current-theme', (event, theme) => {
    applyTheme(theme);
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
  const fontWeightBoostCheck = document.getElementById('font-weight-boost-check');
  const backgroundColorInput = document.getElementById('background-color');
  const cueColorInput = document.getElementById('cue-color');

  // Mantém snapshot das settings carregadas — campos ausentes no HTML
  // (ex.: default-font-size) não devem ser sobrescritos com fallback 12 ao salvar.
  let _lastLoadedSettings = {};
  const cueTypeSelect = document.getElementById('cue-type');

  // Playback Settings
  const playbackTimerSelect = document.getElementById('playback-timer');
  const progressIndicatorCheck = document.getElementById('progress-indicator-check');
  const progressThumbColorInput = document.getElementById('progress-thumb-color');
  const showCueMarkerCheck = document.getElementById('show-cue-marker-check');
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

  // Opções padrão de mouse (paridade com PromptDog / referência)
  const MOUSE_COMMAND_OPTIONS = [
    { value: 'none', label: 'None' },
    { value: 'left-click', label: 'Left-Click' },
    { value: 'right-click', label: 'Right-Click' },
    { value: 'scroll-wheel-down', label: 'Scroll-Wheel Down' },
    { value: 'scroll-wheel-up', label: 'Scroll-Wheel Up' },
  ];

  function populateMouseSelect(selectEl, savedValue) {
    if (!selectEl) return;
    const current = savedValue || selectEl.value || 'none';
    selectEl.innerHTML = '';
    MOUSE_COMMAND_OPTIONS.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    });
    selectEl.value = MOUSE_COMMAND_OPTIONS.some((o) => o.value === current) ? current : 'none';
  }

  const allMouseSelects = [
    mouseStopExitSelect, mousePauseResumeSelect, mouseScrollForwardSelect,
    mouseScrollBackwardSelect, mouseReverseScrollSelect, mousePreviousLineSelect,
    mouseNextLineSelect, mousePreviousCueSelect, mouseNextCueSelect,
    mouseJumpStartSelect, mouseShowHideCueSelect,
  ];
  allMouseSelects.forEach((sel) => populateMouseSelect(sel));

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

  // Versão do app na aba Activate
  const appVersionSpan = document.getElementById('app-version-span');
  if (appVersionSpan) {
    ipcRenderer.invoke('get-app-version').then(v => {
      appVersionSpan.textContent = v || '—';
    }).catch(() => {});
  }

  const defaultValuesBtn = document.getElementById('default-values-btn');
  const controlsDefaultsBtn = document.getElementById('controls-defaults-btn');
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
  // KEY CAPTURE — Modal de captura de tecla para a aba Controls
  // ============================================================
  // Ao clicar num input cujo id começa com "key-", abre um modal
  // que captura a próxima tecla pressionada e grava no input.
  // Esc cancela. Delete limpa (grava [None]).
  // ============================================================
  (function setupKeyCapture() {
    const modal   = document.getElementById('key-capture-modal');
    const display = document.getElementById('key-capture-display');
    if (!modal || !display) return;

    let targetInput = null;

    // Converte um KeyboardEvent em nome amigável compatível com hotkey-handler.js
    function eventToFriendlyName(ev) {
      const code = ev.code;
      const key  = ev.key;

      // Ignora teclas só de modificador pressionadas sozinhas
      if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
        return null;
      }

      const map = {
        Escape:      'Esc',
        Space:       'Space',
        Enter:       'Enter',
        Tab:         'Tab',
        Backspace:   'Backspace',
        Delete:      'Delete',
        Home:        'Home',
        End:         'End',
        PageUp:      'PageUp',
        PageDown:    'PageDown',
        ArrowUp:     'Up',
        ArrowDown:   'Down',
        ArrowLeft:   'Left',
        ArrowRight:  'Right',
        BracketLeft: '[',
        BracketRight:']',
        Semicolon:   ';',
        Quote:       "'",
        Comma:       ',',
        Period:      '.',
        Slash:       '/',
        Backslash:   '\\',
        Minus:       '-',
        Equal:       '=',
        Backquote:   '`'
      };
      if (map[code]) return map[code];
      if (/^F\d{1,2}$/.test(code)) return code;           // F1..F12
      if (/^Key[A-Z]$/.test(code))   return code.slice(3); // KeyA -> A
      if (/^Digit\d$/.test(code))    return code.slice(5); // Digit1 -> 1
      if (/^Numpad\d$/.test(code))   return 'Num' + code.slice(6);
      // Fallback: usa event.key em maiúscula
      return key.length === 1 ? key.toUpperCase() : key;
    }

    function captureKeyHandler(ev) {
      ev.preventDefault();
      ev.stopPropagation();

      // Cancelar
      if (ev.key === 'Escape') {
        closeCapture();
        return;
      }

      // Limpar (Delete = [None])
      if (ev.key === 'Delete') {
        if (targetInput) {
          targetInput.value = '[None]';
          targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        display.textContent = '[None]';
        setTimeout(closeCapture, 220);
        return;
      }

      const name = eventToFriendlyName(ev);
      if (!name) return;

      if (targetInput) {
        targetInput.value = name;
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      display.textContent = name;
      setTimeout(closeCapture, 220);
    }

    function openCapture(input) {
      targetInput = input;
      display.textContent = '…';
      modal.hidden = false;
      document.addEventListener('keydown', captureKeyHandler, true);
    }

    function closeCapture() {
      modal.hidden = true;
      document.removeEventListener('keydown', captureKeyHandler, true);
      if (targetInput) {
        targetInput.blur();
        targetInput = null;
      }
    }

    // Delegação: qualquer clique/focus em input cujo id começa com "key-"
    function isKeyField(el) {
      return el && el.tagName === 'INPUT'
          && typeof el.id === 'string'
          && el.id.startsWith('key-');
    }

    document.addEventListener('mousedown', (e) => {
      if (isKeyField(e.target)) {
        e.preventDefault();
        openCapture(e.target);
      }
    });

    document.addEventListener('focusin', (e) => {
      if (isKeyField(e.target) && modal.hidden) {
        openCapture(e.target);
      }
    });

    // Clique no fundo escuro cancela
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeCapture();
    });
  })();

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
        if (standbyPathDisplay) standbyPathDisplay.textContent = '(No image selected)';
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
        // Preserva tudo que já estava salvo (tamanho de fonte da sessão, etc.)
        ..._lastLoadedSettings,

        // Style Settings — só sobrescreve campos que existem no formulário
        ...(defaultFontInput && { defaultFont: defaultFontInput.value }),
        ...(defaultFontSizeInput && {
          defaultFontSize: parseInt(defaultFontSizeInput.value, 10) || _lastLoadedSettings.defaultFontSize || 12,
        }),
        ...(defaultFontAttributesGroup && { defaultFontAttributes: collectedAttributes }),
        ...(defaultFontColorInput && { defaultFontColor: defaultFontColorInput.value }),
        ...(prompterFontScaleInput && {
          prompterFontScale: parseInt(prompterFontScaleInput.value, 10) || 100,
        }),
        ...(prompterMarginInput && {
          prompterMargin: parseInt(prompterMarginInput.value, 10) || 40,
        }),
        ...(lineSpacingInput && { lineSpacing: parseFloat(lineSpacingInput.value) || 1.5 }),
        ...(fontWeightBoostCheck && { fontWeightBoost: fontWeightBoostCheck.checked }),
        ...(backgroundColorInput && { backgroundColor: backgroundColorInput.value }),
        ...(cueColorInput && { cueColor: cueColorInput.value }),
        ...(cueTypeSelect && { cueType: cueTypeSelect.value }),

        // Playback Settings
        overallSpeed: overallSpeedInput ? parseInt(overallSpeedInput.value) : 50,
        playbackTimer: playbackTimerSelect ? playbackTimerSelect.value : 'off',
        showProgressIndicator: progressCheck ? progressCheck.checked : false,
        progressThumbColor: document.getElementById('progress-thumb-color')?.value || '#FFFFFF',
        showCueMarker: document.getElementById('show-cue-marker-check')?.checked !== false,
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

    _lastLoadedSettings = { ...settings };

    // Style Settings
    if (defaultFontInput) defaultFontInput.value = settings.defaultFont || 'Arial';
    if (defaultFontSizeInput) defaultFontSizeInput.value = settings.defaultFontSize || 12;
    if (defaultFontColorInput) defaultFontColorInput.value = settings.defaultFontColor || '#FFFFFF';
    if (prompterFontScaleInput) {
      const savedScale = settings.prompterFontScale === 30 ? 100 : (settings.prompterFontScale || 100);
      const hasSavedOption = Array.from(prompterFontScaleInput.options)
        .some(option => Number(option.value) === Number(savedScale));
      if (!hasSavedOption) {
        const savedOption = document.createElement('option');
        savedOption.value = savedScale;
        savedOption.textContent = `${savedScale}%`;
        prompterFontScaleInput.appendChild(savedOption);
      }
      prompterFontScaleInput.value = savedScale;
      if (prompterScaleValueSpan) prompterScaleValueSpan.textContent = `${savedScale}%`;
    }
    if (prompterMarginInput) prompterMarginInput.value = settings.prompterMargin || 40;
    if (lineSpacingInput) lineSpacingInput.value = settings.lineSpacing || 1.5;
    if (fontWeightBoostCheck) {
      fontWeightBoostCheck.checked = settings.fontWeightBoost !== false;
    }
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

    // Progress Thumb Color
    const progressThumbColor = document.getElementById('progress-thumb-color');
    if (progressThumbColor) {
      progressThumbColor.value = settings.progressThumbColor || '#FFFFFF';
    }

    // Show Cue Marker checkbox
    const showCueMarkerCheckbox = document.getElementById('show-cue-marker-check');
    if (showCueMarkerCheckbox) {
      showCueMarkerCheckbox.checked = settings.showCueMarker !== false;
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
    applyControlsSettingsToForm(settings);

    // Standby Settings
    const path = settings.standbyImagePath;
    if (customStandbyImageCheck) customStandbyImageCheck.checked = settings.useCustomStandbyImage || false;
    if (standbyImagePathInput) standbyImagePathInput.value = path || '';
    if (standbyPathDisplay) {
      standbyPathDisplay.textContent = path ? path : '(No image selected)';
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
        lastCheckSpan.textContent = new Date(settings.lastUpdateCheck).toLocaleString('en-US');
      } else {
        lastCheckSpan.textContent = 'Never';
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
  // Valores de fábrica — Controls (aba Controls)
  // ============================================================
  const FACTORY_CONTROLS = {
    keyStopExit: 'Esc',
    keyPauseResume: 'Space',
    keyScrollForward: 'Down',
    keyScrollBackward: 'Up',
    keyReverseScroll: 'Backspace',
    keyPreviousLine: '[',
    keyNextLine: ']',
    keyPreviousCue: 'Left',
    keyNextCue: 'Right',
    keyJumpStart: 'Home',
    keyShowHideCue: '[None]',
    mouseStopExit: 'none',
    mousePauseResume: 'left-click',
    mouseScrollForward: 'scroll-wheel-down',
    mouseScrollBackward: 'scroll-wheel-up',
    mouseReverseScroll: 'right-click',
    mousePreviousLine: 'none',
    mouseNextLine: 'none',
    mousePreviousCue: 'none',
    mouseNextCue: 'none',
    mouseJumpStart: 'none',
    mouseShowHideCue: 'none',
  };

  const CONTROL_SETTING_KEYS = Object.keys(FACTORY_CONTROLS);

  function applyControlsSettingsToForm(settings) {
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
    if (mouseStopExitSelect) populateMouseSelect(mouseStopExitSelect, settings.mouseStopExit || 'none');
    if (mousePauseResumeSelect) populateMouseSelect(mousePauseResumeSelect, settings.mousePauseResume || 'left-click');
    if (mouseScrollForwardSelect) populateMouseSelect(mouseScrollForwardSelect, settings.mouseScrollForward || 'scroll-wheel-down');
    if (mouseScrollBackwardSelect) populateMouseSelect(mouseScrollBackwardSelect, settings.mouseScrollBackward || 'scroll-wheel-up');
    if (mouseReverseScrollSelect) populateMouseSelect(mouseReverseScrollSelect, settings.mouseReverseScroll || 'right-click');
    if (mousePreviousLineSelect) populateMouseSelect(mousePreviousLineSelect, settings.mousePreviousLine || 'none');
    if (mouseNextLineSelect) populateMouseSelect(mouseNextLineSelect, settings.mouseNextLine || 'none');
    if (mousePreviousCueSelect) populateMouseSelect(mousePreviousCueSelect, settings.mousePreviousCue || 'none');
    if (mouseNextCueSelect) populateMouseSelect(mouseNextCueSelect, settings.mouseNextCue || 'none');
    if (mouseJumpStartSelect) populateMouseSelect(mouseJumpStartSelect, settings.mouseJumpStart || 'none');
    if (mouseShowHideCueSelect) populateMouseSelect(mouseShowHideCueSelect, settings.mouseShowHideCue || 'none');
  }

  function pickControlSettings(source) {
    const picked = {};
    CONTROL_SETTING_KEYS.forEach((key) => {
      if (source && source[key] !== undefined) picked[key] = source[key];
    });
    return picked;
  }

  /** Restaura só a aba Controls (botão "Defaults" dentro da aba). */
  function loadDefaultControlsSettings() {
    _lastLoadedSettings = { ..._lastLoadedSettings, ...FACTORY_CONTROLS };
    applyControlsSettingsToForm(FACTORY_CONTROLS);
  }

  /** Restaura Style, Playback, Display, Standby etc. — preserva Controls. */
  function loadDefaultSettings() {
    const preservedControls = pickControlSettings(_lastLoadedSettings);

    const defaultSettings = {
      defaultFont: 'Arial',
      defaultFontSize: 12,
      defaultFontAttributes: [],
      defaultFontColor: '#FFFFFF',
      prompterFontScale: 30,
      prompterMargin: 40,
      lineSpacing: 1.5,
      fontWeightBoost: true,
      backgroundColor: '#000000',
      cueColor: '#00FF00',
      cueType: 'arrow',
      overallSpeed: 50,
      playbackTimer: 'off',
      showProgressIndicator: false,
      progressThumbColor: '#FFFFFF',
      showCueMarker: true,
      continuousLoop: false,
      accelerationLevel: 50,
      mirrorMode: 'none',
      promptingWindow: 'dual-screen',
      windowTransparency: 0,
      hardwareSupport: 'opengl',
      useCustomStandbyImage: false,
      standbyImagePath: null,
      standbyTimeout: 5,
      autoCheckForUpdates: true,
      ...preservedControls,
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
    defaultValuesBtn.addEventListener('click', (e) => {
      e.preventDefault();
      loadDefaultSettings();
    });
  }

  if (controlsDefaultsBtn) {
    controlsDefaultsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      loadDefaultControlsSettings();
    });
  }

  // ============================================================
  // AUTO-UPDATE: Botão "Check Now"
  // ============================================================
  const checkNowBtn = document.getElementById('check-now-btn');
  // lastCheckSpan já declarado no topo do arquivo (linha 101)

  if (checkNowBtn) {
    checkNowBtn.addEventListener('click', () => {
      checkNowBtn.disabled = true;
      checkNowBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Checking...';

      ipcRenderer.send('check-for-updates');

      // Atualiza data do último check e salva
      const now = new Date().toISOString();
      if (lastCheckSpan) lastCheckSpan.textContent = new Date(now).toLocaleString('en-US');
      ipcRenderer.send('save-setting', { key: 'lastUpdateCheck', value: now });
    });
  }

  // ============================================================
  // Aba Activate — apenas status (dados via Main: license:status)
  // ============================================================
  const licenseStatusBadge = document.getElementById('license-status-badge');
  const licenseStatusTitle = document.getElementById('license-status-title');
  const licenseStatusDetail = document.getElementById('license-status-detail');
  const activateTabBtn = document.getElementById('activate-tab-btn');

  async function refreshLicenseStatusPanel() {
    if (!licenseStatusTitle) return;
    try {
      const s = await ipcRenderer.invoke('license:status');
      if (s.activated) {
        if (licenseStatusBadge) {
          licenseStatusBadge.textContent = 'Activated';
          licenseStatusBadge.className = 'badge rounded-pill bg-success';
        }
        licenseStatusTitle.textContent = 'This copy is licensed.';
        const parts = [];
        if (s.customer) parts.push(`Registered to: ${s.customer}`);
        if (s.keyMasked) parts.push(`Key: ${s.keyMasked}`);
        if (s.activatedAt) parts.push(`Activated: ${new Date(s.activatedAt).toLocaleString()}`);
        if (licenseStatusDetail) licenseStatusDetail.textContent = parts.join(' · ');
      } else if (s.devLicenseOptional) {
        if (licenseStatusBadge) {
          licenseStatusBadge.textContent = 'Development';
          licenseStatusBadge.className = 'badge rounded-pill bg-warning text-dark';
        }
        licenseStatusTitle.textContent = 'No license on disk (OK for local dev)';
        if (licenseStatusDetail) {
          licenseStatusDetail.textContent =
            'Unpacked builds (npm start) skip the license gate. Use npm run start:enforce to test activation. Release builds require a valid license.';
        }
      } else {
        if (licenseStatusBadge) {
          licenseStatusBadge.textContent = 'Not activated';
          licenseStatusBadge.className = 'badge rounded-pill bg-danger';
        }
        licenseStatusTitle.textContent = 'This copy is not activated.';
        if (licenseStatusDetail) {
          licenseStatusDetail.textContent = s.reason
            ? `Reason: ${s.reason}. Complete activation when the app starts.`
            : 'Complete activation when the app starts.';
        }
      }
    } catch (e) {
      if (licenseStatusBadge) {
        licenseStatusBadge.textContent = 'Error';
        licenseStatusBadge.className = 'badge rounded-pill bg-secondary';
      }
      licenseStatusTitle.textContent = 'Could not read license status.';
      if (licenseStatusDetail) licenseStatusDetail.textContent = String(e.message || e);
    }
  }

  if (activateTabBtn) {
    activateTabBtn.addEventListener('shown.bs.tab', refreshLicenseStatusPanel);
  }
  refreshLicenseStatusPanel();

  // ----------------------------------------------------------------
  // AUTO-UPDATE: painel de progresso + botão Reiniciar (aba Auto Update)
  // ----------------------------------------------------------------
  // Helpers para criar/atualizar o painel embutido na aba Auto Update.
  function removeUpdateAlert() {
    const existing = document.getElementById('update-result-alert');
    if (existing) existing.remove();
  }

  function buildSimpleAlert(alertClass, icon, message) {
    removeUpdateAlert();
    const alertDiv = document.createElement('div');
    alertDiv.id = 'update-result-alert';
    alertDiv.className = `alert ${alertClass} d-flex align-items-center mx-5 mt-3`;
    alertDiv.innerHTML = `<i class="bi ${icon} me-2"></i><span>${message}</span>`;
    const checkNowContainer = checkNowBtn?.parentElement;
    if (checkNowContainer) {
      checkNowContainer.parentElement.insertBefore(alertDiv, checkNowContainer.nextSibling);
    }
    return alertDiv;
  }

  function buildUpdateAvailablePanel(version, initialMessage) {
    removeUpdateAlert();
    const panel = document.createElement('div');
    panel.id = 'update-result-alert';
    panel.className = 'alert alert-success mx-5 mt-3';
    panel.innerHTML = `
      <div class="d-flex align-items-center mb-2">
        <i class="bi bi-arrow-down-circle me-2"></i>
        <span id="update-progress-text">${initialMessage || `New version ${version} available! Downloading...`}</span>
      </div>
      <div class="progress mb-2" style="height: 6px;">
        <div id="update-progress-bar"
             class="progress-bar progress-bar-striped progress-bar-animated"
             role="progressbar"
             style="width: 0%;"
             aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
      </div>
      <div class="text-end">
        <button id="update-restart-btn" type="button" class="btn btn-sm btn-success" disabled>
          <i class="bi bi-arrow-clockwise me-1"></i> Restart
        </button>
      </div>
    `;
    const checkNowContainer = checkNowBtn?.parentElement;
    if (checkNowContainer) {
      checkNowContainer.parentElement.insertBefore(panel, checkNowContainer.nextSibling);
    }

    const restartBtn = panel.querySelector('#update-restart-btn');
    if (restartBtn) {
      restartBtn.addEventListener('click', () => {
        restartBtn.disabled = true;
        restartBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Restarting...';
        ipcRenderer.send('restart_app');
      });
    }
    return panel;
  }

  // Listener para resultado da verificação de updates (Check Now)
  ipcRenderer.on('update-check-result', (event, result) => {
    console.log('[AutoUpdater] Resultado:', result);

    if (checkNowBtn) {
      checkNowBtn.disabled = false;
      checkNowBtn.textContent = 'Check Now';
    }

    if (result.status === 'available') {
      buildUpdateAvailablePanel(result.version, result.message);
      return;
    }

    let alertClass = 'alert-info';
    let icon = 'bi-info-circle';
    if (result.status === 'up-to-date') { alertClass = 'alert-primary'; icon = 'bi-check-circle'; }
    else if (result.status === 'error') { alertClass = 'alert-danger'; icon = 'bi-exclamation-triangle'; }
    else if (result.status === 'dev-mode') { alertClass = 'alert-warning'; icon = 'bi-tools'; }

    const alertDiv = buildSimpleAlert(alertClass, icon, result.message);
    if (alertDiv) setTimeout(() => alertDiv.remove(), 8000);
  });

  // Progresso do download — atualiza barra e texto em tempo real
  ipcRenderer.on('update-download-progress', (_, data) => {
    let panel = document.getElementById('update-result-alert');
    // Se ainda não houver painel (caso o auto-check tenha disparado antes do Check Now)
    if (!panel || !panel.querySelector('#update-progress-bar')) {
      panel = buildUpdateAvailablePanel('', 'Downloading update...');
    }
    const bar = panel.querySelector('#update-progress-bar');
    const txt = panel.querySelector('#update-progress-text');
    const pct = Math.max(0, Math.min(100, Math.round(data.percent || 0)));
    if (bar) {
      bar.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', pct);
    }
    if (txt) {
      const mb = (v) => (v / 1024 / 1024).toFixed(1);
      txt.textContent = `Downloading update... ${pct}% (${mb(data.transferred)} / ${mb(data.total)} MB)`;
    }
  });

  // Download concluído — habilita o botão Reiniciar
  ipcRenderer.on('update_downloaded', (_, info) => {
    let panel = document.getElementById('update-result-alert');
    if (!panel || !panel.querySelector('#update-progress-bar')) {
      panel = buildUpdateAvailablePanel(info?.version || '', 'Update downloaded.');
    }
    const bar = panel.querySelector('#update-progress-bar');
    const txt = panel.querySelector('#update-progress-text');
    const btn = panel.querySelector('#update-restart-btn');
    if (bar) {
      bar.style.width = '100%';
      bar.setAttribute('aria-valuenow', 100);
      bar.classList.remove('progress-bar-animated');
    }
    if (txt) {
      txt.textContent = info?.version
        ? `Version ${info.version} ready. Click Restart to install.`
        : 'Update ready. Click Restart to install.';
    }
    if (btn) btn.disabled = false;
  });

  // Detecção silenciosa (auto-check do startup) também monta o painel.
  ipcRenderer.on('update-available-silent', (_, info) => {
    if (!document.getElementById('update-result-alert')) {
      buildUpdateAvailablePanel(info?.version || '', `New version ${info?.version || ''} available! Downloading...`);
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
      refreshLicenseStatusPanel();
    }, 100);
  });

}); // Fim do DOMContentLoaded