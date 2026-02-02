/**
 * ============================================================
 * PROMPTIQ - RENDERER PROCESS (app.js)
 * Versão 5.42 - Cue Marker Arrastável + Funcionalidades Anteriores
 * ============================================================
 * 
 * Este arquivo contém toda a lógica do processo renderer:
 * - Gerenciamento de documentos (abas, editor, salvamento)
 * - Motor de scroll do prompter
 * - Conexão remota (Wi-Fi e WebRTC/Internet)
 * - Sistema de busca e substituição
 * - Mensagens rápidas e overlay
 * - Rastreamento por voz
 * - Timeline e histórico de versões
 * 
 * @author PromptIQ Team
 */

document.addEventListener("DOMContentLoaded", () => {

  // ============================================================
  // SEÇÃO 1: IMPORTAÇÃO DE DEPENDÊNCIAS
  // ============================================================
  // Socket.io para conexão WebRTC, IPC para comunicação com main process

  const ioClient = require("socket.io-client");
  // IMPORTANTE: Por enquanto use localhost. Quando subir pro Glitch, troque aqui!
  const SIGNALING_URL = "https://roteiro.promptiq.com.br";
  const ipcRenderer = require("electron").ipcRenderer;
  // @ts-ignore
  const bootstrap = window.bootstrap;

  // Módulo de atalhos de teclado/mouse (carregado via script tag)
  // HotkeyHandler é definido globalmente pelo hotkey-handler.js

  // ============================================================
  // SEÇÃO 2: VARIÁVEIS DE ESTADO DO PROMPTER
  // ============================================================
  // Memória persistente de posição e configurações do prompter

  // Memória persistente do prompter
  let roteiroIndexado = [];
  let posicaoAtualNoRoteiro = 0;

  let currentFontSizePT = 12;

  // ============================================================
  // SEÇÃO 3: CONFIGURAÇÕES INICIAIS DO EDITOR
  // ============================================================
  // Força o navegador a usar estilos CSS inline e parágrafos <p>

  // === ADICIONE ESTAS DUAS LINHAS AQUI ===
  // Força o navegador a usar <span style="color:..."> em vez de <font>
  document.execCommand("styleWithCSS", false, true);
  // Garante que Enter crie parágrafos <p>
  document.execCommand("defaultParagraphSeparator", false, "p");

  // ============================================================
  // SEÇÃO 4: SELETORES DO DOM - ELEMENTOS GERAIS
  // ============================================================
  // Referências aos elementos principais da interface

  // === SELETORES GERAIS ===
  const documentTabsBar = document.getElementById("document-tabs-bar");
  const documentContentContainer = document.getElementById(
    "document-content-container"
  );

  // Seletores Home Sidebar
  const newScriptBtn = document.getElementById("new-script-btn");
  const openScriptBtn = document.getElementById("open-script-btn");
  const saveScriptBtn = document.getElementById("save-script-btn");
  const optionsLink = document.getElementById("options-link");
  const recentLink = document.getElementById("recent-link");

  // Home Content Areas
  const homeContentDefault = document.getElementById("home-content-default");
  const homeContentRecent = document.getElementById("home-content-recent");
  const recentFilesList = document.getElementById("recent-files-list");
  const homeTabBtn = document.getElementById("home-tab");

  // Toolbar Editor
  const boldBtn = document.getElementById("bold-btn");
  const italicBtn = document.getElementById("italic-btn");
  const underlineBtn = document.getElementById("underline-btn");
  const fontFamilySelect = document.getElementById("font-family-select");
  const fontSizeSelect = document.getElementById("font-size-select");

  // ============================================================
  // SEÇÃO 5: SELETORES DO DOM - OPERATOR TOOLBAR
  // ============================================================
  // Controles visuais do prompter (espelhar, inverter, fullscreen)

  // === SELETORES DA OPERATOR TOOLBAR (Barra Limpa) ===
  const opBtnInvert = document.getElementById("op-btn-invert");
  const opBtnMirrorH = document.getElementById("op-btn-mirror-h");
  const opBtnMirrorV = document.getElementById("op-btn-mirror-v");
  const opBtnMargin = document.getElementById("op-btn-margin");
  const opBtnFullscreen = document.getElementById("op-btn-fullscreen");
  const opBtnReset = document.getElementById("op-btn-reset");
  const opBtnLoop = document.getElementById("op-btn-loop");
  const opBtnSettings = document.getElementById("op-btn-settings");

  // ============================================================
  // SEÇÃO 6: SELETORES DO DOM - CONTROLES DE PLAYBACK
  // ============================================================
  // Botões de play/pause/stop e slider de velocidade

  // Operator Playback Controls & Container
  const playBtn = document.getElementById("play-btn");
  const pauseBtn = document.getElementById("pause-btn");
  const stopBtn = document.getElementById("stop-btn");
  const speedSlider = document.getElementById("control-speed-slider");
  const speedValueSpan = document.getElementById("current-speed-value");

  // O elemento que vai rolar e o Marcador
  const prompterContainer = document.querySelector(".prompter-in-control");
  const cueMarkerControl = document.getElementById("cueMarker-control");

  // ============================================================
  // SEÇÃO 7: SELETORES DO DOM - MODAL DE BUSCA
  // ============================================================
  // Elementos do modal de busca e substituição

  // Modal de Busca
  const findReplaceModal = document.getElementById("findReplaceModal");
  const modalFindInput = document.getElementById("modal-find-input");
  const modalReplaceInput = document.getElementById("modal-replace-input");
  const modalReplaceGroup = document.getElementById("modal-replace-group");
  const modalReplaceBtn = document.getElementById("modal-replace-btn");
  const modalReplaceAllBtn = document.getElementById("modal-replace-all-btn");
  const modalFindNextBtn = document.getElementById("modal-find-next-btn");
  const modalFindPrevBtn = document.getElementById("modal-find-prev-btn");
  const modalFindCountSpan = document.getElementById("modal-find-count");
  const modalTitle = document.getElementById("findReplaceModalLabel");
  const modalReplaceActions = document.getElementById("modal-replace-actions");
  const findCaseSensitive = document.getElementById("find-case-sensitive");
  const findWholeWord = document.getElementById("find-whole-word");
  const findColorPalette = document.querySelectorAll(".find-color-btn");
  const findColorPopup = document.getElementById("find-color-popup");
  const findHiddenColorPicker = document.getElementById("find-hidden-color-picker");

  // Barra minimizada do Find
  const findMinimizedBar = document.getElementById("findMinimizedBar");
  const findMinimizedText = document.getElementById("findMinimizedText");
  const findMinimizedCount = document.getElementById("findMinimizedCount");
  const findMinimizedPrev = document.getElementById("findMinimizedPrev");
  const findMinimizedNext = document.getElementById("findMinimizedNext");
  const findMinimizedExpand = document.getElementById("findMinimizedExpand");
  const findMinimizedClose = document.getElementById("findMinimizedClose");
  const findMinimizeBtn = document.getElementById("findMinimizeBtn");

  // Cor selecionada para substituição
  let findReplaceColor = "";

  // Flag para saber se o Find está ativo (mesmo minimizado)
  let findIsActive = false;

  const findReplaceBootstrapModal = findReplaceModal
    ? new bootstrap.Modal(findReplaceModal, { backdrop: false, keyboard: true })
    : null;

  // ============================================================
  // SEÇÃO 8: ESTADO GLOBAL DA APLICAÇÃO
  // ============================================================
  // Variáveis de estado para documentos, busca e auto-save

  // === ESTADO ===
  let documents = [];
  let activeDocumentId = null;
  let nextDocumentId = 1;
  let isAutoSaveEnabled = false;
  let autoSaveTimeoutId = null;
  let searchState = {
    isReplaceMode: false,
    currentMatchIndex: -1,
    matches: [],
  };
  let lastSelectionRange = null;

  // ============================================================
  // SEÇÃO 9: ESTADO DO OPERATOR (CONTROLE VISUAL)
  // ============================================================
  // Espelhamento, inversão, loop e margens do prompter

  // Estado Local do Operator
  let operatorState = {
    mirrorH: false,
    mirrorV: false,
    isInverted: false,
    isLooping: false,
    marginIndex: 0,
    margins: ["0px", "10%", "20%", "30%"],
  };

  // Preferências globais carregadas do main process
  let globalPrefs = {}; // Variável para guardar as configurações na memória


  // ============================================================
  // SEÇÃO 10: CONFIGURAÇÃO DE MENSAGENS RÁPIDAS
  // ============================================================
  // Categorias e itens de mensagens que aparecem como overlay no prompter

  // === CONFIGURAÇÃO DE MENSAGENS RÁPIDAS ===
  const quickMessageConfig = {
    categories: [
      {
        id: 'pacing',
        name: 'Ritmo / Tempo',
        icon: 'bi-speedometer2',
        items: [
          { label: 'DEVAGAR', message: 'DEVAGAR', color: '#FFFFFF', bg: '#FFC107', icon: 'bi-cone-striped' }, // Amarelo
          { label: 'ACELERA', message: 'ACELERA', color: '#FFFFFF', bg: '#28A745', icon: 'bi-lightning-fill' }, // Verde
          { label: 'ESTICA', message: 'ENROLA / ESTICA', color: '#FFFFFF', bg: '#17A2B8', icon: 'bi-arrows-expand' }, // Azul
          { label: 'CONCLUA', message: 'CONCLUA AGORA', color: '#FFFFFF', bg: '#FD7E14', icon: 'bi-hourglass-bottom' }, // Laranja
          { label: 'PARE', message: 'PARE', color: '#FFFFFF', bg: '#DC3545', icon: 'bi-stop-circle-fill' } // Vermelho
        ]
      },
      {
        id: 'camera',
        name: 'Câmera / Olhar',
        icon: 'bi-camera-video',
        items: [
          { label: 'CAM 1', message: '>>> CAM 1 <<<', color: '#000000', bg: '#FFFFFF', icon: 'bi-1-square' },
          { label: 'CAM 2', message: '>>> CAM 2 <<<', color: '#000000', bg: '#FFFFFF', icon: 'bi-2-square' },
          { label: 'CAM 3', message: '>>> CAM 3 <<<', color: '#000000', bg: '#FFFFFF', icon: 'bi-3-square' },
          { label: 'OLHE CIMA', message: 'OLHE PARA CIMA', color: '#FFFFFF', bg: '#6C757D', icon: 'bi-arrow-up-circle' }
        ]
      },
      {
        id: 'audio',
        name: 'Áudio / Técnico',
        icon: 'bi-mic',
        items: [
          { label: 'FALE ALTO', message: 'FALE MAIS ALTO', color: '#FFFFFF', bg: '#6610F2', icon: 'bi-volume-up' },
          { label: 'COMERCIAL', message: 'INTERVALO', color: '#FFFFFF', bg: '#0DCAF0', icon: 'bi-pause-circle' },
          { label: 'IMPROVISE', message: 'AD-LIB (IMPROVISE)', color: '#000000', bg: '#FFD700', icon: 'bi-mic-mute' }
        ]
      },


      {
        id: 'custom',
        name: 'Escrever Msg',
        icon: 'bi-keyboard', // Ícone de teclado
        items: [] // Deixe vazio, vamos tratar via código
      }



    ]
  };


  // ============================================================
  // SEÇÃO 11: SINCRONIZAÇÃO DE CONFIGURAÇÕES
  // ============================================================
  // Recebe e aplica configurações do main process

  // === SINCRONIZA QUANDO RECEBE SETTINGS DO MAIN ===

  ipcRenderer.on('settings-updated-globally', (event, settings) => {
    console.log("⚙️ Settings recebidas:", settings);
    globalPrefs = settings;

    if (settings.defaultFontSize) {
      currentFontSizePT = settings.defaultFontSize;

      // Atualiza todos os inputs
      const fontSizePreset = document.getElementById('font-size-preset');
      const fontSizeCustom = document.getElementById('font-size-custom');

      if (fontSizePreset) fontSizePreset.value = settings.defaultFontSize;
      if (fontSizeCustom) fontSizeCustom.value = settings.defaultFontSize;

      applyExactFontSizeToOperator(settings.defaultFontSize);
    }

    // Atualiza atalhos de teclado/mouse se HotkeyHandler existir
    if (typeof HotkeyHandler !== 'undefined') {
      HotkeyHandler.updateSettings(settings);
    }

    if (typeof applySettingsToVisuals === 'function') {
      applySettingsToVisuals();
    }
  });

  // === LISTENER PARA APLICAR TEMA (DARK/LIGHT) ===
  ipcRenderer.on('apply-theme', (event, theme) => {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.classList.add('dark-mode');
    } else {
      document.documentElement.removeAttribute('data-theme');
      document.body.classList.remove('dark-mode');
    }
  });

  // ============================================================
  // AUTO-UPDATER: Notificação discreta de atualização disponível
  // ============================================================
  ipcRenderer.on('update_downloaded', (event, info) => {
    console.log('[AutoUpdater] Nova versão pronta para instalar:', info.version);

    // Cria snackbar de notificação discreta
    const snackbar = document.createElement('div');
    snackbar.id = 'update-snackbar';
    snackbar.innerHTML = `
      <div class="update-snackbar-content">
        <i class="bi bi-arrow-repeat update-icon"></i>
        <span class="update-text">Nova versão ${info.version} baixada.</span>
        <button id="update-restart-btn" class="update-btn">Reiniciar Agora</button>
        <button id="update-dismiss-btn" class="update-dismiss">&times;</button>
      </div>
    `;

    // Estilos inline para garantir que funcione independente do CSS principal
    snackbar.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #ffffff;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      z-index: 99999;
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 14px;
      animation: slideInRight 0.3s ease-out;
      border: 1px solid rgba(255, 255, 255, 0.1);
    `;

    // Adiciona animação CSS dinamicamente
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideInRight {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOutRight {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
      #update-snackbar .update-snackbar-content {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      #update-snackbar .update-icon {
        font-size: 18px;
        color: #4ade80;
        animation: spin 2s linear infinite;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      #update-snackbar .update-text {
        flex: 1;
      }
      #update-snackbar .update-btn {
        background: #4ade80;
        color: #1a1a2e;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
        transition: all 0.2s ease;
      }
      #update-snackbar .update-btn:hover {
        background: #22c55e;
        transform: scale(1.02);
      }
      #update-snackbar .update-dismiss {
        background: transparent;
        color: #9ca3af;
        border: none;
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.2s ease;
      }
      #update-snackbar .update-dismiss:hover {
        color: #ffffff;
      }
    `;
    document.head.appendChild(style);

    // Remove snackbar existente se houver
    const existingSnackbar = document.getElementById('update-snackbar');
    if (existingSnackbar) existingSnackbar.remove();

    document.body.appendChild(snackbar);

    // Handler: Reiniciar aplicação
    document.getElementById('update-restart-btn').addEventListener('click', () => {
      ipcRenderer.send('restart_app');
    });

    // Handler: Dispensar notificação
    document.getElementById('update-dismiss-btn').addEventListener('click', () => {
      snackbar.style.animation = 'slideOutRight 0.3s ease-in forwards';
      setTimeout(() => snackbar.remove(), 300);
    });
  });


  // Solicita configurações iniciais ao carregar (com pequeno delay para garantir IPC pronto)
  setTimeout(() => {
    ipcRenderer.send('request-initial-settings');
  }, 100);

  // ============================================================
  // STANDBY MODE - Sistema de Inatividade
  // ============================================================
  // Mostra imagem de standby quando usuário fica inativo

  let standbyTimer = null;
  let isStandbyActive = false;
  let standbySettings = {
    enabled: false,
    imagePath: null,
    timeout: 5 // minutos
  };

  /**
   * Reseta o timer de inatividade
   */
  function resetStandbyTimer() {
    // Se standby está ativo, desativa primeiro
    if (isStandbyActive) {
      hideStandby();
    }

    // Limpa timer anterior
    if (standbyTimer) {
      clearTimeout(standbyTimer);
    }

    // Só inicia novo timer se standby está habilitado
    if (standbySettings.enabled && standbySettings.imagePath) {
      const timeoutMs = standbySettings.timeout * 60 * 1000; // Converte minutos para ms
      standbyTimer = setTimeout(showStandby, timeoutMs);
    }
  }

  /**
   * Mostra o overlay de Standby
   */
  function showStandby() {
    const overlay = document.getElementById('standby-overlay');
    if (!overlay || isStandbyActive) return;

    isStandbyActive = true;

    // Configura imagem de fundo se houver
    if (standbySettings.imagePath) {
      overlay.style.backgroundImage = `url("file://${standbySettings.imagePath.replace(/\\/g, '/')}")`;
      overlay.classList.add('has-image');
    } else {
      overlay.style.backgroundImage = 'none';
      overlay.classList.remove('has-image');
    }

    overlay.style.display = 'flex';
    overlay.classList.remove('fade-out');

    console.log('[Standby] Modo Standby ativado');
  }

  /**
   * Esconde o overlay de Standby
   */
  function hideStandby() {
    const overlay = document.getElementById('standby-overlay');
    if (!overlay || !isStandbyActive) return;

    overlay.classList.add('fade-out');

    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.classList.remove('fade-out');
      isStandbyActive = false;
      console.log('[Standby] Modo Standby desativado');
    }, 300);
  }

  /**
   * Atualiza configurações de Standby
   */
  function updateStandbySettings(settings) {
    standbySettings.enabled = settings.useCustomStandbyImage === true;
    standbySettings.imagePath = settings.standbyImagePath || null;
    standbySettings.timeout = settings.standbyTimeout || 5;

    console.log('[Standby] Configurações atualizadas:', standbySettings);

    // Reseta timer com novas configurações
    resetStandbyTimer();
  }

  // Eventos que resetam o timer de inatividade
  const activityEvents = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'];
  activityEvents.forEach(eventType => {
    document.addEventListener(eventType, resetStandbyTimer, { passive: true });
  });

  // Listener para atualizar settings do Standby
  ipcRenderer.on('settings-updated-globally', (event, settings) => {
    updateStandbySettings(settings);
  });

  // ============================================================
  // SEÇÃO 12: APLICAÇÃO DE ESTILOS VISUAIS
  // ============================================================
  // Aplica configurações de fonte, cor, margem e cue marker ao editor e prompter

  /**
   * Aplica configurações visuais ao editor e prompter
   * Configura: fonte, tamanho, cor, espaçamento, margens e cue marker
   */
  function applySettingsToVisuals() {
    const prefs = globalPrefs || {
      defaultFont: 'Arial', defaultFontSize: 12, lineSpacing: 1.5,
      defaultFontColor: '#FFFFFF', backgroundColor: '#000000',
      cueColor: '#00FF00', cueType: 'arrow', prompterMargin: 40
    };

    // --- A. ABA EDIT (EDITOR) ---
    const editors = document.querySelectorAll('.text-editor-area');
    editors.forEach(editor => {
      editor.style.fontFamily = prefs.defaultFont;
      // Usa o tamanho global se existir, senão usa o padrão das prefs
      editor.style.fontSize = (typeof currentFontSizePT !== 'undefined' && currentFontSizePT > 0)
        ? `${currentFontSizePT}pt`
        : `${prefs.defaultFontSize}pt`;

      editor.style.lineHeight = prefs.lineSpacing;
      editor.style.backgroundColor = '#FFFFFF';
      editor.style.color = '#000000';
      editor.style.paddingTop = '40px';
      editor.style.paddingLeft = '20px';
      editor.style.paddingRight = '20px';

      const attrs = prefs.defaultFontAttributes || [];
      editor.style.fontWeight = attrs.includes('bold') ? 'bold' : 'normal';
      editor.style.fontStyle = attrs.includes('italic') ? 'italic' : 'normal';
      editor.style.textDecoration = attrs.includes('underline') ? 'underline' : 'none';
    });

    // --- B. ABA OPERATOR (PROMPTER) ---
    const prompterText = document.getElementById('prompterText-control');
    const prompterContainer = document.querySelector('.prompter-in-control');

    if (prompterText && prompterContainer) {
      prompterText.style.fontFamily = prefs.defaultFont;
      prompterText.style.color = prefs.defaultFontColor;
      prompterContainer.style.backgroundColor = prefs.backgroundColor;

      // ✅ USA A MEMÓRIA GLOBAL (currentFontSizePT)
      if (typeof currentFontSizePT !== 'undefined' && currentFontSizePT > 0) {
        prompterText.style.fontSize = `${currentFontSizePT}pt`;
      } else if (prefs.defaultFontSize) {
        // Fallback: usa as preferências se existirem
        prompterText.style.fontSize = `${prefs.defaultFontSize}pt`;
      }

      prompterContainer.style.display = 'block';
      prompterContainer.style.textAlign = 'center';
      prompterText.style.display = 'block';
      prompterText.style.margin = '0 auto';
      prompterText.style.width = 'fit-content';
      prompterText.style.maxWidth = '100%';
      prompterText.style.paddingTop = '40px';

      const userMargin = prefs.prompterMargin || 40;
      const safeZoneArrow = 20;
      prompterText.style.paddingLeft = `${userMargin + safeZoneArrow}px`;
      prompterText.style.paddingRight = `${userMargin}px`;
      prompterText.style.lineHeight = prefs.lineSpacing || 1.5;

      const attrs = prefs.defaultFontAttributes || [];
      prompterText.style.fontWeight = attrs.includes('bold') ? 'bold' : 'normal';
      prompterText.style.fontStyle = attrs.includes('italic') ? 'italic' : 'normal';
      prompterText.style.textDecoration = attrs.includes('underline') ? 'underline' : 'none';
    }

    // --- C. CUE MARKER (SETA) ---
    // (O restante do seu código da seta permanece igual aqui...)
    let cueMarker = document.getElementById('cueMarker-control');
    if (!cueMarker && prompterContainer) {
      cueMarker = document.createElement('div');
      cueMarker.id = 'cueMarker-control';
      prompterContainer.appendChild(cueMarker);
      if (typeof iniciarDragDropMarcador === 'function') iniciarDragDropMarcador(cueMarker, prompterContainer);
    }

    if (cueMarker) {
      cueMarker.style.display = 'flex';
      cueMarker.style.alignItems = 'center';
      cueMarker.style.color = prefs.cueColor || '#00FF00';
      const type = prefs.cueType || 'arrow';
      if (type === 'bar') {
        cueMarker.innerHTML = '<div style="width: 100vw; height: 4px; background: currentColor; opacity: 0.8;"></div>';
        cueMarker.style.width = '100%';
      } else {
        cueMarker.innerHTML = '<i class="bi bi-caret-right-fill"></i>';
        cueMarker.style.fontSize = '3rem';
        cueMarker.style.left = '-2px';
      }
      cueMarker.style.position = 'absolute';
      cueMarker.style.zIndex = '2000';
      if (!cueMarker.style.top) cueMarker.style.top = '50%';
    }

    // ✅ SINCRONIZA ESTILOS COM ROTEIRISTAS REMOTOS
    if (typeof broadcastStylesUpdate === 'function') {
      broadcastStylesUpdate();
    }
  }


  // ============================================================
  // SEÇÃO 13: CUE MARKER - DRAG & DROP
  // ============================================================
  // Permite arrastar o marcador (seta) verticalmente no prompter

  /**
   * Ativa funcionalidade de arrastar o marcador verticalmente
   * @param {HTMLElement} marker - Elemento do marcador
   * @param {HTMLElement} container - Container do prompter
   */
  function iniciarDragDropMarcador(marker, container) {
    let isDraggingMarker = false;
    let guideLine = null;

    // Cria a linha guia temporária (apenas uma vez)
    function createGuideLine() {
      if (!guideLine) {
        guideLine = document.createElement('div');
        guideLine.id = 'cue-drag-guide-line';
        guideLine.style.color = marker.style.color || 'var(--primary-color)';
        container.appendChild(guideLine);
      }
      return guideLine;
    }

    // Verifica se está no modo seta (não barra)
    function isCueArrowMode() {
      // Verifica se o marker contém uma barra (div com width 100vw) ou seta (ícone)
      const innerDiv = marker.querySelector('div');
      if (innerDiv && innerDiv.style.width === '100vw') {
        return false; // Modo barra
      }
      return true; // Modo seta
    }

    // Calcula a posição do centro visual da seta
    function getArrowCenterY() {
      const markerRect = marker.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return markerRect.top + (markerRect.height / 2) - containerRect.top;
    }

    marker.addEventListener("mousedown", (e) => {
      isDraggingMarker = true;
      marker.style.cursor = "grabbing";
      e.preventDefault();

      // Mostra linha guia apenas no modo seta
      if (isCueArrowMode()) {
        const line = createGuideLine();
        line.style.color = marker.style.color || 'var(--primary-color)';
        // Posiciona a linha no centro visual da seta
        line.style.top = `${getArrowCenterY()}px`;
        line.classList.add('visible');
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDraggingMarker) return;
      e.preventDefault();
      const containerRect = container.getBoundingClientRect();
      let relativeY = e.clientY - containerRect.top;
      if (relativeY < 0) relativeY = 0;
      if (relativeY > containerRect.height) relativeY = containerRect.height;
      marker.style.top = `${relativeY}px`;

      // Atualiza posição da linha guia - calcula o centro real da seta após movimento
      if (guideLine && guideLine.classList.contains('visible')) {
        // Usa requestAnimationFrame para garantir que o DOM foi atualizado
        requestAnimationFrame(() => {
          guideLine.style.top = `${getArrowCenterY()}px`;
        });
      }
    });

    document.addEventListener("mouseup", () => {
      if (isDraggingMarker) {
        isDraggingMarker = false;
        marker.style.cursor = "ns-resize";

        // Esconde a linha guia
        if (guideLine) {
          guideLine.classList.remove('visible');
        }
      }
    });
  }


  // ============================================================
  // SEÇÃO 14: INICIALIZAÇÃO DO CUE MARKER
  // ============================================================
  // Configura estilos iniciais e eventos de drag do marcador

  // === CUE MARKER DRAG LOGIC (NOVO) ===
  if (cueMarkerControl && prompterContainer) {
    // Inicialização Visual da Seta
    cueMarkerControl.innerHTML = '<i class="bi bi-chevron-double-right"></i>';

    // Estilos essenciais para funcionamento
    cueMarkerControl.style.position = "absolute"; // Precisa ser absoluto em relação ao container
    cueMarkerControl.style.left = "10px"; // Margem esquerda
    cueMarkerControl.style.top = "50%"; // Começa no meio
    cueMarkerControl.style.transform = "translateY(-50%)"; // Centraliza verticalmente
    cueMarkerControl.style.zIndex = "2000"; // Acima do texto
    cueMarkerControl.style.cursor = "ns-resize"; // Cursor de redimensionar N/S
    cueMarkerControl.style.fontSize = "2rem";
    cueMarkerControl.style.color = "var(--primary-color)"; // Cor padrão (pode vir dos settings)
    cueMarkerControl.style.userSelect = "none"; // Impede seleção de texto
    // Adiciona sombra para visibilidade em fundo claro/escuro
    cueMarkerControl.style.textShadow = "0 0 3px rgba(0,0,0,0.5)";

    let isDraggingMarker = false;
    let guideLineControl = null;

    // Cria a linha guia temporária
    function createGuideLineControl() {
      if (!guideLineControl) {
        guideLineControl = document.createElement('div');
        guideLineControl.id = 'cue-drag-guide-line';
        guideLineControl.style.color = cueMarkerControl.style.color || 'var(--primary-color)';
        prompterContainer.appendChild(guideLineControl);
      }
      return guideLineControl;
    }

    // Verifica se está no modo seta (não barra)
    function isCueArrowModeControl() {
      const innerDiv = cueMarkerControl.querySelector('div');
      if (innerDiv && innerDiv.style.width === '100vw') {
        return false; // Modo barra
      }
      return true; // Modo seta
    }

    // Calcula a posição do centro visual da seta
    function getArrowCenterYControl() {
      const markerRect = cueMarkerControl.getBoundingClientRect();
      const containerRect = prompterContainer.getBoundingClientRect();
      return markerRect.top + (markerRect.height / 2) - containerRect.top;
    }

    // Inicia o arrasto
    cueMarkerControl.addEventListener("mousedown", (e) => {
      isDraggingMarker = true;
      cueMarkerControl.style.cursor = "grabbing";
      e.preventDefault(); // Evita conflitos

      // Mostra linha guia apenas no modo seta
      if (isCueArrowModeControl()) {
        const line = createGuideLineControl();
        line.style.color = cueMarkerControl.style.color || 'var(--primary-color)';
        // Posiciona a linha no centro visual da seta
        line.style.top = `${getArrowCenterYControl()}px`;
        line.classList.add('visible');
      }
    });

    // Move a seta
    document.addEventListener("mousemove", (e) => {
      if (!isDraggingMarker) return;
      e.preventDefault();

      // Calcula a posição Y relativa ao container do prompter
      const containerRect = prompterContainer.getBoundingClientRect();
      let relativeY = e.clientY - containerRect.top;

      // Limites (não sair do container)
      if (relativeY < 0) relativeY = 0;
      if (relativeY > containerRect.height) relativeY = containerRect.height;

      // Aplica a nova posição
      // Usamos top diretamente. Removemos o transform translateY para controle absoluto exato no mouse
      cueMarkerControl.style.transform = "translateY(-50%)";
      cueMarkerControl.style.top = `${relativeY}px`;

      // Atualiza posição da linha guia - calcula o centro real da seta após movimento
      if (guideLineControl && guideLineControl.classList.contains('visible')) {
        requestAnimationFrame(() => {
          guideLineControl.style.top = `${getArrowCenterYControl()}px`;
        });
      }
    });

    // Para o arrasto
    document.addEventListener("mouseup", () => {
      if (isDraggingMarker) {
        isDraggingMarker = false;
        cueMarkerControl.style.cursor = "ns-resize";

        // Esconde a linha guia
        if (guideLineControl) {
          guideLineControl.classList.remove('visible');
        }
      }
    });
  }

  // ============================================================
  // SEÇÃO 15: TOGGLE DE TEMA (DARK/LIGHT MODE)
  // ============================================================
  // Tema agora é controlado via menu dropdown (Theme > Light / Dark)
  // Ver handleMenuAction() para os handlers theme-light e theme-dark


  // ============================================================
  // SEÇÃO 16: ENGINE DE ROLAGEM DO PROMPTER
  // ============================================================
  // Motor de scroll suave com requestAnimationFrame para 60 FPS
  // Controla velocidade, pause, stop e loop do teleprompter

  // Variáveis Globais de Playback
  let playbackTimerInterval = null;
  let playbackStartTime = null;
  let playbackDuration = 0;

  /**
   * Motor de rolagem de alta performance
   * Usa transform CSS para scroll suave independente do navegador
   */
  const ScrollEngine = {
    isRunning: false,
    speed: 0,
    lastFrameTime: 0,
    decimalScroll: 0,
    animationFrameId: null,

    getTextElement: function () {
      return document.getElementById("prompterText-control");
    },

    start: function () {
      if (this.isRunning) return;

      // Garante que o container existe
      const container = document.querySelector(".prompter-in-control");
      if (!container) return;

      const textEl = this.getTextElement();
      if (!textEl) return;

      this.isRunning = true;
      this.lastFrameTime = performance.now();

      // Sincroniza a posição atual para não pular
      this.decimalScroll = container.scrollTop;

      // Trava o scroll nativo para a engine assumir
      container.style.overflowY = "hidden";
      container.scrollTop = 0;

      textEl.style.willChange = "transform";
      textEl.style.transform = `translate3d(0, -${this.decimalScroll}px, 0)`;

      // UI Updates
      const playBtn = document.getElementById("play-btn");
      const pauseBtn = document.getElementById("pause-btn");
      if (playBtn) playBtn.classList.add("d-none");
      if (pauseBtn) pauseBtn.classList.remove("d-none");

      // Inicia Timer
      handlePlaybackTimer('start');

      this.loop();
    },


    pause: function () {
      this.isRunning = false;
      if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);

      const textEl = this.getTextElement();
      const container = document.querySelector(".prompter-in-control");

      if (container && textEl) {
        // Devolve controle ao usuário
        textEl.style.transform = "none";
        textEl.style.willChange = "auto";
        container.style.overflowY = "auto";
        container.scrollTop = this.decimalScroll;
      }

      const playBtn = document.getElementById("play-btn");
      const pauseBtn = document.getElementById("pause-btn");
      if (playBtn) playBtn.classList.remove("d-none");
      if (pauseBtn) pauseBtn.classList.add("d-none");

      handlePlaybackTimer('pause');
    },

    stop: function () {
      this.pause();
      const container = document.querySelector(".prompter-in-control");
      if (container) {
        container.scrollTop = 0;
        this.decimalScroll = 0;
      }
      this.setSpeed(0);
      handlePlaybackTimer('stop');
      updateProgressBar(0);
    },

    setSpeed: function (val) {
      let newSpeed = parseInt(val);
      if (newSpeed < -100) newSpeed = -100;
      if (newSpeed > 100) newSpeed = 100;
      this.speed = newSpeed;

      const speedSlider = document.getElementById("control-speed-slider");
      const speedValueSpan = document.getElementById("current-speed-value");
      if (speedSlider) speedSlider.value = newSpeed;
      if (speedValueSpan) speedValueSpan.textContent = newSpeed;
    },

    changeSpeedBy: function (delta) {
      this.setSpeed(this.speed + delta);
      if (this.speed !== 0 && !this.isRunning) {
        this.start();
      }
    },

    loop: function () {
      if (!this.isRunning) return;

      const now = performance.now();
      const deltaTime = now - this.lastFrameTime; // Tempo desde o último frame (ms)
      this.lastFrameTime = now;

      // === NOVA FÓRMULA DE VELOCIDADE (MAIS LENTA E LINEAR) ===
      // Antes estava exponencial, o que deixava muito rápido.
      // Agora: Velocidade 50 = ~150 pixels por segundo.
      // Fator de multiplicação: 3.0 (Ajuste este número se quiser mais rápido/lento geral)
      const speedMultiplier = 3.0;

      const pixelsPerSecond = this.speed * speedMultiplier;

      // Quantos pixels mover neste frame específico?
      const pixelsToScroll = (pixelsPerSecond * deltaTime) / 1000;

      const textEl = this.getTextElement();
      const container = document.querySelector(".prompter-in-control");

      if (container && textEl) {
        if (Math.abs(pixelsToScroll) > 0) {
          this.decimalScroll += pixelsToScroll;

          const contentHeight = textEl.offsetHeight;
          const containerHeight = container.clientHeight;
          // Calcula o limite máximo de scroll (fundo do texto)
          const maxScroll = Math.max(0, contentHeight - containerHeight + (containerHeight / 2));

          // --- ATUALIZA A BARRA DE PROGRESSO VERTICAL ---
          // Calcula porcentagem (0 a 1)
          const scrollRatio = Math.min(1, Math.max(0, this.decimalScroll / (contentHeight - containerHeight)));
          updateProgressBar(scrollRatio);

          // --- LÓGICA DE LOOP ---
          if (pixelsToScroll > 0 && this.decimalScroll >= maxScroll) {
            // Chegou no fim
            if (globalPrefs && globalPrefs.continuousLoop) {
              this.decimalScroll = 0; // Loop: Volta ao topo instantaneamente
            } else {
              this.pause(); // Para
              return;
            }
          } else if (pixelsToScroll < 0 && this.decimalScroll <= 0) {
            this.decimalScroll = 0; // Não sobe além do topo
          }

          // Aplica o movimento
          textEl.style.transform = `translate3d(0, -${this.decimalScroll}px, 0)`;
        }
      }
      // 1. Aplica na sua tela (Editor)

      // 1. Aplica na sua tela (Editor)
      if (textEl) {
        textEl.style.transform = `translate3d(0, -${this.decimalScroll}px, 0)`;
      }

      // === 2. ENVIA RAZÃO DE SCROLL PARA A TV (Sincronização Precisa) ===
      // Reutiliza 'container' já declarado acima
      const syncContainerHeight = container ? container.clientHeight : 0;
      const syncContentHeight = textEl ? textEl.scrollHeight : 0;

      // Desconta margin-bottom do texto para cálculo preciso
      const computedStyle = textEl ? window.getComputedStyle(textEl) : null;
      const marginBottom = computedStyle ? (parseFloat(computedStyle.marginBottom) || 0) : 0;
      const pureContentHeight = syncContentHeight - marginBottom;
      const maxScrollSync = Math.max(1, pureContentHeight - syncContainerHeight);

      // Razão de scroll: 0 = topo, 1 = fim (limitada entre 0 e 1)
      const scrollRatio = Math.min(1, Math.max(0, this.decimalScroll / maxScrollSync));

      // Envia razão E valores absolutos para compatibilidade
      ipcRenderer.send('sync-scroll-position', {
        ratio: scrollRatio,
        pixels: this.decimalScroll,
        maxScroll: maxScrollSync
      });

      this.animationFrameId = requestAnimationFrame(() => this.loop());
    },
  };


  // ============================================================
  // SEÇÃO 17: SINCRONIZAÇÃO DE SCROLL MANUAL
  // ============================================================
  // Quando o usuário rola manualmente, sincroniza com a TV

  if (prompterContainer) {
    prompterContainer.addEventListener("scroll", () => {
      // Só executa se o Play estiver desligado (Scroll Manual)
      if (!ScrollEngine.isRunning) {
        const el = prompterContainer;
        const textEl = document.getElementById('prompterText-control');

        // Desconta margin-bottom do texto para cálculo preciso
        const computedStyle = textEl ? window.getComputedStyle(textEl) : null;
        const marginBottom = computedStyle ? (parseFloat(computedStyle.marginBottom) || 0) : 0;
        const pureContentHeight = el.scrollHeight - marginBottom;
        const maxScroll = Math.max(1, pureContentHeight - el.clientHeight);

        // Razão de scroll (0 a 1) - limitada
        const scrollRatio = Math.min(1, Math.max(0, el.scrollTop / maxScroll));

        // Envia RAZÃO para a TV (sincronização precisa)
        ipcRenderer.send('sync-scroll-position', {
          ratio: scrollRatio,
          pixels: el.scrollTop,
          maxScroll: maxScroll
        });

        // Atualiza a posição interna do motor para quando der Play de novo não pular
        ScrollEngine.decimalScroll = el.scrollTop;
      }
    });
  }

  // ============================================================
  // SEÇÃO 18: PALETA DE CORES DO EDITOR
  // ============================================================
  // Sistema de cores híbrido com presets e seletor nativo

  // === LÓGICA DE CORES: HÍBRIDA (PRESETS + NATIVO BLINDADO) ===
  // === LÓGICA DE CORES CORRIGIDA (MODAL + FUNDO/TEXTO) ===

  const presetColors = [
    "#000000",
    "#434343",
    "#666666",
    "#999999",
    "#CCCCCC",
    "#EFEFEF",
    "#FFFFFF",
    "#980000",
    "#FF0000",
    "#FF9900",
    "#FFFF00",
    "#00FF00",
    "#00FFFF",
    "#4A86E8",
    "#0000FF",
    "#9900FF",
    "#FF00FF",
    "#E6B8AF",
    "#F4CCCC",
    "#FCE5CD",
    "#FFF2CC",
    "#D9EAD3",
    "#D0E0E3",
    "#C9DAF8",
    "#CFE2F3",
    "#D9D2E9",
    "#EAD1DC",
    "#DD7E6B",
    "#EA9999",
    "#F9CB9C",
    "#FFE599",
    "#B6D7A8",
    "#A2C4C9",
    "#A4C2F4",
    "#9FC5E8",
    "#B4A7D6",
    "#D5A6BD",
    "#CC4125",
    "#E06666",
    "#F6B26B",
    "#FFD966",
    "#93C47D",
    "#76A5AF",
    "#6D9EEB",
    "#6FA8DC",
    "#8E7CC3",
    "#C27BA0",
    "#A61C00",
    "#CC0000",
    "#E69138",
    "#F1C232",
    "#6AA84F",
    "#45818E",
    "#3C78D8",
    "#3D85C6",
    "#674EA7",
    "#A64D79",
  ];

  const colorButtons = document.querySelectorAll(".color-btn");
  const palettePopup = document.getElementById("custom-color-palette");
  const modeButtons = document.querySelectorAll(".btn-mode");
  let targetButton = null;
  let paintingMode = "foreground"; // Padrão: Letra

  // 1. ALTERNAR MODO (Letra vs Fundo)
  modeButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // Salva seleção atual antes de trocar o botão
      saveSelection();

      modeButtons.forEach((b) => b.classList.remove("active"));
      const clickedBtn = e.target.closest(".btn-mode");
      clickedBtn.classList.add("active");
      paintingMode = clickedBtn.dataset.mode;

      // Devolve o foco para o editor
      restoreSelection();
    });
  });

  // === LÓGICA DA BORRACHA (REMOVER CORES) ===
  // === LÓGICA DA BORRACHA (LIMPAR APENAS CORES) ===
  const btnResetColor = document.getElementById("btn-reset-color");

  if (btnResetColor) {
    btnResetColor.addEventListener("click", (e) => {
      e.preventDefault();

      const editor = document.querySelector(".text-editor-area");
      if (editor) editor.focus();

      // Habilita CSS para garantir precisão
      document.execCommand("styleWithCSS", false, true);

      // 1. Remove a cor de FUNDO (Fica transparente)
      document.execCommand("hiliteColor", false, "transparent");

      // 2. "Remove" a cor do TEXTO pintando de PRETO (Padrão do Editor)
      // Isso mantém o Negrito/Itálico intactos!
      document.execCommand("foreColor", false, "#000000");

      // Sincroniza imediatamente
      if (typeof syncContentToPrompter === "function") syncContentToPrompter();
      saveSelection();
    });
  }

  // 2. Garante Picker Nativo (Oculto)
  let hiddenPicker = document.getElementById("hidden-color-picker");
  if (!hiddenPicker) {
    hiddenPicker = document.createElement("input");
    hiddenPicker.type = "color";
    hiddenPicker.id = "hidden-color-picker";
    hiddenPicker.style.opacity = "0";
    hiddenPicker.style.position = "absolute";
    hiddenPicker.style.pointerEvents = "none";
    document.body.appendChild(hiddenPicker);
    hiddenPicker.addEventListener("input", (e) =>
      applyColorToButton(e.target.value)
    );
  }

  function applyColorToButton(color) {
    if (targetButton) {
      targetButton.style.backgroundColor = color;
      targetButton.dataset.color = color;
      palettePopup.style.display = "none";
    }
  }

  // 3. GERA A PALETA POPUP
  if (palettePopup) {
    palettePopup.innerHTML = "";
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

    // === 3. GERA A PALETA POPUP (ATUALIZADO) ===
    if (palettePopup) {
      palettePopup.innerHTML = ""; // Limpa a lista (isso apagava o botão antes)

      // 1. Gera os quadradinhos de cor
      presetColors.forEach((color) => {
        const swatch = document.createElement("div");
        swatch.className = "palette-swatch";
        swatch.style.backgroundColor = color;
        swatch.addEventListener("mousedown", (e) => e.preventDefault());
        swatch.addEventListener("click", (e) => {
          e.stopPropagation();
          applyColorToButton(color);
        });
        palettePopup.appendChild(swatch);
      });

      // 2. REINSERE O BOTÃO "MAIS CORES..."
      // Usamos createElement aqui porque o innerHTML="" acima apagou o HTML original
      const moreBtn = document.createElement("div");
      moreBtn.className = "palette-more-btn"; // Usa aquele CSS bonito que fizemos
      moreBtn.innerHTML = "Mais Cores...";

      moreBtn.addEventListener("mousedown", (e) => e.preventDefault());

      // === 3. GERA A PALETA POPUP (AJUSTADO: POSIÇÃO LATERAL) ===
      if (palettePopup) {
        palettePopup.innerHTML = "";

        // 1. Gera os quadradinhos de cor
        presetColors.forEach((color) => {
          const swatch = document.createElement("div");
          swatch.className = "palette-swatch";
          swatch.style.backgroundColor = color;
          swatch.addEventListener("mousedown", (e) => e.preventDefault());
          swatch.addEventListener("click", (e) => {
            e.stopPropagation();
            applyColorToButton(color);
          });
          palettePopup.appendChild(swatch);
        });

        // 2. REINSERE O BOTÃO "MAIS CORES..."
        const moreBtn = document.createElement("div");
        moreBtn.className = "palette-more-btn";
        moreBtn.innerHTML = "Mais Cores...";

        moreBtn.addEventListener("mousedown", (e) => e.preventDefault());

        // 3. Lógica para abrir a janela do Windows AO LADO
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();

          if (targetButton) {
            hiddenPicker.value = targetButton.dataset.color || "#000000";
          }

          // === AQUI ESTÁ A CORREÇÃO DE POSIÇÃO ===
          // Pega onde a caixa de cores está na tela agora
          const rect = palettePopup.getBoundingClientRect();

          hiddenPicker.style.display = "block";
          hiddenPicker.style.position = "fixed";

          // Define a posição do input invisível:
          // rect.right = Borda direita da caixa
          // rect.top = Topo da caixa
          hiddenPicker.style.left = `${rect.right + 5}px`; // 5px à direita da caixa
          hiddenPicker.style.top = `${rect.top}px`;        // Alinhado ao topo

          hiddenPicker.style.width = "0px";
          hiddenPicker.style.height = "0px";
          hiddenPicker.style.opacity = "0";
          hiddenPicker.style.zIndex = "-1";

          // Clica no input e depois fecha o modal
          setTimeout(() => {
            hiddenPicker.click();
            palettePopup.style.display = "none"; // Fecha só depois de posicionar
          }, 50);
        });

        // Adiciona o botão de volta na janela
        palettePopup.appendChild(moreBtn);
      };
    }
  }

  // ============================================================
  // SEÇÃO 19: APLICAÇÃO DE CORES NO TEXTO
  // ============================================================
  // Clique esquerdo pinta, clique direito abre paleta

  // 4. LÓGICA DOS BOTÕES DE COR (A CORREÇÃO PRINCIPAL)
  colorButtons.forEach((btn) => {
    /// CLIQUE ESQUERDO: PINTAR (REFORÇADO)
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      restoreSelection();

      const color = e.target.dataset.color;

      // === O SEGREDO ===
      // Força o navegador a criar <span style="..."> em vez de tags antigas
      // Isso é OBRIGATÓRIO para o Operator entender a cor
      document.execCommand("styleWithCSS", false, true);

      if (paintingMode === "background") {
        // Pinta Fundo (Marca-texto)
        document.execCommand("hiliteColor", false, color);
      } else {
        // Pinta Letra
        document.execCommand("foreColor", false, color);
      }

      // Força o envio imediato pro Operator
      if (typeof syncContentToPrompter === "function") syncContentToPrompter();

      saveSelection();
      const editor = document.querySelector(".text-editor-area");
      if (editor) editor.focus();
    });

    // CLIQUE DIREITO: ABRIR MODAL (POSICIONAMENTO BLINDADO)
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Garante que pegamos o botão exato, não importa onde clicou
      targetButton = e.currentTarget;

      // 1. Torna visível mas transparente para o navegador calcular o tamanho
      palettePopup.style.display = "flex";
      palettePopup.style.visibility = "hidden";

      // 2. Medidas exatas
      const rect = targetButton.getBoundingClientRect(); // Posição do botão na tela
      const modalWidth = palettePopup.offsetWidth || 210;
      const modalHeight = palettePopup.offsetHeight || 150;
      const windowHeight = window.innerHeight;

      // 3. Define a Posição X (Horizontal)
      // Alinha com a esquerda do botão
      palettePopup.style.left = `${rect.left}px`;

      // 4. Define a Posição Y (Vertical)
      const spaceBelow = windowHeight - rect.bottom; // Quanto espaço tem embaixo?

      // LÓGICA DE DECISÃO:
      // Se tiver espaço embaixo (pelo menos a altura do modal), abre embaixo.
      // Se não tiver espaço embaixo, JOGA PRA CIMA.
      if (spaceBelow >= modalHeight) {
        // Abre Embaixo (Padrão)
        palettePopup.style.top = `${rect.bottom + 5}px`;
      } else {
        // Abre Em Cima
        palettePopup.style.top = `${rect.top - modalHeight - 5}px`;
      }

      // 5. Remove a invisibilidade (Agora aparece no lugar certo)
      palettePopup.style.visibility = "visible";
    });
  });

  // Fechar ao clicar fora (Global)
  document.addEventListener("mousedown", (e) => {
    if (palettePopup && palettePopup.style.display !== "none") {
      // Se o clique NÃO foi dentro do popup E NÃO foi num botão de cor
      if (
        !palettePopup.contains(e.target) &&
        !e.target.classList.contains("color-btn")
      ) {
        palettePopup.style.display = "none";
      }
    }
  });

  // ============================================================
  // SEÇÃO 20: DROPDOWN DE FORMATAÇÃO "Aa"
  // ============================================================
  // Opções de maiúsculas, minúsculas e título

  // === LISTENERS DO DROPDOWN "Aa" (Barra de Ferramentas) ===
  const toolbarDropdownItems = document.querySelectorAll(".dropdown-item");

  toolbarDropdownItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      const action = item.getAttribute("data-action");

      // Se o item tiver uma ação de "case", executa a função
      if (action && action.startsWith("set-case-")) {
        e.preventDefault(); // Evita comportamento padrão de link

        if (action === "set-case-upper") changeCase("upper");
        if (action === "set-case-lower") changeCase("lower");
        if (action === "set-case-title") changeCase("title");
      }
    });
  });

  // ============================================================
  // SEÇÃO 21: BOTÕES DE ALINHAMENTO
  // ============================================================
  // Esquerda, centro, direita e justificado

  // === LISTENERS DOS BOTÕES DE ALINHAMENTO DA BARRA ===

  // Mapeamento dos IDs dos botões para os comandos
  const alignmentButtons = {
    "align-left-btn": "justifyLeft",
    "align-center-btn": "justifyCenter",
    "align-right-btn": "justifyRight",
    "align-justify-btn": "justifyFull",
  };

  for (const [btnId, command] of Object.entries(alignmentButtons)) {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); // Evita perder o foco

        // Garante que o editor está focado antes de aplicar
        const editor = document.querySelector(".text-editor-area");
        if (editor) editor.focus();

        // Aplica o alinhamento
        document.execCommand(command, false, null);

        // Atualiza o estado visual dos botões (qual está ativo)
        updateFormatMenuState();

        // Sincroniza com o prompter
        if (typeof syncContentToPrompter === "function")
          syncContentToPrompter();
      });
    }
  }

  // ============================================================
  // SEÇÃO 22: BOTÃO MARCADOR (BOOKMARK)
  // ============================================================
  // Insere asterisco (*) na posição do cursor

  // === LISTENER DO BOTÃO MARCADOR (INSERIR *) ===
  const bookmarkBtn = document.getElementById("bookmark-btn");

  if (bookmarkBtn) {
    bookmarkBtn.addEventListener("click", (e) => {
      e.preventDefault(); // Não deixa o botão roubar o foco

      // Garante que o cursor está no editor
      const editor = document.querySelector(".text-editor-area");
      if (editor) editor.focus();

      // Insere o asterisco (*) na posição atual do cursor
      document.execCommand("insertText", false, "*");

      // (Opcional) Se quiser inserir com um espaço depois, use: '* '

      // Sincroniza com o prompter imediatamente
      if (typeof syncContentToPrompter === "function") syncContentToPrompter();
    });
  }

  // ============================================================
  // SEÇÃO 23: CONTROLES DE SCROLL (MOUSE E TECLADO)
  // ============================================================
  // Roda do mouse e setas controlam velocidade do scroll

  // === CONTROLES DE MOUSE E TECLADO ===
  if (prompterContainer) {
    prompterContainer.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const sensitivity = 5;
        const direction = e.deltaY > 0 ? 1 : -1;
        ScrollEngine.changeSpeedBy(direction * sensitivity);
      },
      { passive: false }
    );
  }

  // ============================================================
  // SEÇÃO 23.1: INICIALIZAÇÃO DO HOTKEY HANDLER
  // ============================================================
  // Sistema de atalhos configuráveis de teclado e mouse

  console.log('🎹 Verificando HotkeyHandler:', typeof HotkeyHandler, HotkeyHandler);

  // Inicializa com as ações do prompter (se módulo carregou)
  if (typeof HotkeyHandler !== 'undefined' && HotkeyHandler) {
    console.log('🎹 Inicializando HotkeyHandler...');
    HotkeyHandler.init({
      actions: {
        stopExit: () => {
          // Sai do fullscreen ou para o scroll
          if (document.body.classList.contains("operator-fullscreen-mode")) {
            document.body.classList.remove("operator-fullscreen-mode");
            ipcRenderer.send("control-window", "fullscreen");
          } else {
            ScrollEngine.stop();
          }
        },
        pauseResume: () => {
          if (ScrollEngine.isRunning) {
            ScrollEngine.pause();
          } else {
            ScrollEngine.start();
          }
        },
        scrollForward: () => {
          ScrollEngine.changeSpeedBy(5);
        },
        scrollBackward: () => {
          ScrollEngine.changeSpeedBy(-5);
        },
        reverseScroll: () => {
          // Inverte a direção do scroll
          const currentSpeed = ScrollEngine.speed || 0;
          ScrollEngine.setSpeed(-currentSpeed);
        },
        previousLine: () => {
          // Volta uma linha
          const container = document.querySelector(".prompter-in-control");
          if (container) {
            const lineHeight = parseInt(getComputedStyle(container).lineHeight) || 30;
            container.scrollTop -= lineHeight;
            ScrollEngine.decimalScroll = container.scrollTop;
          }
        },
        nextLine: () => {
          // Avança uma linha
          const container = document.querySelector(".prompter-in-control");
          if (container) {
            const lineHeight = parseInt(getComputedStyle(container).lineHeight) || 30;
            container.scrollTop += lineHeight;
            ScrollEngine.decimalScroll = container.scrollTop;
          }
        },
        previousCue: () => {
          // Implementar navegação de cue markers
          console.log("Previous Cue - TODO");
        },
        nextCue: () => {
          // Implementar navegação de cue markers
          console.log("Next Cue - TODO");
        },
        jumpStart: () => {
          // Volta ao início
          ScrollEngine.stop();
          const container = document.querySelector(".prompter-in-control");
          if (container) {
            container.scrollTop = 0;
            ScrollEngine.decimalScroll = 0;
          }
        },
        showHideCue: () => {
          // Toggle visibilidade do cue marker
          const cueMarker = document.querySelector(".cue-marker");
          if (cueMarker) {
            cueMarker.style.display = cueMarker.style.display === 'none' ? '' : 'none';
          }
        }
      },
      settings: globalPrefs || {}
    });

    // Ativa hotkeys quando entra na aba Operator
    document.querySelectorAll('[data-bs-toggle="tab"]').forEach(tab => {
      tab.addEventListener('shown.bs.tab', (e) => {
        const targetId = e.target.getAttribute('data-bs-target');
        if (targetId === '#operator-tab-pane') {
          if (HotkeyHandler) HotkeyHandler.enable();
        } else {
          if (HotkeyHandler) HotkeyHandler.disable();
        }
      });
    });
  } // Fim do if (HotkeyHandler)

  // Handler legado para teclas não configuráveis (mantido para compatibilidade)
  document.addEventListener("keydown", (e) => {
    const operatorPane = document.getElementById("operator-tab-pane");
    if (!operatorPane || !operatorPane.classList.contains("show")) return;

    // Só trata Escape para fullscreen (resto é pelo HotkeyHandler)
    if (e.key === "Escape") {
      if (document.body.classList.contains("operator-fullscreen-mode")) {
        document.body.classList.remove("operator-fullscreen-mode");
        ipcRenderer.send("control-window", "fullscreen");
      }
    }
  });

  // ============================================================
  // SEÇÃO 24: TRANSFORMAÇÃO DE CAIXA (UPPER/LOWER/TITLE)
  // ============================================================
  // Converte texto selecionado para maiúsculas, minúsculas ou título

  /**
   * Altera a caixa do texto selecionado
   * @param {string} type - 'upper', 'lower' ou 'title'
   */
  function changeCase(type) {
    const editor = document.querySelector(".text-editor-area");
    if (!editor) return;

    editor.focus();
    const selection = window.getSelection();

    // Se não tiver nada selecionado, não faz nada
    if (selection.toString().length === 0) return;

    const text = selection.toString();
    let newText = text;

    // Aplica a transformação
    switch (type) {
      case "upper":
        newText = text.toUpperCase();
        break;
      case "lower":
        newText = text.toLowerCase();
        break;
      case "title":
        // Transforma a primeira letra de cada palavra em maiúscula
        newText = text.toLowerCase().replace(/(?:^|\s)\w/g, function (match) {
          return match.toUpperCase();
        });
        break;
    }

    // Substitui o texto mantendo o histórico de desfazer (Undo)
    document.execCommand("insertText", false, newText);

    // (Opcional) Sincroniza imediatamente com o prompter
    if (typeof syncContentToPrompter === "function") syncContentToPrompter();
  }

  // ============================================================
  // SEÇÃO 25: HELPERS DE IDIOMA E SELEÇÃO
  // ============================================================
  // Detecta idioma do texto e gerencia seleção do cursor

  /**
   * Detecta se o texto está em português ou inglês
   * @param {string} text - Texto para análise
   * @returns {string} - Código do idioma (pt-BR ou en-US)
   */
  function detectLanguage(text) {
    if (!text || typeof text !== "string") return "pt-BR";
    const cleanText = text
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .substring(0, 500);
    if (cleanText.trim().length < 5) return "pt-BR";
    const enCount = (cleanText.match(/\b(the|and|is|it|you|that)\b/g) || [])
      .length;
    const ptCount = (cleanText.match(/\b(o|a|e|que|para|com|você)\b/g) || [])
      .length;
    return enCount > ptCount ? "en-US" : "pt-BR";
  }

  function getActiveDocument() {
    return documents.find((doc) => doc.id === activeDocumentId);
  }

  function getActiveTextEditorArea() {
    if (!activeDocumentId) return null;
    const container = document.getElementById(`doc-${activeDocumentId}`);
    return container ? container.querySelector(".text-editor-area") : null;
  }

  function saveSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
      const editor = getActiveTextEditorArea();
      if (editor && editor.contains(sel.anchorNode)) {
        lastSelectionRange = sel.getRangeAt(0);
      }
    }
  }

  // ============================================================
  // === RESTORE SELECTION (Se não existir no seu código)
  // ============================================================

  function restoreSelection() {
    const editor = getActiveTextEditorArea();
    if (lastSelectionRange && editor) {
      editor.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(lastSelectionRange);
    }
  }

  // ============================================================
  // SEÇÃO 26: VERIFICAÇÃO ORTOGRÁFICA
  // ============================================================
  // Aplica configurações de spellcheck e atualiza estado do menu

  function applySpellCheckSettings() {
    const editor = getActiveTextEditorArea();
    const activeDoc = getActiveDocument();
    if (!activeDoc || !editor) return;
    const textContent = editor.innerText || "";
    activeDoc.detectedLanguage = detectLanguage(textContent);
    editor.spellcheck = activeDoc.isSpellCheckActive;
    editor.lang = activeDoc.detectedLanguage;
    ipcRenderer.send("set-spell-check-language", activeDoc.detectedLanguage);
    updateSpellCheckMenuState(activeDoc.isSpellCheckActive);
  }

  // ============================================================
  // SEÇÃO 27: ESTADO DO MENU DE FORMATAÇÃO
  // ============================================================
  // Atualiza checks visuais dos menus (negrito, itálico, alinhamento)

  /**
   * Define estado visual de um item de menu (checked/unchecked)
   */
  function setMenuCheckState(action, isActive, value = null) {
    let selector = `.menu-item[data-action="${action}"]`;
    if (value !== null) selector += `[data-value="${value}"]`;
    const items = document.querySelectorAll(selector);
    items.forEach((item) => {
      if (isActive) {
        item.classList.add("checked");
        let span = item.querySelector(".menu-shortcut");
        if (!span) {
          span = document.createElement("span");
          span.className = "menu-shortcut";
          item.appendChild(span);
        }
        span.textContent = "✓";
        span.style.color = "var(--primary-color)";
        span.style.fontWeight = "bold";
      } else {
        item.classList.remove("checked");
        const span = item.querySelector(".menu-shortcut");
        if (span && span.textContent === "✓") {
          span.textContent = "";
        }
      }
    });
  }

  function updateSpellCheckMenuState(isActive) {
    setMenuCheckState("spell-check", isActive);
  }

  function updateFormatMenuState() {
    // 1. Garante que temos um editor
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    // ==========================================================
    // PARTE 1: ATUALIZA O MENU SUPERIOR (Negrito, Itálico, Fontes)
    // ==========================================================

    // Checks de Estilo (B, I, U)
    const isBold = document.queryCommandState("bold");
    const isItalic = document.queryCommandState("italic");
    const isUnderline = document.queryCommandState("underline");

    setMenuCheckState("set-style-bold", isBold);
    setMenuCheckState("set-style-italic", isItalic);
    setMenuCheckState("set-style-underline", isUnderline);

    // Checks de Alinhamento
    setMenuCheckState("align-left", document.queryCommandState("justifyLeft"));
    setMenuCheckState(
      "align-center",
      document.queryCommandState("justifyCenter")
    );
    setMenuCheckState(
      "align-right",
      document.queryCommandState("justifyRight")
    );

    // ==========================================================
    // PARTE 2: ATUALIZA A BARRA DE FERRAMENTAS (Visual Cinza)
    // ==========================================================

    // Função para ligar/desligar o visual "afundado"
    const toggleToolBtn = (btnId, active) => {
      const btn = document.getElementById(btnId);
      if (btn) {
        if (active) btn.classList.add("tool-active");
        else btn.classList.remove("tool-active");
      }
    };

    toggleToolBtn("bold-btn", isBold);
    toggleToolBtn("italic-btn", isItalic);
    toggleToolBtn("underline-btn", isUnderline);

    // --- LEITURA DO TEXTO SELECIONADO ---
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      let element =
        selection.anchorNode.nodeType === 1
          ? selection.anchorNode
          : selection.anchorNode.parentElement;
      const computedStyle = window.getComputedStyle(element);

      // --- VISUAL DOS BOTÕES DE ALINHAMENTO ---
      const textAlign = computedStyle.textAlign;
      const alignLeftBtn = document.getElementById("align-left-btn");
      const alignCenterBtn = document.getElementById("align-center-btn");
      const alignRightBtn = document.getElementById("align-right-btn");

      if (alignLeftBtn) alignLeftBtn.classList.remove("tool-active");
      if (alignCenterBtn) alignCenterBtn.classList.remove("tool-active");
      if (alignRightBtn) alignRightBtn.classList.remove("tool-active");

      if (textAlign === "center") {
        if (alignCenterBtn) alignCenterBtn.classList.add("tool-active");
      } else if (textAlign === "right") {
        if (alignRightBtn) alignRightBtn.classList.add("tool-active");
      } else {
        if (alignLeftBtn) alignLeftBtn.classList.add("tool-active");
      }

      // --- VISUAL DO BOTÃO MARCADOR ---
      const bookmarkBtn = document.getElementById("bookmark-btn");
      if (bookmarkBtn) {
        bookmarkBtn.classList.remove("tool-active");
        if (
          (element.tagName === "A" && element.hasAttribute("name")) ||
          element.id
        ) {
          bookmarkBtn.classList.add("tool-active");
        }
      }

    }

    // ==========================================================
    // PARTE 4: CHANGE CASE
    // ==========================================================
    if (typeof updateChangeCaseMenuState === "function") {
      updateChangeCaseMenuState();
    }
  }

  // ============================================================
  // SEÇÃO 28: GERENCIAMENTO DE DOCUMENTOS
  // ============================================================
  // Criação, ativação e fechamento de documentos (abas)

  /**
   * Cria um novo documento no editor
   * @param {string} content - Conteúdo inicial do documento
   * @param {string} name - Nome do arquivo (ou null para gerar)
   * @param {string} path - Caminho completo do arquivo (ou null se novo)
   * @returns {Object} - Objeto do documento criado
   */
  function createNewDocument(content = "", name = null, path = null) {
    console.log("📝 Criando novo documento:", { name, path });

    let finalName = name;
    if (!finalName) {
      let num = 1;
      while (documents.some((d) => d.name === `Untitled ${num}.txt`)) num++;
      finalName = `Untitled ${num}.txt`;
    }

    const newId = nextDocumentId++;

    const newDoc = {
      id: newId,
      name: finalName,
      path: path,
      saved: !!path,
      isSpellCheckActive: true,
      detectedLanguage: "pt-BR",
      content: content,
    };
    documents.push(newDoc);

    const newTab = document.createElement("div");
    newTab.classList.add("document-tab", "d-inline-flex");
    newTab.dataset.target = newId;
    newTab.innerHTML = `<span>${finalName}</span> <i class="bi bi-x-lg close-tab" data-id="${newId}"></i>`;
    documentTabsBar.appendChild(newTab);

    const editorContainer = document.createElement("div");
    editorContainer.id = `doc-${newId}`;
    editorContainer.classList.add("editor-container");

    const editor = document.createElement("div");
    editor.classList.add("text-editor-area");
    editor.contentEditable = "true";

    // ========== CORREÇÃO 1: LIMPAR A FORMATAÇÃO ANTIGA ==========
    // Se houver conteúdo, limpa as tags antigas antes de colocar
    if (content) {
      editor.innerHTML = cleanOldFormatting(content);
    } else {
      editor.innerHTML = "";
    }

    editor.style.outline = "none";
    editor.style.overflowY = "auto";
    editor.spellcheck = true;

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
        syncContentToPrompter();
        updateFormatMenuState();
      }, 10);
    });

    editor.addEventListener("input", () => {
      markDocumentAsUnsaved(newId);
      syncContentToPrompter();
      scheduleAutoSave();
    });

    editor.addEventListener("mouseup", () => {
      saveSelection();
      updateFormatMenuState();
    });

    editor.addEventListener("keyup", () => {
      saveSelection();
      updateFormatMenuState();
    });

    editor.addEventListener("click", () => {
      saveSelection();
      updateFormatMenuState();
    });

    editor.addEventListener("focus", () => {
      console.log("✅ Editor recebeu foco");
      updateEditMenuState();
      document.execCommand("styleWithCSS", false, true);
      applySpellCheckSettings();
      updateFormatMenuState();
    });

    editor.addEventListener("blur", saveSelection);

    editorContainer.appendChild(editor);
    documentContentContainer.appendChild(editorContainer);

    if (typeof applySettingsToVisuals === "function") {
      applySettingsToVisuals();
    }

    if (typeof syncInterfaceWithPreferences === "function") {
      syncInterfaceWithPreferences();
    }

    syncContentToPrompter();

    activateDocument(newId);
    ipcRenderer.send("request-initial-settings");

    console.log("✅✅ DOCUMENTO CRIADO COM SUCESSO - ID:", newId);
    return newDoc;
  }

  /**
   * Ativa um documento pelo ID (mostra aba e editor correspondente)
   * @param {number} id - ID do documento a ativar
   */

  function activateDocument(targetId) {
    console.log("🎯 Ativando documento:", targetId);

    // Se já está ativo, não faz nada
    if (activeDocumentId === targetId) {
      console.log("⏭️ Documento já estava ativo");
      return;
    }

    // Limpa highlights de busca
    clearSearchHighlights();

    // Remove "active" de todas as abas
    document
      .querySelectorAll(".document-tab")
      .forEach((t) => t.classList.remove("active"));

    // Remove "active" de todos os containers
    document
      .querySelectorAll(".editor-container")
      .forEach((e) => e.classList.remove("active"));

    // Adiciona "active" apenas ao documento escolhido
    const tab = document.querySelector(
      `.document-tab[data-target="${targetId}"]`
    );
    const container = document.getElementById(`doc-${targetId}`);

    if (tab) {
      tab.classList.add("active");
      console.log("✅ Aba marcada como ativa");
    }

    if (container) {
      container.classList.add("active");
      console.log("✅ Container marcado como ativo");
    }

    // Atualiza a variável global
    activeDocumentId = targetId;
    const doc = getActiveDocument();

    console.log("📄 Documento ativo agora:", doc);

    if (doc) {
      // Atualiza o título da janela
      updateTitle();

      // Sincroniza com o Operator
      syncContentToPrompter();

      // Coloca o foco no editor
      const editor = getActiveTextEditorArea();
      if (editor) {
        editor.focus();
        console.log("✅ Foco no editor");
      }

      // Atualiza menus
      updateEditMenuState();
      applySpellCheckSettings();
      updateFormatMenuState();

      console.log("✅ Tudo sincronizado!");
    }
  }

  function activateDocument(targetId) {
    if (activeDocumentId === targetId) return;
    clearSearchHighlights();

    document
      .querySelectorAll(".document-tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".editor-container")
      .forEach((e) => e.classList.remove("active"));

    const tab = document.querySelector(
      `.document-tab[data-target="${targetId}"]`
    );
    const container = document.getElementById(`doc-${targetId}`);
    if (tab) tab.classList.add("active");
    if (container) container.classList.add("active");

    activeDocumentId = targetId;
    const doc = getActiveDocument();
    if (doc) {
      updateTitle();
      syncContentToPrompter();
      getActiveTextEditorArea()?.focus();
      updateEditMenuState();
      applySpellCheckSettings();
      updateFormatMenuState();
    }
  }

  function closeDocument(editorId) {
    const doc = documents.find((d) => d.id === editorId);
    if (doc && !doc.saved)
      ipcRenderer.send("confirm-close-dialog", editorId, doc.name);
    else removeDocumentFromDOM(editorId);
  }

  function removeDocumentFromDOM(editorId) {
    documents = documents.filter((d) => d.id !== editorId);
    document.getElementById(`doc-${editorId}`)?.remove();
    document
      .querySelector(`.document-tab[data-target="${editorId}"]`)
      ?.remove();

    if (documents.length > 0)
      activateDocument(documents[documents.length - 1].id);
    else {
      activeDocumentId = null;
      updateTitle();
      syncContentToPrompter();
      bootstrap.Tab.getOrCreateInstance(
        document.getElementById("home-tab")
      ).show();
    }
  }

  if (homeTabBtn) homeTabBtn.addEventListener("click", () => showHomeDefault());

  documentTabsBar?.addEventListener("click", (e) => {
    const closeBtn = e.target.closest(".close-tab");
    const tab = e.target.closest(".document-tab");
    if (closeBtn) {
      e.stopPropagation();
      closeDocument(parseInt(closeBtn.dataset.id));
    } else if (tab) activateDocument(parseInt(tab.dataset.target));
  });

  function scheduleAutoSave() {
    if (!isAutoSaveEnabled) return;
    if (autoSaveTimeoutId) clearTimeout(autoSaveTimeoutId);
    autoSaveTimeoutId = setTimeout(() => {
      const editor = getActiveTextEditorArea();
      const doc = getActiveDocument();
      if (editor && doc) {
        const rawContent = getCleanContent(editor);
        saveCurrentDocumentDirect(rawContent, doc);
      }
    }, 1000);
  }

  function saveCurrentDocumentDirect(content, doc) {
    if (!content) content = "";
    if (doc.path) {
      ipcRenderer.send("save-file-direct", content, doc.id, doc.path);
      doc.saved = true;
      updateTabTitle(doc.id, doc.name, true);
    } else {
      ipcRenderer.send("save-file-dialog", content, doc.id, doc.name);
    }
  }

  function showHomeDefault() {
    if (homeContentDefault) homeContentDefault.classList.remove("d-none");
    if (homeContentRecent) homeContentRecent.classList.add("d-none");
  }

  // SUBSTITUA A FUNÇÃO updateTabTitle POR ESTA:
  function updateTabTitle(id, name, saved) {
    // Pega o elemento de texto dentro da aba
    const tabSpan = document.querySelector(`.document-tab[data-target="${id}"] span`);

    if (tabSpan) {
      if (saved) {
        // Se estiver salvo: mostra apenas o nome
        tabSpan.innerHTML = name;
      } else {
        // Se NÃO estiver salvo: mostra Bolinha + Nome
        tabSpan.innerHTML = `<span class="unsaved-dot"></span>${name}`;
      }
    }

    // Atualiza também o título da janela (lá no topo do Windows)
    if (id === activeDocumentId) updateTitle();
  }

  function updateTitle() {
    const doc = getActiveDocument();
    const title = doc ? `Editor: ${doc.name}${doc.saved ? "" : "*"}` : "Editor";
    document.getElementById("window-title-display").textContent = title;
    ipcRenderer.send("set-window-title", title);
  }

  function markDocumentAsUnsaved(id) {
    const doc = documents.find((d) => d.id === id);
    if (doc && doc.saved) {
      doc.saved = false;
      updateTabTitle(id, doc.name, false);
    }
  }

  // ============================================================
  // SEÇÃO 29: MENU DE EDIÇÃO E ESTILOS
  // ============================================================
  // Atualiza estado do menu e aplica formatação

  function updateEditMenuState() {
    const editor = getActiveTextEditorArea();
    const enabled = !!editor;
    const actions = ["spell-check", "find", "find-replace"];
    actions.forEach((action) => {
      const el = document.querySelector(`.menu-item[data-action="${action}"]`);
      if (el)
        enabled
          ? el.classList.remove("disabled")
          : el.classList.add("disabled");
    });
  }

  function applyStyle(command, value = null) {
    restoreSelection();
    document.execCommand(command, false, value);
    const editor = getActiveTextEditorArea();
    if (editor) editor.focus();
    markDocumentAsUnsaved(activeDocumentId);
    syncContentToPrompter();
    updateFormatMenuState();
  }

  function applyLineSpacing(value) {
    restoreSelection();
    const editor = getActiveTextEditorArea();
    if (!editor) return;
    applyStyle("formatBlock", "div");
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      let node = selection.anchorNode;
      if (node.nodeType === 3) node = node.parentNode;
      node.style.lineHeight = value;
    }
    markDocumentAsUnsaved(activeDocumentId);
    syncContentToPrompter();
  }

  // ============================================================
  // SEÇÃO 30: BUSCA E SUBSTITUIÇÃO (FIND & REPLACE)
  // ============================================================
  // Sistema de busca com highlight e navegação entre ocorrências

  /**
   * Limpa todos os destaques de busca do editor
   */
  function clearSearchHighlights() {
    const editor = getActiveTextEditorArea();
    if (!editor) return;
    let nodeToRestore = null;
    const activeSpan = searchState.matches[searchState.currentMatchIndex];
    const highlights = editor.querySelectorAll(".find-match");
    highlights.forEach((span) => {
      const parent = span.parentNode;
      if (parent) {
        const textNode = document.createTextNode(span.textContent);
        parent.replaceChild(textNode, span);
        if (span === activeSpan) nodeToRestore = textNode;
      }
    });
    searchState.matches = [];
    searchState.currentMatchIndex = -1;
    if (nodeToRestore) {
      const range = document.createRange();
      range.selectNodeContents(nodeToRestore);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (nodeToRestore.parentElement)
        nodeToRestore.parentElement.scrollIntoView({
          behavior: "auto",
          block: "nearest",
        });
    }
  }

  function getCleanContent(editor) {
    if (!editor) return "";
    const clone = editor.cloneNode(true);
    const highlights = clone.querySelectorAll(".find-match");
    highlights.forEach((span) => {
      const parent = span.parentNode;
      parent.replaceChild(document.createTextNode(span.textContent), span);
    });
    return clone.innerHTML;
  }

  function highlightMatches(term) {
    clearSearchHighlights();
    if (!term) {
      if (modalFindCountSpan) modalFindCountSpan.textContent = "0 de 0";
      return;
    }
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    // Opções de busca
    const caseSensitive = findCaseSensitive?.checked || false;
    const wholeWord = findWholeWord?.checked || false;

    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Monta regex baseado nas opções
    let regexPattern;
    if (wholeWord) {
      regexPattern = `(?<!\\p{L})${escapedTerm}(?!\\p{L})`;
    } else {
      regexPattern = escapedTerm;
    }

    const regexFlags = caseSensitive ? "gu" : "giu";
    const regex = new RegExp(regexPattern, regexFlags);

    const textNodes = [];
    const walker = document.createTreeWalker(
      editor,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

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
        for (let j = matchesInNode.length - 1; j >= 0; j--) {
          const m = matchesInNode[j];
          const matchNode = textNode.splitText(m.index);
          matchNode.splitText(m.length);
          const span = document.createElement("span");
          span.className = "find-match";
          span.textContent = matchNode.textContent;
          parent.replaceChild(span, matchNode);
          matchCount++;
        }
      }
    }
    searchState.matches = Array.from(editor.querySelectorAll(".find-match"));
    if (modalFindCountSpan)
      modalFindCountSpan.textContent =
        matchCount > 0 ? `Encontrados: ${matchCount}` : "0 de 0";
  }

  function navigateToMatch(direction) {
    if (searchState.matches.length === 0) return;

    if (
      searchState.currentMatchIndex >= 0 &&
      searchState.matches[searchState.currentMatchIndex]
    ) {
      searchState.matches[searchState.currentMatchIndex].classList.remove(
        "active"
      );
    }

    if (direction === "next") {
      searchState.currentMatchIndex++;
      if (searchState.currentMatchIndex >= searchState.matches.length)
        searchState.currentMatchIndex = 0;
    } else {
      searchState.currentMatchIndex--;
      if (searchState.currentMatchIndex < 0)
        searchState.currentMatchIndex = searchState.matches.length - 1;
    }

    const currentSpan = searchState.matches[searchState.currentMatchIndex];
    if (currentSpan) {
      currentSpan.classList.add("active");
      currentSpan.scrollIntoView({ behavior: "smooth", block: "center" });
      if (modalFindCountSpan)
        modalFindCountSpan.textContent = `${searchState.currentMatchIndex + 1
          } de ${searchState.matches.length}`;
    }
  }

  function replaceCurrent() {
    const searchTerm = modalFindInput.value;
    if (!searchTerm) return;

    // Se não tem matches ainda, busca primeiro
    if (searchState.matches.length === 0) {
      highlightMatches(searchTerm);
      if (searchState.matches.length > 0) {
        searchState.currentMatchIndex = 0;
        const firstSpan = searchState.matches[0];
        if (firstSpan) {
          firstSpan.classList.add("active");
          firstSpan.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (modalFindCountSpan) {
          modalFindCountSpan.textContent = `1 de ${searchState.matches.length}`;
        }
      }
      return;
    }

    // Se não tem match ativo, vai para o primeiro
    if (searchState.currentMatchIndex === -1) {
      searchState.currentMatchIndex = 0;
    }

    // Garante que o índice está dentro do range
    if (searchState.currentMatchIndex >= searchState.matches.length) {
      searchState.currentMatchIndex = 0;
    }

    const currentSpan = searchState.matches[searchState.currentMatchIndex];
    if (!currentSpan || !currentSpan.parentNode) {
      highlightMatches(searchTerm);
      return;
    }

    // === VERIFICA SE A SUBSTITUIÇÃO CONTÉM O TERMO BUSCADO ===
    const replaceText = modalReplaceInput.value || "";
    const caseSensitive = findCaseSensitive?.checked || false;

    // Verifica se após substituir o match ainda vai existir
    // (quando a palavra substituída contém a palavra buscada)
    let matchWillPersist = false;
    if (caseSensitive) {
      matchWillPersist = replaceText.includes(searchTerm);
    } else {
      matchWillPersist = replaceText.toLowerCase().includes(searchTerm.toLowerCase());
    }

    // SALVA O ÍNDICE ANTES DE QUALQUER MODIFICAÇÃO
    const savedIndex = searchState.currentMatchIndex;
    const totalMatchesBefore = searchState.matches.length;

    // === FAZ A SUBSTITUIÇÃO ===
    let newNode;
    if (findReplaceColor) {
      newNode = document.createElement("span");
      newNode.style.color = findReplaceColor;
      newNode.textContent = replaceText;
    } else {
      newNode = document.createTextNode(replaceText);
    }
    currentSpan.parentNode.replaceChild(newNode, currentSpan);

    markDocumentAsUnsaved(activeDocumentId);
    syncContentToPrompter();
    scheduleAutoSave();

    // === REFAZ A BUSCA ===
    highlightMatches(searchTerm);

    // === ATUALIZA PARA O PRÓXIMO MATCH ===
    if (searchState.matches.length > 0) {
      let nextIndex;

      if (matchWillPersist) {
        // Se o match persiste (ex: substituir "amor" por "amor" com cor),
        // precisamos AVANÇAR para o próximo, não ficar no mesmo
        nextIndex = savedIndex + 1;
        if (nextIndex >= searchState.matches.length) {
          nextIndex = 0;
        }
      } else {
        // O match foi removido, o próximo "cai" para a posição atual
        nextIndex = savedIndex;
        if (nextIndex >= searchState.matches.length) {
          nextIndex = 0;
        }
      }

      searchState.currentMatchIndex = nextIndex;

      // Remove active de todos e ativa o atual
      searchState.matches.forEach(m => m.classList.remove("active"));
      const nextSpan = searchState.matches[nextIndex];
      if (nextSpan) {
        nextSpan.classList.add("active");
        nextSpan.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      if (modalFindCountSpan) {
        modalFindCountSpan.textContent = `${nextIndex + 1} de ${searchState.matches.length}`;
      }
    } else {
      searchState.currentMatchIndex = -1;
      if (modalFindCountSpan) modalFindCountSpan.textContent = "0 de 0";
    }
  }

  function replaceAll() {
    const replaceText = modalReplaceInput.value || "";
    const highlights = document.querySelectorAll(".find-match");
    highlights.forEach((span) => {
      // Cria elemento com ou sem cor
      let newNode;
      if (findReplaceColor) {
        newNode = document.createElement("span");
        newNode.style.color = findReplaceColor;
        newNode.textContent = replaceText;
      } else {
        newNode = document.createTextNode(replaceText);
      }
      span.parentNode.replaceChild(newNode, span);
    });
    markDocumentAsUnsaved(activeDocumentId);
    syncContentToPrompter();
    scheduleAutoSave();
    highlightMatches(modalFindInput.value);
  }

  function showFindModal() {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    // Se está minimizado, apenas expande
    if (findIsActive && findMinimizedBar?.style.display !== "none") {
      findMinimizedBar.style.display = "none";
      findReplaceBootstrapModal.show();
      setTimeout(() => modalFindInput?.focus(), 100);
      return;
    }

    // Caso contrário, abre do zero
    clearSearchHighlights();
    modalFindInput.value = "";
    modalReplaceInput.value = "";
    if (modalFindCountSpan) modalFindCountSpan.textContent = "0 de 0";
    // Reseta a cor selecionada
    findReplaceColor = "";
    findColorPalette.forEach((b) => b.classList.remove("active"));
    findIsActive = true;
    if (findMinimizedBar) findMinimizedBar.style.display = "none";
    findReplaceBootstrapModal.show();
    setTimeout(() => modalFindInput?.focus(), 100);
  }

  modalFindInput?.addEventListener("input", (e) => {
    if (e.target.value.length > 0) highlightMatches(e.target.value);
    else {
      clearSearchHighlights();
      if (modalFindCountSpan) modalFindCountSpan.textContent = "";
    }
  });

  modalFindInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) navigateToMatch("prev");
      else navigateToMatch("next");
    }
  });

  if (modalFindNextBtn)
    modalFindNextBtn.addEventListener("click", () => navigateToMatch("next"));
  if (modalFindPrevBtn)
    modalFindPrevBtn.addEventListener("click", () => navigateToMatch("prev"));
  if (modalReplaceBtn)
    modalReplaceBtn.addEventListener("click", replaceCurrent);
  if (modalReplaceAllBtn)
    modalReplaceAllBtn.addEventListener("click", replaceAll);

  // Re-executa busca quando mudar as opções
  if (findCaseSensitive) {
    findCaseSensitive.addEventListener("change", () => {
      if (modalFindInput.value) highlightMatches(modalFindInput.value);
    });
  }
  if (findWholeWord) {
    findWholeWord.addEventListener("change", () => {
      if (modalFindInput.value) highlightMatches(modalFindInput.value);
    });
  }

  // Listeners da paleta de cores do Find/Replace
  findColorPalette.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Remove active de todos
      findColorPalette.forEach((b) => b.classList.remove("active"));
      // Adiciona active no clicado
      btn.classList.add("active");
      // Salva a cor selecionada
      findReplaceColor = btn.dataset.color || "";
      // Fecha o popup se estiver aberto
      if (findColorPopup) findColorPopup.style.display = "none";
    });
  });

  // ============================================================
  // PALETA EXPANDIDA DE CORES (MAIS CORES)
  // ============================================================

  // Usa a mesma paleta de cores da toolbar (presetColors já definida acima)
  // Não precisa redefinir, usa diretamente presetColors

  // Referência ao botão que foi clicado com botão direito
  let findTargetColorBtn = null;

  // Função para selecionar cor do popup
  function selectFindColor(color) {
    findReplaceColor = color;
    findColorPalette.forEach((b) => b.classList.remove("active"));

    // Se tem um botão alvo (clicou com botão direito), atualiza a cor dele
    if (findTargetColorBtn) {
      findTargetColorBtn.style.backgroundColor = color;
      findTargetColorBtn.dataset.color = color;
      findTargetColorBtn.classList.add("active");
      // Remove classes de swatch padrão para não conflitar
      findTargetColorBtn.className = findTargetColorBtn.className.replace(/swatch-\w+/g, '').trim();
      findTargetColorBtn.classList.add("find-color-btn", "active");
    }

    if (findColorPopup) findColorPopup.style.display = "none";
    findTargetColorBtn = null; // Limpa a referência
  }

  // Inicializa o popup de cores
  if (findColorPopup) {
    // Adiciona as cores (usa presetColors - mesma paleta da toolbar)
    presetColors.forEach((color) => {
      const colorBtn = document.createElement("button");
      colorBtn.className = "find-popup-color";
      colorBtn.style.backgroundColor = color;
      colorBtn.title = color;
      colorBtn.addEventListener("click", () => selectFindColor(color));
      findColorPopup.appendChild(colorBtn);
    });

    // Botão para cor personalizada
    const customBtn = document.createElement("button");
    customBtn.className = "find-custom-color-btn";
    customBtn.innerHTML = '<i class="bi bi-eyedropper"></i> Cor personalizada...';
    customBtn.addEventListener("click", () => {
      if (findHiddenColorPicker) findHiddenColorPicker.click();
    });
    findColorPopup.appendChild(customBtn);
  }

  // Clique direito nos botões de cor abre o popup
  findColorPalette.forEach((btn) => {
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Guarda referência do botão que foi clicado com botão direito
      findTargetColorBtn = btn;
      if (findColorPopup) {
        findColorPopup.style.display = "flex";
      }
    });
  });

  // Color picker nativo
  if (findHiddenColorPicker) {
    findHiddenColorPicker.addEventListener("input", (e) => {
      selectFindColor(e.target.value);
    });
  }

  // Fecha popup ao clicar fora
  document.addEventListener("click", (e) => {
    if (findColorPopup && findColorPopup.style.display === "flex") {
      if (!findColorPopup.contains(e.target) && !e.target.closest(".find-color-btn")) {
        findColorPopup.style.display = "none";
        findTargetColorBtn = null;
      }
    }
  });

  // ============================================================
  // MINIMIZAÇÃO DO MODAL FIND/REPLACE
  // ============================================================

  // Função para minimizar o modal (mostra a barra flutuante)
  function minimizeFindModal() {
    // Esconde o modal completo
    findReplaceBootstrapModal?.hide();

    // Atualiza a barra minimizada
    if (findMinimizedBar) {
      findMinimizedText.textContent = modalFindInput?.value || "Search...";
      const total = searchState.matches.length;
      const current = searchState.currentMatchIndex >= 0 ? searchState.currentMatchIndex + 1 : 0;
      findMinimizedCount.textContent = `${current}/${total}`;
      findMinimizedBar.style.display = "block";
    }

    findIsActive = true;
    // NÃO limpa os highlights - mantém ativo
  }

  // Função para expandir (reabrir o modal completo)
  function expandFindModal() {
    if (findMinimizedBar) findMinimizedBar.style.display = "none";
    findReplaceBootstrapModal?.show();
    setTimeout(() => modalFindInput?.focus(), 100);
  }

  // Função para fechar completamente
  function closeFindCompletely() {
    findIsActive = false;
    if (findMinimizedBar) findMinimizedBar.style.display = "none";
    findReplaceBootstrapModal?.hide();
    clearSearchHighlights();
  }

  // Atualiza contador na barra minimizada
  function updateMinimizedCount() {
    if (findMinimizedBar && findMinimizedBar.style.display !== "none") {
      const total = searchState.matches.length;
      const current = searchState.currentMatchIndex >= 0 ? searchState.currentMatchIndex + 1 : 0;
      findMinimizedCount.textContent = `${current}/${total}`;
    }
  }

  // Botão minimizar no modal
  if (findMinimizeBtn) {
    findMinimizeBtn.addEventListener("click", minimizeFindModal);
  }

  // Botão fechar do modal principal (X no header)
  const findCloseBtn = document.getElementById("findCloseBtn");
  if (findCloseBtn) {
    findCloseBtn.addEventListener("click", () => {
      findIsActive = false;
      if (findMinimizedBar) findMinimizedBar.style.display = "none";
      // O data-bs-dismiss já vai fechar o modal
      // clearSearchHighlights será chamado no evento hidden.bs.modal
    });
  }

  // Botão fechar do modal (no rodapé)
  const findCloseBtnFooter = document.getElementById("findCloseBtnFooter");
  if (findCloseBtnFooter) {
    findCloseBtnFooter.addEventListener("click", () => {
      findIsActive = false;
      if (findMinimizedBar) findMinimizedBar.style.display = "none";
    });
  }

  // Botões da barra minimizada
  if (findMinimizedExpand) {
    findMinimizedExpand.addEventListener("click", expandFindModal);
  }
  if (findMinimizedClose) {
    findMinimizedClose.addEventListener("click", closeFindCompletely);
  }
  if (findMinimizedPrev) {
    findMinimizedPrev.addEventListener("click", () => {
      navigateToMatch("prev");
      updateMinimizedCount();
    });
  }
  if (findMinimizedNext) {
    findMinimizedNext.addEventListener("click", () => {
      navigateToMatch("next");
      updateMinimizedCount();
    });
  }

  // Clique fora do modal minimiza (em vez de fechar)
  document.addEventListener("mousedown", (e) => {
    if (!findReplaceModal) return;

    // Verifica se o modal está aberto
    if (!findReplaceModal.classList.contains("show")) return;

    // Verifica se o clique foi fora do conteúdo do modal
    const modalContent = findReplaceModal.querySelector(".modal-content");
    if (modalContent && !modalContent.contains(e.target)) {
      // Clicou fora do modal - minimiza
      minimizeFindModal();
    }
  });

  // Override do evento hidden.bs.modal para não limpar highlights quando minimiza
  findReplaceModal?.addEventListener("hidden.bs.modal", () => {
    // Só limpa os highlights se realmente fechou (não minimizou)
    if (!findIsActive) {
      clearSearchHighlights();
      // Reseta posição do modal (drag) quando fecha de verdade
      const dialog = document.querySelector("#findReplaceModal .modal-dialog");
      if (dialog) dialog.style.transform = "none";
    }
    getActiveTextEditorArea()?.focus();
  });

  // ============================================================
  // SEÇÃO 31: CONTROLES VISUAIS DA OPERATOR TOOLBAR
  // ============================================================
  // Inversão de cores, espelhamento, margens e fullscreen

  if (opBtnInvert) {
    opBtnInvert.addEventListener("click", () => {
      operatorState.isInverted = !operatorState.isInverted;

      const bgColor = operatorState.isInverted ? "#FFFFFF" : "#000000";
      const defaultTextColor = operatorState.isInverted ? "#000000" : "#FFFFFF";

      if (prompterContainer) {
        // Aplica cor apenas no CONTAINER GERAL
        prompterContainer.style.backgroundColor = bgColor;
        prompterContainer.style.color = defaultTextColor;

        const textControl = document.getElementById("prompterText-control");
        if (textControl) textControl.style.color = defaultTextColor;

        // === REMOVIDO: O loop que forçava a cor nos filhos foi apagado ===
        // Agora ele respeita se o filho tiver <span style="color: red">
      }

      ipcRenderer.send("save-settings", {
        backgroundColor: bgColor,
        defaultFontColor: defaultTextColor,
      });

      // Ajusta a cor da seta (Cue Marker) para não sumir
      if (cueMarkerControl) {
        cueMarkerControl.style.color = operatorState.isInverted
          ? "#000000"
          : "var(--primary-color)";
      }
    });
  }

  if (opBtnMirrorH) {
    opBtnMirrorH.addEventListener("click", () => {
      operatorState.mirrorH = !operatorState.mirrorH;
      applyTransforms();
      opBtnMirrorH.classList.toggle("active", operatorState.mirrorH);
    });
  }

  if (opBtnMirrorV) {
    opBtnMirrorV.addEventListener("click", () => {
      // 1. Inverte o estado da variável (True/False)
      operatorState.mirrorV = !operatorState.mirrorV;

      // 2. Muda a cor do botão para você saber que está ligado
      opBtnMirrorV.classList.toggle("active", operatorState.mirrorV);

      // 3. ATENÇÃO: Removemos o "applyTransforms()" daqui para não virar o SEU monitor.
      // Em vez disso, enviamos apenas a configuração para o Main Process avisar a TV.

      ipcRenderer.send("save-settings", {
        flipVertical: operatorState.mirrorV // Criamos uma propriedade nova e clara
      });
    });
  }

  function applyTransforms() {
    const scaleX = operatorState.mirrorH ? "-1" : "1";
    const scaleY = operatorState.mirrorV ? "-1" : "1";
    const transformVal = `scale(${scaleX}, ${scaleY})`;
    if (prompterContainer) prompterContainer.style.transform = transformVal;
    ipcRenderer.send("save-settings", { mirrorMode: transformVal });
  }

  if (opBtnMargin) {
    // Definimos as margens em PIXELS
    operatorState.margins = [0, 100, 200, 300];

    opBtnMargin.addEventListener("click", () => {
      operatorState.marginIndex = (operatorState.marginIndex + 1) % operatorState.margins.length;

      const marginVal = operatorState.margins[operatorState.marginIndex];

      // 1. Aplica visualmente NO SEU PC (Para você ter uma prévia)
      const textControl = document.getElementById("prompterText-control");
      if (textControl) {
        textControl.style.paddingLeft = `${marginVal}px`;
        textControl.style.paddingRight = `${marginVal}px`;
      }

      // 2. Envia para a TV (Broadcast)
      ipcRenderer.send("save-settings", {
        prompterMargin: marginVal,
      });

      console.log("Margem alterada para:", marginVal + "px");
    });
  }

  if (opBtnFullscreen) {
    opBtnFullscreen.addEventListener("click", () => {
      document.body.classList.toggle("operator-fullscreen-mode");
      ipcRenderer.send("control-window", "fullscreen");
    });
  }

  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      document.body.classList.contains("operator-fullscreen-mode")
    ) {
      document.body.classList.remove("operator-fullscreen-mode");
      ipcRenderer.send("control-window", "fullscreen");
    }
  });

  if (opBtnReset) {
    opBtnReset.addEventListener("click", () => {
      ScrollEngine.stop();
      ipcRenderer.send("control-prompter", "stop");
    });
  }

  if (opBtnLoop) {
    opBtnLoop.addEventListener("click", () => {
      operatorState.isLooping = !operatorState.isLooping;
      opBtnLoop.classList.toggle("active", operatorState.isLooping);
      ipcRenderer.send("save-settings", {
        continuousLoop: operatorState.isLooping,
      });
    });
  }

  if (opBtnSettings) {
    opBtnSettings.addEventListener("click", () => {
      ipcRenderer.send("open-preferences-window");
    });
  }

  // ============================================================
  // SEÇÃO 32: CONTROLES DE PLAYBACK (PLAY/PAUSE/STOP)
  // ============================================================
  // Listeners dos botões de reprodução e slider de velocidade

  if (playBtn)
    playBtn.addEventListener("click", () => {
      ScrollEngine.start();
      ipcRenderer.send("control-prompter", "play");
    });

  if (pauseBtn)
    pauseBtn.addEventListener("click", () => {
      ScrollEngine.pause();
      ipcRenderer.send("control-prompter", "pause");
    });

  if (stopBtn)
    stopBtn.addEventListener("click", () => {
      ScrollEngine.stop();
      ipcRenderer.send("control-prompter", "stop");
    });

  if (speedSlider) {
    speedSlider.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      if (speedValueSpan) speedValueSpan.textContent = val;
      ScrollEngine.setSpeed(val);
      ipcRenderer.send("control-prompter", { command: "speed", value: val });
    });
  }

  // ============================================================
  // SEÇÃO 33: SINCRONIZAÇÃO EDITOR → PROMPTER
  // ============================================================
  // Envia conteúdo do editor para o prompter local e janela externa

  /**
   * Sincroniza conteúdo do editor com o prompter
   * Limpa formatação desnecessária e envia para main process
   */
  function syncContentToPrompter() {
    const editor = getActiveTextEditorArea();
    const control = document.getElementById("prompterText-control");

    // Se não tiver editor (fechou tudo), limpa a tela
    if (!editor) {
      if (control) {
        control.innerHTML = "";
        // 🔥 ENVIA PARA O MAIN PROCESS (Janela Externa)
        ipcRenderer.send("update-prompter-content", "");
      }
      return;
    }

    let content = getCleanContent(editor);

    // Limpa elementos temporários
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = content;

    const coloredElements = tempDiv.querySelectorAll("*");
    coloredElements.forEach((el) => {
      if (el.style.color) {
        const c = el.style.color.replace(/\s/g, "");
        if (c === "rgb(0,0,0)" || c === "black" || c === "#000000") {
          el.style.removeProperty("color");
        } else {
          el.style.setProperty("color", el.style.color, "important");
        }
      }

      if (el.style.backgroundColor) {
        const bg = el.style.backgroundColor.replace(/\s/g, "");
        if (bg === "transparent" || bg === "rgba(0,0,0,0)" || bg === "rgb(255,255,255)" || bg === "white") {
          el.style.removeProperty("background-color");
        } else {
          el.style.setProperty("background-color", el.style.backgroundColor, "important");
        }
      }
    });

    const finalContent = tempDiv.innerHTML;

    // 🔥 ENVIA PARA O MAIN PROCESS PRIMEIRO (Janela Externa)
    ipcRenderer.send("update-prompter-content", finalContent);

    // 🔥 ENVIA PARA ROTEIRISTAS REMOTOS (Wi-Fi Local)
    ipcRenderer.send("send-text-to-remote", finalContent);

    // Depois atualiza local
    if (control) {
      control.innerHTML = finalContent;

      const baseColor = operatorState.isInverted ? "#000000" : "#FFFFFF";
      control.style.color = baseColor;

      if (prompterContainer) {
        prompterContainer.style.backgroundColor = operatorState.isInverted ? "#FFFFFF" : "#000000";
      }

      const paragraphs = control.querySelectorAll("p, div, h1, h2, h3");
      paragraphs.forEach((p) => {
        if (!p.style.marginBottom) p.style.marginBottom = "0.5em";
        p.style.marginTop = "0";
      });

      if (typeof currentFontSizePT !== 'undefined' && currentFontSizePT > 0) {
        control.style.fontSize = `${currentFontSizePT}pt`;
        control.style.lineHeight = "1.4";
      }
    }

    prepararRoteiroParaLeitura();
  }

  // ============================================================
  // SEÇÃO 34: AÇÕES DO MENU PRINCIPAL
  // ============================================================
  // Handler central para todas as ações de menu (arquivo, edição, etc)

  /**
   * Executa ação de menu baseada no payload recebido
   * @param {string|Object} payload - Nome da ação ou objeto {action, value}
   */
  window.performMenuAction = function performMenuAction(payload) {
    const action = typeof payload === "string" ? payload : payload.action;
    const value = typeof payload === "object" ? payload.value : null;
    const doc = getActiveDocument();
    const editor = getActiveTextEditorArea();

    switch (action) {
      case "new-script":
        createNewDocument();
        bootstrap.Tab.getOrCreateInstance(
          document.getElementById("edit-tab")
        ).show();
        break;
      case "open-script":
        ipcRenderer.send("open-file-dialog");
        break;
      case "open-file-in-new-window":
        ipcRenderer.send("open-file-dialog-new-window");
        break;
      case "open-recent":
        if (recentFilesList && recentFilesList.children.length > 0) {
          const latestFilePath = recentFilesList.children[0].dataset.filepath;
          if (latestFilePath)
            ipcRenderer.send("reopen-recent-file", latestFilePath);
        } else {
          ipcRenderer.send(
            "show-error-dialog",
            "Recentes",
            "Nenhum arquivo recente encontrado."
          );
        }
        break;
      case "clear-recent":
        if (recentFilesList) recentFilesList.innerHTML = "";
        ipcRenderer.send("clear-recent-files-data");
        break;
      case "save-script":
        if (doc && editor) {
          const content = getCleanContent(editor);
          saveCurrentDocumentDirect(content, doc);
        }
        break;
      case "save-as-script":
        if (doc && editor) {
          const content = getCleanContent(editor);
          ipcRenderer.send("save-file-dialog", content, doc.id, doc.name);
        }
        break;
      case "close-document":
        if (activeDocumentId) closeDocument(activeDocumentId);
        break;
      case "revert-to-saved":
        if (doc && doc.path)
          ipcRenderer.send("revert-file-content", doc.path, doc.id);
        break;
      case "print-document":
        ipcRenderer.send("print-document");
        break;
      case "import-backup":
        ipcRenderer.send("open-backup-file");
        break;
      case "open-preferences":
        ipcRenderer.send("open-preferences-window");
        break;

      case "toggle-find-replace":
        if (window.findReplaceBootstrapModal) {
          window.findReplaceBootstrapModal.toggle();
        }
        break;

      case "spell-check":
        if (doc && editor) {
          doc.isSpellCheckActive = !doc.isSpellCheckActive;
          applySpellCheckSettings();
          const status = doc.isSpellCheckActive ? "ON" : "OFF";
          ipcRenderer.send("show-info-dialog", "Spell Checker", `The Spell Checker was: ${status}.`);
        }
        break;
      case "find":
      case "find-replace":
        showFindModal();
        break;

      case "set-style-bold":
        applyStyle("bold");
        break;
      case "set-style-italic":
        applyStyle("italic");
        break;
      case "set-style-underline":
        applyStyle("underline");
        break;
      case "set-font":
        document.execCommand("fontName", false, value);
        // Sincroniza a barra visualmente
        updateFontUIState(value, document.getElementById('font-size-select')?.value);
        break;
      case "set-size":
        // CHAMA A FUNÇÃO DE TAMANHO REAL (PT)
        applyExactFontSize(value);
        break;
      case "align-left":
        applyStyle("justifyLeft");
        break;
      case "align-center":
        applyStyle("justifyCenter");
        break;
      case "align-right":
        applyStyle("justifyRight");
        break;
      case "set-spacing":
        applyLineSpacing(value);
        break;

      case "auto-save":
        isAutoSaveEnabled = !isAutoSaveEnabled;
        const item = document.querySelector(
          '#dropdown-file .menu-item[data-action="auto-save"]'
        );
        if (item) {
          isAutoSaveEnabled
            ? item.classList.add("checked")
            : item.classList.remove("checked");
          let span = item.querySelector(".menu-shortcut");
          if (!span) {
            span = document.createElement("span");
            span.className = "menu-shortcut";
            item.appendChild(span);
          }
          if (isAutoSaveEnabled) {
            span.textContent = "✓";
            span.style.color = "var(--primary-color)";
            span.style.fontWeight = "bold";
          } else {
            span.textContent = "";
            span.style.color = "";
            span.style.fontWeight = "";
          }
        }
        ipcRenderer.send(
          "show-info-dialog",
          "Auto Save",
          `Auto Save: ${isAutoSaveEnabled ? "ON" : "OFF"}`
        );
        break;
      case "exit-app":
        ipcRenderer.send("control-window", "exit");
        break;

      case "about":
        // Corrigido: Apenas um https://
        require('electron').shell.openExternal("https://roteiro.promptiq.com.br/");
        break;

      /// === ADICIONE ISTO PARA O MENU FORMAT > CHANGE CASE FUNCIONAR ===
      case "set-case-upper":
        changeCase("upper");
        break;

      case "set-case-lower":
        changeCase("lower");
        break;

      case "set-case-title":
        changeCase("title");
        break;

      // === TEMA LIGHT/DARK ===
      case "theme-light":
        document.documentElement.removeAttribute('data-theme');
        document.body.classList.remove('dark-mode');
        ipcRenderer.send('set-app-theme', 'light');
        break;

      case "theme-dark":
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.classList.add('dark-mode');
        ipcRenderer.send('set-app-theme', 'dark');
        break;

      // === ADICIONE ISTO PARA O ESPAÇAMENTO DE LINHA FUNCIONAR ===
      case "set-spacing":
        applyLineSpacing(value); // Essa função já chama o syncContentToPrompter
        break;
    }
    hideAllCustomMenus();
  }

  // ============================================================
  // SEÇÃO 35: LISTENERS DA SIDEBAR HOME
  // ============================================================
  // Botões de novo script, abrir, salvar, preferências e recentes

  if (newScriptBtn)
    newScriptBtn.addEventListener("click", () => {
      createNewDocument();
      bootstrap.Tab.getOrCreateInstance(
        document.getElementById("edit-tab")
      ).show();
    });
  if (openScriptBtn)
    openScriptBtn.addEventListener("click", () =>
      ipcRenderer.send("open-file-dialog")
    );
  if (saveScriptBtn)
    saveScriptBtn.addEventListener("click", () =>
      performMenuAction("save-as-script")
    );
  if (optionsLink)
    optionsLink.addEventListener("click", () =>
      ipcRenderer.send("open-preferences-window")
    );
  if (recentLink)
    recentLink.addEventListener("click", () => {
      if (homeContentDefault) homeContentDefault.classList.add("d-none");
      if (homeContentRecent) homeContentRecent.classList.remove("d-none");
    });

  // ============================================================
  // SEÇÃO 36: LISTENERS DA TOOLBAR DO EDITOR
  // ============================================================
  // Botões de negrito, itálico, sublinhado, fonte e tamanho

  // Listeners Toolbar Editor
  boldBtn?.addEventListener("click", () => applyStyle("bold"));
  italicBtn?.addEventListener("click", () => applyStyle("italic"));
  underlineBtn?.addEventListener("click", () => applyStyle("underline"));

  const toolbarFontSelect = document.getElementById('font-family-select');
  const toolbarSizeSelect = document.getElementById('font-size-select');

  // Listener da Fonte (Arial, Verdana...)
  if (toolbarFontSelect) {
    toolbarFontSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      // Aplica fonte
      document.execCommand("fontName", false, val);

      // Sincroniza UI (Pega o tamanho atual para não perder)
      const currentSize = toolbarSizeSelect ? toolbarSizeSelect.value : null;

      // Chama a função de sincronia que criamos no passo anterior
      if (typeof updateFontUIState === 'function') {
        updateFontUIState(val, currentSize);
      }

      // ENVIA PARA OS REMOTOS (Roteiristas conectados)
      ipcRenderer.send('send-style-to-remote', {
        type: 'fontFamily',
        value: val,
        name: 'Host'
      });

      // Foco de volta no editor
      const editor = document.querySelector('.text-editor-area');
      if (editor) editor.focus();
    });
  }





  fontFamilySelect?.addEventListener("change", () => {
    applyStyle("fontName", fontFamilySelect.value);
    getActiveTextEditorArea()?.focus();
  });

  // ============================================================
  // SEÇÃO 37: MENUS DROPDOWN CUSTOMIZADOS
  // ============================================================
  // Lógica de abertura/fechamento dos menus personalizados

  const customMenuContainer = document.getElementById("custom-menu-container");
  function hideAllCustomMenus() {
    document.querySelectorAll(".custom-dropdown-menu.show").forEach((m) => {
      m.classList.remove("show");
      m.closest(".menu-item-wrapper")
        ?.querySelector(".custom-menu-btn")
        ?.classList.remove("active");
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".custom-menu-btn")) {
      hideAllCustomMenus();
    }
  });

  customMenuContainer?.addEventListener("mouseover", (e) => {
    const targetSubmenuParent = e.target.closest(".submenu-parent");
    if (targetSubmenuParent) {
      const targetSubmenu = targetSubmenuParent.nextElementSibling;
      if (targetSubmenu && targetSubmenu.classList.contains("submenu")) {
        targetSubmenuParent.parentElement
          .querySelectorAll(".custom-dropdown-menu.submenu.show")
          .forEach((m) => {
            if (m !== targetSubmenu) m.classList.remove("show");
          });
        targetSubmenu.classList.add("show");
        targetSubmenu.style.top = `${targetSubmenuParent.offsetTop}px`;
      }
    }
  });

  // Fecha o submenu quando o mouse sai do submenu-parent e do submenu
  document.querySelectorAll(".submenu-parent").forEach((parent) => {
    const submenu = parent.nextElementSibling;
    if (submenu && submenu.classList.contains("submenu")) {
      // Cria um wrapper invisível para detectar quando o mouse sai de ambos
      let hideTimeout = null;

      const scheduleHide = () => {
        hideTimeout = setTimeout(() => {
          submenu.classList.remove("show");
        }, 150);
      };

      const cancelHide = () => {
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
      };

      parent.addEventListener("mouseenter", cancelHide);
      parent.addEventListener("mouseleave", scheduleHide);
      submenu.addEventListener("mouseenter", cancelHide);
      submenu.addEventListener("mouseleave", scheduleHide);
    }
  });

  customMenuContainer?.addEventListener("click", (e) => {
    const btn = e.target.closest(".custom-menu-btn");
    const item = e.target.closest(".menu-item");

    if (btn) {
      e.preventDefault();
      e.stopPropagation();

      if (btn.getAttribute("data-menu-id") === "format") {
        saveSelection();
        updateFormatMenuState();
      }

      const menuId = btn.getAttribute("data-menu-id");
      const menu = document.getElementById(`dropdown-${menuId}`);
      const isAlreadyOpen = menu?.classList.contains("show");

      hideAllCustomMenus();

      if (!isAlreadyOpen) {
        menu?.classList.add("show");
        btn.classList.add("active");
      }
    } else if (item && !item.classList.contains("disabled")) {
      if (item.classList.contains("submenu-parent")) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      const action = item.getAttribute("data-action");
      const val = item.getAttribute("data-value");
      performMenuAction(val ? { action, value: val } : action);
      hideAllCustomMenus();
    }
  });

  document
    .getElementById("minimize-btn")
    ?.addEventListener("click", () =>
      ipcRenderer.send("control-window", "minimize")
    );
  document
    .getElementById("maximize-btn")
    ?.addEventListener("click", () =>
      ipcRenderer.send("control-window", "maximize")
    );
  document
    .getElementById("close-btn")
    ?.addEventListener("click", () =>
      ipcRenderer.send("control-window", "close")
    );

  // ============================================================
  // SEÇÃO 38: IPC HANDLERS - COMUNICAÇÃO COM MAIN PROCESS
  // ============================================================
  // Recebe eventos de arquivo aberto, salvo, fechado, etc.

  ipcRenderer.on("menu-action", (e, payload) => performMenuAction(payload));
  ipcRenderer.on("file-opened", (e, doc) => {
    console.log("✅ Arquivo recebido:", doc);

    // Cria o documento (que já limpa a formatação)
    const newDoc = createNewDocument(doc.content, doc.name, doc.path);

    // Muda para a aba "Edit"
    const editTab = document.getElementById("edit-tab");
    if (editTab) {
      const tabInstance = bootstrap.Tab.getOrCreateInstance(editTab);
      tabInstance.show();
    }

    window.getSelection().removeAllRanges();

    // ========== AQUI: APLICA A FORMATAÇÃO PADRÃO ==========
    setTimeout(() => {
      const editor = getActiveTextEditorArea();
      if (editor) {
        // Seleciona tudo
        editor.focus();
        document.execCommand("selectAll", false, null);

        // Aplica a formatação padrão
        applyDefaultFormatting(editor);

        // Remove seleção
        document.getSelection().removeAllRanges();
      }

      updateFormatMenuState();
      updateEditMenuState();
    }, 100);

    updateRecentPanel(doc.path, doc.name);
    console.log("✅ Documento aberto com sucesso!");
  });

  ipcRenderer.on("file-saved", (e, name, path, id) => {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      doc.name = name;
      doc.path = path;
      doc.saved = true;
      updateTabTitle(id, name, true);
    }
    updateRecentPanel(path, name);
  });
  ipcRenderer.on("file-saved-direct", (e, name, path, id) => {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      doc.saved = true;
      updateTabTitle(id, name, true);
    }
  });
  ipcRenderer.on("file-saved-and-closed", (e, name, path, id) => {
    removeDocumentFromDOM(id);
  });
  ipcRenderer.on("close-document-unsaved", (e, id) => {
    removeDocumentFromDOM(id);
  });
  ipcRenderer.on("prompt-save-and-close", (e, id) => {
    const doc = documents.find((d) => d.id === id);
    const editor = document
      .getElementById(`doc-${id}`)
      ?.querySelector(".text-editor-area");
    if (doc && editor) {
      const content = getCleanContent(editor);
      ipcRenderer.send("save-file-dialog-and-close", content, id, doc.name);
    } else removeDocumentFromDOM(id);
  });
  ipcRenderer.on("file-content-reverted", (event, editorId, content) => {
    const targetDoc = documents.find((d) => d.id === editorId);
    const editorArea = document
      .getElementById(`doc-${editorId}`)
      ?.querySelector(".text-editor-area");
    if (targetDoc && editorArea) {
      targetDoc.content = content;
      targetDoc.saved = true;
      editorArea.innerHTML = content;
      updateTabTitle(editorId, targetDoc.name, true);
      syncContentToPrompter();
      updateEditMenuState();
    }
  });

  // ============================================================
  // HANDLER: Restaurar Backup HTML
  // ============================================================
  /**
   * handleRestoreBackup
   * --------------------
   * Processa o conteúdo de um arquivo HTML de backup, extraindo
   * apenas o innerHTML do <body> para evitar poluir o DOM com
   * tags inválidas (<html>, <head>, <style>, etc.)
   * 
   * IMPORTANTE: Remove espaços em branco extras e normaliza o conteúdo
   * para evitar diferenças de espaçamento entre Editor e Broadcast.
   * 
   * @param {string} htmlString - Conteúdo bruto do arquivo HTML
   * @returns {string} - Conteúdo limpo (apenas o innerHTML do body)
   */
  function handleRestoreBackup(htmlString) {
    // Usa DOMParser para parsear o HTML de forma segura
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    if (!doc.body) return '';

    // Remove espaços em branco entre tags (text nodes vazios)
    const cleanWhitespace = (node) => {
      const childNodes = [...node.childNodes];
      childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          // Se for apenas espaços/quebras de linha entre tags, remove
          if (/^\s+$/.test(child.textContent) && child.textContent.includes('\n')) {
            child.remove();
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          cleanWhitespace(child);
        }
      });
    };

    cleanWhitespace(doc.body);

    // Extrai o conteúdo limpo
    let cleanContent = doc.body.innerHTML;

    // Remove quebras de linha extras no início e fim
    cleanContent = cleanContent.trim();

    // Normaliza múltiplas quebras de linha para uma só
    cleanContent = cleanContent.replace(/\n\s*\n/g, '\n');

    return cleanContent;
  }

  /**
   * Listener para receber arquivo de backup do main process
   */
  ipcRenderer.on("backup-file-loaded", (event, data) => {
    console.log("📂 Backup recebido:", data.name);

    // 1. Extrai conteúdo limpo usando DOMParser
    const cleanContent = handleRestoreBackup(data.content);

    // 2. Cria novo documento com o conteúdo do backup
    const newDoc = createNewDocument(cleanContent, `[Backup] ${data.name}`, null);

    // 3. Muda para a aba "Edit"
    const editTab = document.getElementById("edit-tab");
    if (editTab) {
      const tabInstance = bootstrap.Tab.getOrCreateInstance(editTab);
      tabInstance.show();
    }

    // 4. Aplica formatação e dispara evento de input para Auto-Save
    setTimeout(() => {
      const editor = getActiveTextEditorArea();
      if (editor) {
        // Dispara evento de input para notificar o sistema de alterações
        editor.dispatchEvent(new Event('input', { bubbles: true }));

        // Sincroniza com o prompter
        syncContentToPrompter();

        // Atualiza estados dos menus
        updateFormatMenuState();
        updateEditMenuState();
      }
    }, 100);

    // 5. Mostra confirmação ao usuário
    ipcRenderer.send(
      "show-info-dialog",
      "Backup Restaurado",
      `O arquivo de backup "${data.name}" foi importado com sucesso!`
    );

    console.log("✅ Backup restaurado com sucesso!");
  });

  // ============================================================
  // SEÇÃO 39: PAINEL DE ARQUIVOS RECENTES
  // ============================================================
  // Atualiza lista de arquivos abertos recentemente

  /**
   * Formata a data/hora para exibição nos arquivos recentes
   * @param {Date} date - Data a ser formatada
   * @returns {string} - Data formatada (ex: "08/01 às 14:35")
   */
  function formatRecentDate(date) {
    const now = new Date();
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    // Se for hoje, mostra apenas a hora
    if (date.toDateString() === now.toDateString()) {
      return `Today at ${hours}:${minutes}`;
    }

    // Se for ontem
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `Yesterday at ${hours}:${minutes}`;
    }

    // Caso contrário, mostra data completa
    return `${day}/${month} at ${hours}:${minutes}`;
  }

  /**
   * Adiciona arquivo ao painel de recentes
   * @param {string} path - Caminho completo do arquivo
   * @param {string} name - Nome do arquivo
   */
  function updateRecentPanel(path, name) {
    if (!recentFilesList) return;

    // 1. Remove se já existir na lista (para não duplicar)
    document.querySelectorAll(".recent-file-item").forEach((item) => {
      if (item.dataset.filepath === path) item.remove();
    });

    // 2. Cria o elemento CONTAINER principal
    const item = document.createElement("div"); // Mudamos de <a> para <div> para ter mais controle
    item.classList.add("recent-file-item");   // A classe do CSS que criamos
    item.dataset.filepath = path;

    // 3. Monta o HTML interno (Ícone + Texto + Caminho + Data)
    const openedAt = formatRecentDate(new Date());
    item.innerHTML = `
        <div class="recent-icon"><i class="bi bi-file-earmark-text"></i></div>
        <div class="recent-info">
            <div class="recent-name">${name}</div>
            <div class="recent-path">${path}</div>
        </div>
        <div class="recent-date">${openedAt}</div>
    `;

    // 4. Adiciona o evento de clique
    item.addEventListener("click", () => {
      ipcRenderer.send("reopen-recent-file", path);
    });

    // 5. Mantém apenas os 5 últimos
    if (recentFilesList.children.length >= 5) {
      recentFilesList.removeChild(recentFilesList.lastChild);
    }

    // 6. Adiciona no topo da lista
    recentFilesList.prepend(item);
  }

  // ============================================================
  // SEÇÃO 40: DRAG & DROP DO MODAL DE BUSCA
  // ============================================================
  // Permite arrastar o modal de busca/substituição pela tela

  const modalHeader = document.querySelector(".modal-header-draggable");
  const modalDialog = document.querySelector("#findReplaceModal .modal-dialog");

  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragCurrentX = 0;
  let dragCurrentY = 0;

  if (modalHeader && modalDialog) {
    modalHeader.addEventListener("mousedown", (e) => {
      isDragging = true;
      dragStartX = e.clientX - dragCurrentX;
      dragStartY = e.clientY - dragCurrentY;
      modalHeader.classList.add("cursor-move");
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      e.preventDefault();
      dragCurrentX = e.clientX - dragStartX;
      dragCurrentY = e.clientY - dragStartY;
      modalDialog.style.transform = `translate(${dragCurrentX}px, ${dragCurrentY}px)`;
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  }

  // ============================================================
  // SEÇÃO 41: SINCRONIZAÇÃO DE PREFERÊNCIAS NA UI
  // ============================================================
  // Atualiza interface quando configurações mudam

  ipcRenderer.on("settings-updated-globally", (event, settings) => {
    globalPrefs = settings;
    console.log("Configurações recebidas:", settings);

    // 1. Aplica o visual geral (fundo, cor padrão da caixa)
    if (typeof applySettingsToVisuals === 'function') applySettingsToVisuals();

    // 2. SINCRONIA CRÍTICA: Atualiza a Barra de Ferramentas com os valores da preferência
    if (settings.defaultFont || settings.defaultFontSize) {
      updateFontUIState(settings.defaultFont, settings.defaultFontSize);
    }

    // 3. Se o editor estiver vazio (novo documento), força o estilo padrão no cursor
    const editor = document.querySelector('.text-editor-area');
    if (editor && editor.innerText.trim() === "") {
      // Aplica direto no estilo do container para começar certo
      editor.style.fontFamily = settings.defaultFont;
      // Importante: No container usamos 'pt' direto
      editor.style.fontSize = `${settings.defaultFontSize}pt`;
    }
  });

  // ============================================================
  // SEÇÃO 42: BARRA DE PROGRESSO E TIMER DO PROMPTER
  // ============================================================
  // Indicador visual de progresso e cronômetro durante reprodução

  /**
   * Atualiza posição da barra de progresso do scroll
   * @param {number} ratio - Posição relativa (0 a 1)
   */
  function updateProgressBar(ratio) {
    // 1. Verifica preferência
    if (!globalPrefs || !globalPrefs.showProgressIndicator) {
      const existing = document.getElementById('prompter-custom-scrollbar');
      if (existing) existing.style.display = 'none';
      return;
    }

    // 2. Encontra a caixa de texto que rola
    const scrollableBox = document.querySelector('.prompter-in-control');
    if (!scrollableBox) return;

    // 3. O SEGREDO: Usamos o PAI dessa caixa para prender a barra
    // Assim a barra NÃO rola junto com o texto
    const containerParent = scrollableBox.parentElement;

    // Garante que o pai tenha posição relativa para segurar a barra absoluta
    if (getComputedStyle(containerParent).position === 'static') {
      containerParent.style.position = 'relative';
    }

    let barContainer = document.getElementById('prompter-custom-scrollbar');
    let barThumb = document.getElementById('prompter-scrollbar-thumb');

    // 4. CRIA SE NÃO EXISTIR
    if (!barContainer) {
      // TRILHO (Fundo da barra)
      barContainer = document.createElement('div');
      barContainer.id = 'prompter-custom-scrollbar';

      // POSICIONAMENTO: LADO ESQUERDO (Junto com a Seta)
      barContainer.style.position = 'absolute';
      barContainer.style.top = '0';
      barContainer.style.bottom = '0';
      barContainer.style.left = '0';   // <--- ESQUERDA
      barContainer.style.right = 'auto';

      barContainer.style.width = '10px';
      barContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.1)'; // Fundo leve para ver que existe
      barContainer.style.zIndex = '9999'; // Acima de tudo
      barContainer.style.pointerEvents = 'none'; // Não bloqueia cliques

      // O INDICADOR (Quadradinho Branco)
      barThumb = document.createElement('div');
      barThumb.id = 'prompter-scrollbar-thumb';
      barThumb.style.position = 'absolute';
      barThumb.style.width = '100%';
      barThumb.style.height = '30px'; // Um pouco maior para visibilidade
      barThumb.style.backgroundColor = '#FFFFFF';
      barThumb.style.top = '0px';
      barThumb.style.boxShadow = '2px 2px 5px rgba(0,0,0,0.5)';

      barContainer.appendChild(barThumb);
      containerParent.appendChild(barContainer); // Anexa ao PAI (não ao texto)
    }

    barContainer.style.display = 'block';

    // 5. ATUALIZA A POSIÇÃO
    // Usa a altura do pai para calcular
    const trackHeight = containerParent.clientHeight;
    const thumbHeight = 40;
    const availableHeight = trackHeight - thumbHeight;

    // Garante que ratio esteja entre 0 e 1
    const safeRatio = Math.min(1, Math.max(0, ratio));
    const topPos = safeRatio * availableHeight;

    if (barThumb) barThumb.style.top = `${topPos}px`;
  }


  /**
   * Controla o timer de reprodução (cronômetro progressivo ou regressivo)
   * @param {string} action - 'start', 'pause' ou 'stop'
   */
  function handlePlaybackTimer(action) {
    if (!globalPrefs || !globalPrefs.playbackTimer || globalPrefs.playbackTimer === 'off') {
      const existing = document.getElementById('prompter-timer-display');
      if (existing) existing.style.display = 'none';
      return;
    }

    // Pega a mesma área de preview
    const previewArea = document.querySelector('.prompter-preview');
    if (!previewArea) return;

    if (getComputedStyle(previewArea).position === 'static') {
      previewArea.style.position = 'relative';
    }

    let timerEl = document.getElementById('prompter-timer-display');

    if (!timerEl) {
      timerEl = document.createElement('div');
      timerEl.id = 'prompter-timer-display';

      // --- POSICIONAMENTO NO CANTO ---
      timerEl.style.position = 'absolute';
      timerEl.style.top = '20px';
      timerEl.style.right = '30px';
      timerEl.style.zIndex = '2010';
      // -------------------------------

      timerEl.style.color = '#FFFFFF';
      timerEl.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
      timerEl.style.padding = '5px 15px';
      timerEl.style.borderRadius = '6px';
      timerEl.style.fontSize = '1.8rem';
      timerEl.style.fontFamily = 'monospace';
      timerEl.style.fontWeight = 'bold';
      timerEl.style.pointerEvents = 'none';
      timerEl.style.border = '1px solid rgba(255,255,255,0.2)';
      timerEl.innerText = "00:00";

      previewArea.appendChild(timerEl); // Adiciona na área correta
    }

    timerEl.style.display = 'block';

    // ... (Lógica de contagem permanece igual) ...
    if (action === 'start') {
      if (!playbackStartTime) playbackStartTime = Date.now();

      if (globalPrefs.playbackTimer === '5m') playbackDuration = 5 * 60 * 1000;
      else if (globalPrefs.playbackTimer === '10m') playbackDuration = 10 * 60 * 1000;
      else if (globalPrefs.playbackTimer === 'custom') playbackDuration = 3 * 60 * 1000;
      else playbackDuration = 0;

      if (playbackTimerInterval) clearInterval(playbackTimerInterval);

      playbackTimerInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = now - playbackStartTime;
        let displayTime = elapsed;
        let isWarning = false;

        if (playbackDuration > 0) {
          displayTime = Math.max(0, playbackDuration - elapsed);
          if (displayTime < 10000) isWarning = true;
          if (displayTime === 0) ScrollEngine.stop();
        }

        const minutes = Math.floor(displayTime / 60000);
        const seconds = Math.floor((displayTime % 60000) / 1000);

        timerEl.innerText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        timerEl.style.color = isWarning ? '#ff5555' : '#FFFFFF';

      }, 100);

    } else if (action === 'stop') {
      clearInterval(playbackTimerInterval);
      playbackStartTime = null;

      if (globalPrefs.playbackTimer === '5m') timerEl.innerText = "05:00";
      else if (globalPrefs.playbackTimer === '10m') timerEl.innerText = "10:00";
      else timerEl.innerText = "00:00";

      timerEl.style.color = '#FFFFFF';
    } else if (action === 'pause') {
      clearInterval(playbackTimerInterval);
    }
  }

  // ============================================================
  // SEÇÃO 43: TIMELINE E HISTÓRICO DE VERSÕES
  // ============================================================
  // Módulo de comparação de versões (diff lado a lado)

  const timelineBtn = document.getElementById("timeline-btn");
  const timelineModalEl = document.getElementById("timelineModal");
  const timelineModal = timelineModalEl
    ? new bootstrap.Modal(timelineModalEl)
    : null;
  const timelineList = document.getElementById("timeline-list");

  // Elementos do Split View
  const diffLeftPanel = document.getElementById("diff-left-panel");
  const diffRightPanel = document.getElementById("diff-right-panel");
  const diffTitleLeft = document.getElementById("diff-title-left");
  const diffTitleRight = document.getElementById("diff-title-right");
  const diffStatusText = document.getElementById("diff-status-text");
  const btnRestoreVersion = document.getElementById("btn-restore-version");

  // --- HELPER 1: PEGAR NOME VISUAL DA ABA (Infalível) ---
  function getTabNameFromDOM(id) {
    // Tenta pegar o botão da aba pelo ID padrão do Bootstrap
    const tabBtn = document.querySelector(
      `button[data-bs-target="#home-tab-pane"]`
    );

    // Se for o documento atual ativo
    const activeDoc = getActiveDocument();
    if (activeDoc && activeDoc.id == id) {
      if (activeDoc.name) return activeDoc.name;
      if (activeDoc.filename) return activeDoc.filename;
      if (activeDoc.path) return activeDoc.path.replace(/^.*[\\\/]/, "");
    }

    // Procura na lista global de documentos
    const docObj = documents.find((d) => d.id == id);
    if (docObj) return docObj.name || docObj.filename || "Sem Título";

    return "Documento";
  }

  // --- HELPER 2: PEGAR CONTEÚDO REAL DA ABA (O que está digitado) ---
  function getTabContentFromDOM(id) {
    // 1. Tenta achar o container
    // Se seu app usa IDs como 'doc-1', 'document-content-1', ajuste aqui:
    let container = document.getElementById(`doc-${id}`);
    if (!container)
      container = document.getElementById(`document-content-${id}`);

    if (!container) return "";

    // 2. Tenta achar o editor dentro do container
    const editor = container.querySelector(
      '.text-editor-area, .editor-content, textarea, [contenteditable="true"]'
    );

    if (editor) return editor.innerText; // Pega texto visível
    return "";
  }

  // --- ABRIR MODAL ---
  if (timelineBtn) {
    timelineBtn.addEventListener("click", () => {
      const doc = getActiveDocument();
      if (!doc) return alert("No active documents."); // Ajuste conforme sua função getActiveDocument

      renderTimelineList(doc);
      resetDiffView();
      timelineModal.show();
    });
  }

  function resetDiffView() {
    diffLeftPanel.innerHTML =
      '<p class="text-muted text-center mt-5">Select the first item (Original/Old)</p>';
    diffRightPanel.innerHTML =
      '<p class="text-muted text-center mt-5">Select the second item (New/Current)</p>';
    diffTitleLeft.innerText = "-";
    diffTitleRight.innerText = "-";
    diffStatusText.innerText = "Select 2 boxes in the left list.";
    btnRestoreVersion.classList.add("d-none");
  }

  // --- RENDERIZAR LISTA LATERAL ---
  function renderTimelineList(activeDoc) {
    timelineList.innerHTML = "";

    // 1. O Documento Atual (Topo da lista)
    const editorArea = getActiveTextEditorArea(); // Sua função existente
    const currentText = editorArea ? editorArea.innerText : "";
    const currentName = activeDoc.name || activeDoc.filename || "Current File";

    const currentItem = {
      id: "current",
      displayName: currentName,
      subInfo: "Editing now (Active Tab)",
      content: currentText,
      type: "current",
      timestamp: Date.now(), // Mais recente possível
    };

    // 2. Outros Documentos Abertos (Abas)
    const otherTabs = documents
      .filter((d) => d.id !== activeDoc.id)
      .map((d) => ({
        id: `tab-${d.id}`,
        displayName: d.name || d.filename || `Doc ${d.id}`,
        subInfo: "Other Open Tab",
        content: getTabContentFromDOM(d.id) || d.content,
        type: "tab",
        timestamp: Date.now() - 100, // Um pouco mais antigo que o atual
      }));

    // 3. Histórico (Versões Salvas)
    const history = (activeDoc.history || [])
      .slice()
      .reverse()
      .map((h) => ({
        id: `hist-${h.id}`, // Prefixo para ID único
        displayName: h.date, // Data/Hora como título
        subInfo: "Versão Salva",
        content: h.content,
        type: "history",
        timestamp: h.id, // Assumindo que o ID do histórico é Date.now()
      }));

    // Junta tudo
    const allItems = [currentItem, ...otherTabs, ...history];

    allItems.forEach((item) => {
      const row = document.createElement("div");
      row.className =
        "list-group-item list-group-item-action timeline-entry d-flex gap-2 align-items-center";
      row.style.cursor = "pointer";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "form-check-input my-0 flex-shrink-0";
      checkbox.value = item.id; // ID único para controle

      // Badge Colorida
      let badgeHtml = "";
      if (item.type === "current")
        badgeHtml =
          '<span class="badge bg-primary rounded-pill ms-auto">Atual</span>';
      else if (item.type === "tab")
        badgeHtml =
          '<span class="badge bg-info text-dark rounded-pill ms-auto">Aba</span>';
      else
        badgeHtml =
          '<span class="badge bg-secondary rounded-pill ms-auto">Hist</span>';

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

      // Lógica de Clique na Linha Inteira
      // Precisamos selecionar o checkbox recém-criado dentro do HTML injetado
      const injectedCheckbox = row.querySelector("input");

      row.addEventListener("click", (e) => {
        // Se não clicou direto na caixa, inverte ela
        if (e.target !== injectedCheckbox) {
          injectedCheckbox.checked = !injectedCheckbox.checked;
        }
        handleSelection(allItems); // Chama a função que desenha a tela
      });

      timelineList.appendChild(row);
    });
  }

  // --- LÓGICA DE SELEÇÃO E COMPARAÇÃO ---
  function handleSelection(allItems) {
    // Pega todos os checkboxes marcados na tela
    const checkedBoxes = Array.from(
      document.querySelectorAll("#timeline-list input:checked")
    );

    // REGRA DE OURO: Só permite 2. Se marcar o 3º, remove o 1º.
    if (checkedBoxes.length > 2) {
      const first = checkedBoxes.shift(); // Pega o mais antigo da seleção
      first.checked = false; // Desmarca ele visualmente
    }

    // Atualiza classes CSS (azul quando selecionado)
    document
      .querySelectorAll("#timeline-list .list-group-item")
      .forEach((el) => {
        const inp = el.querySelector("input");
        if (inp.checked) el.classList.add("active");
        else el.classList.remove("active");
      });

    // Pega os IDs selecionados
    const finalChecked = document.querySelectorAll(
      "#timeline-list input:checked"
    );
    const selectedIds = Array.from(finalChecked).map((cb) => cb.value);

    // Filtra os dados originais
    const selectedData = allItems.filter((i) => selectedIds.includes(i.id));

    updateSplitView(selectedData);
  }

  // --- DESENHAR O LADO A LADO (SPLIT VIEW) ---
  function updateSplitView(items) {
    // Caso 1: Nada ou 1 item
    if (items.length < 2) {
      if (items.length === 1) {
        // Modo Leitura (Mostra só na esquerda)
        diffTitleLeft.innerText = items[0].displayName;
        diffLeftPanel.innerText = items[0].content;
        diffTitleRight.innerText = "-";
        diffRightPanel.innerHTML =
          '<p class="text-muted text-center mt-5">Selecione mais um para comparar</p>';
      } else {
        resetDiffView();
      }
      return;
    }

    // Caso 2: Dois itens selecionados -> COMPARAÇÃO
    // Precisamos saber qual é o "Antigo" (Esquerda) e qual é o "Novo" (Direita)
    // Vamos ordenar pelo timestamp que criamos no objeto
    items.sort((a, b) => a.timestamp - b.timestamp);

    const oldVer = items[0]; // Menor timestamp (mais antigo)
    const newVer = items[1]; // Maior timestamp (mais novo)

    // Atualiza Títulos
    diffTitleLeft.innerText = oldVer.displayName;
    diffTitleRight.innerText = newVer.displayName;
    diffStatusText.innerText = `Comparando: ${oldVer.displayName} -> ${newVer.displayName}`;

    // Roda a biblioteca Diff
    const diff = Diff.diffWords(oldVer.content, newVer.content);

    // Limpa Painéis
    diffLeftPanel.innerHTML = "";
    diffRightPanel.innerHTML = "";

    // Loop Mágico do Diff
    diff.forEach((part) => {
      // Se for REMOVIDO: Aparece na Esquerda (Vermelho)
      if (part.removed) {
        const span = document.createElement("span");
        span.className = "diff-removed-highlight";
        span.innerText = part.value;
        diffLeftPanel.appendChild(span);
      }
      // Se for ADICIONADO: Aparece na Direita (Verde)
      else if (part.added) {
        const span = document.createElement("span");
        span.className = "diff-added-highlight";
        span.innerText = part.value;
        diffRightPanel.appendChild(span);
      }
      // Se for IGUAL: Aparece nos DOIS (Sem cor)
      else {
        const spanLeft = document.createElement("span");
        spanLeft.innerText = part.value;
        diffLeftPanel.appendChild(spanLeft);

        const spanRight = document.createElement("span");
        spanRight.innerText = part.value;
        diffRightPanel.appendChild(spanRight);
      }
    });

    // Botão de Restaurar (Opcional: Pega o texto da esquerda e joga no editor)
    btnRestoreVersion.classList.remove("d-none");
    btnRestoreVersion.onclick = () => {
      if (
        confirm(
          `Reverter o editor atual para o conteúdo de "${oldVer.displayName}"?`
        )
      ) {
        const editor = getActiveTextEditorArea();
        if (editor) {
          editor.innerText = oldVer.content; // Restaura
          timelineModal.hide(); // Fecha modal
        }
      }
    };
  }

  // ============================================================
  // SEÇÃO 44: CONTROLE REMOTO (MODAL WI-FI / INTERNET)
  // ============================================================
  // Inicializa servidor remoto e exibe informações de conexão

  const btnOpenRemoteModal = document.getElementById("btn-open-remote-modal");
  const btnToggleServerModal = document.getElementById(
    "btn-toggle-server-modal"
  );
  const statusIndicator = document.getElementById("status-indicator");
  const statusAlert = document.getElementById("server-status-alert");
  const connectionPanel = document.getElementById("connection-details-panel");
  const modalUrlDisplay = document.getElementById("modal-url-display");
  const btnModalCopy = document.getElementById("btn-modal-copy");

  // REFERÊNCIA AO ÍCONE DA SIDEBAR
  const sidebarIcon = document.querySelector("#btn-open-remote-modal i");

  // 🔴 ESTADO INICIAL: Define o ícone como VERMELHO (Offline) ao iniciar
  if (sidebarIcon) {
    sidebarIcon.classList.add("broadcast-offline");
    sidebarIcon.classList.remove("broadcast-live");
  }

  // Inicializa o Modal do Bootstrap
  let remoteModalInstance = null;
  const remoteModalElement = document.getElementById("remoteConnectionModal");
  if (remoteModalElement) {
    // @ts-ignore
    remoteModalInstance = new bootstrap.Modal(remoteModalElement);
  }

  // 1. Abrir o Modal
  if (btnOpenRemoteModal && remoteModalInstance) {
    btnOpenRemoteModal.addEventListener("click", () => {
      remoteModalInstance.show();
    });
  }


  // ============================================================
  // SEÇÃO 45: TOGGLE DO SERVIDOR REMOTO
  // ============================================================
  // Lógica para iniciar/parar servidor Wi-Fi ou WebRTC

  if (btnToggleServerModal) {
    btnToggleServerModal.addEventListener('click', async () => {
      const selectedMode = document.querySelector('input[name="connection-mode"]:checked').value;
      btnToggleServerModal.disabled = true;

      if (selectedMode === 'ngrok') {

        // SE JÁ ESTIVER LIGADO -> DESLIGA
        if (signalingSocket && signalingSocket.connected) {
          // ⭐ AVISA QUE VAI DESLIGAR
          const yourName = "Você"; // ou pega do seu username
          addLogEntry({
            msg: `${yourName} saiu da sala.`,
            type: 'logout',
            source: 'Internet',
            user: yourName
          });

          // Envia para o servidor local também
          ipcRenderer.send('user-disconnected-remote', {
            name: yourName,
            source: 'Internet'
          });

          stopWebRTCConnection();
          updateServerUI(false);

          if (sidebarIcon) {
            sidebarIcon.classList.remove('broadcast-live');
            sidebarIcon.classList.add('broadcast-offline');
          }
        }


        // SE ESTIVER DESLIGADO -> LIGA
        else {
          try {
            // Primeiro tentamos a conexão
            await startWebRTCConnection();

            // O ícone deve mudar para verde APENAS se o socket conectar de fato
            // Vamos deixar a função startWebRTCConnection cuidar disso internamente
          } catch (err) {
            // Caso ocorra erro, garante que o ícone fique vermelho
            if (sidebarIcon) {
              sidebarIcon.classList.remove('broadcast-live');
              sidebarIcon.classList.add('broadcast-offline');
            }
          }
        }
        btnToggleServerModal.disabled = false;

      }

      // === MODO LOCAL (WI-FI) ===
      // === MODO LOCAL (WI-FI) ===
      else {
        try {
          const result = await ipcRenderer.invoke('toggle-server', 'local');

          // 🟢 SE O SERVIDOR LIGOU COM SUCESSO
          if (result && result.active) {
            let textoParaMostrar = `${result.url} | ID: ${result.pin}`;
            updateServerUI(true, textoParaMostrar);

            // 🔥 ADICIONE ESTA PARTE PARA ATIVAR O VERDE:
            if (sidebarIcon) {
              sidebarIcon.classList.remove('broadcast-offline');
              sidebarIcon.classList.add('broadcast-live'); // Ativa o piscar verde
            }
          }
          // 🔴 SE O USUÁRIO CLICOU PARA PARAR O SERVIDOR
          else {
            updateServerUI(false);
            if (sidebarIcon) {
              sidebarIcon.classList.remove('broadcast-live');
              sidebarIcon.classList.add('broadcast-offline'); // Volta para vermelho
            }
          }
        } catch (err) {
          // 🔴 SE DER ERRO (SEM REDE), LIMPA A MSG E MANTÉM VERMELHO
          let mensagemExibicao = err.message
            .replace("Error invoking remote method 'toggle-server':", "")
            .replace("Error:", "")
            .trim();

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-danger alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3 shadow-lg';
          alertDiv.style.zIndex = '10001';
          alertDiv.style.backgroundColor = '#f8d7da';
          alertDiv.style.color = '#842029';
          alertDiv.style.border = '1px solid #f5c2c7';

          alertDiv.innerHTML = `
            <div class="d-flex align-items-center">
                <i class="bi bi-wifi-off fs-4 me-3"></i> 
                <div>${mensagemExibicao}</div>
                <button type="button" class="btn-close ms-auto" data-bs-dismiss="alert"></button>
            </div>
        `;
          document.body.appendChild(alertDiv);
          setTimeout(() => alertDiv.remove(), 5000);

          // GARANTE QUE FIQUE VERMELHO
          if (sidebarIcon) {
            sidebarIcon.classList.remove('broadcast-live');
            sidebarIcon.classList.add('broadcast-offline');
          }
          updateServerUI(false);
        }
        btnToggleServerModal.disabled = false;
      }
    });
  }

  // === FUNÇÃO AUXILIAR PARA PARAR WEBRTC E LIMPAR TUDO ===
  function stopWebRTCConnection() {
    if (signalingSocket) {
      // ⭐ ANTES DE DESCONECTAR, AVISA QUE ESTÁ SAINDO
      signalingSocket.emit('user-leaving', myRoomId);

      signalingSocket.disconnect();
      signalingSocket = null;
    }

    // 🔴 ADICIONE ISTO PARA VOLTAR AO VERMELHO:
    const sidebarIconInternet = document.querySelector("#btn-open-remote-modal i");
    if (sidebarIconInternet) {
      sidebarIconInternet.classList.remove('broadcast-live');
      sidebarIconInternet.classList.add('broadcast-offline');
    }

    console.log("🔴 Servidor de Internet Parado e Ícone resetado.");

    // Fecha todas as conexões abertas
    Object.keys(peers).forEach(id => {
      if (peers[id]) peers[id].close();
    });

    peers = {};
    myRoomId = null;

    console.log("Servidor de Internet Parado.");
  }

  // Função que atualiza o visual do Modal
  function updateServerUI(isActive, url = "") {
    if (isActive) {
      // Muda status para ONLINE
      statusAlert.classList.remove("alert-secondary");
      statusAlert.classList.add("alert-success", "text-success");
      statusAlert.querySelector("span").innerHTML =
        "Status: <strong>CONNECTED</strong>";

      // Luzinha dentro do modal
      statusIndicator.classList.replace("text-danger", "text-success");
      statusIndicator.classList.add("blink-animation");

      // Botão vira "Parar"
      btnToggleServerModal.classList.replace("btn-primary", "btn-danger");
      btnToggleServerModal.innerHTML =
        '<i class="bi bi-stop-circle"></i> STOP SERVER';

      // Mostra o Link
      connectionPanel.classList.remove("d-none");
      modalUrlDisplay.value = url;

      document
        .querySelectorAll('input[name="connection-mode"]')
        .forEach((el) => (el.disabled = true));
    } else {
      // Muda status para OFF
      statusAlert.classList.remove("alert-success", "text-success");
      statusAlert.classList.add("alert-secondary");
      statusAlert.querySelector("span").innerHTML =
        "Status: <strong>OFF</strong>";

      statusIndicator.classList.replace("text-success", "text-danger");
      statusIndicator.classList.remove("blink-animation");

      btnToggleServerModal.classList.replace("btn-danger", "btn-primary");
      btnToggleServerModal.innerHTML =
        '<i class="bi bi-power"></i> START SERVER';

      connectionPanel.classList.add("d-none");
      modalUrlDisplay.value = "";

      document
        .querySelectorAll('input[name="connection-mode"]')
        .forEach((el) => (el.disabled = false));
    }
  }

  // 3. Botão de Copiar Link
  if (btnModalCopy) {
    btnModalCopy.addEventListener("click", () => {
      modalUrlDisplay.select();
      document.execCommand("copy");

      const icon = btnModalCopy.querySelector("i");
      const oldClass = icon.className;
      icon.className = "bi bi-check-lg";
      setTimeout(() => (icon.className = oldClass), 2000);
    });
  }

  // ============================================================
  // SEÇÃO 46: RECEBIMENTO DE TEXTO REMOTO
  // ============================================================
  // Atualiza editor quando recebe texto de dispositivo remoto

  ipcRenderer.on("update-text-from-remote", (event, newText) => {
    const editor = getActiveTextEditorArea();
    if (editor) {
      editor.innerText = newText;

      // 🔴 FEEDBACK VISUAL: Borda vermelha piscando
      flashRedBorder(editor);

      if (typeof syncContentToPrompter === "function") syncContentToPrompter();
    }
  });

  // ============================================================
  // SEÇÃO 47: FEEDBACK VISUAL DE EDIÇÃO REMOTA
  // ============================================================
  // Pisca borda vermelha quando texto é alterado remotamente

  /**
   * Pisca borda vermelha para indicar edição remota
   * @param {HTMLElement} element - Elemento a destacar
   */
  function flashRedBorder(element) {
    if (!element) return;

    console.log("🔴 Piscando borda vermelha para:", element);

    // Estilo inicial
    element.style.transition = "box-shadow 0.3s ease-in-out";
    element.style.boxShadow = "inset 0 0 0 3px #ff0000";

    // Mantém por 400ms, depois desaparece
    setTimeout(() => {
      element.style.boxShadow = "none";
    }, 400);

    // Remove a transição depois para não ficar lento
    setTimeout(() => {
      element.style.transition = "none";
    }, 410);
  }

  // ============================================================
  // SEÇÃO 48: FLASH MÚLTIPLO (ALTERNATIVA)
  // ============================================================
  // Versão com múltiplas piscadas para maior visibilidade

  function flashRedBorderMultiple(element, times = 3) {
    if (!element) return;

    console.log("🔴 Piscando borda vermelha (múltiplas vezes) para:", element);

    let count = 0;

    element.style.transition = "box-shadow 0.2s ease-in-out";

    const interval = setInterval(() => {
      if (count % 2 === 0) {
        // Acende (vermelho)
        element.style.boxShadow = "inset 0 0 0 3px #ff0000";
      } else {
        // Apaga
        element.style.boxShadow = "none";
      }

      count++;

      // Para depois de N piscadas (2 piscadas = 4 eventos)
      if (count >= times * 2) {
        clearInterval(interval);
        element.style.boxShadow = "none";
        element.style.transition = "none";
      }
    }, 200);
  }

  // ============================================================
  // SEÇÃO 49: SINCRONIZAÇÃO BIDIRECIONAL (PC ↔ SITE)
  // ============================================================
  // Monitora digitação local e envia para dispositivos remotos

  /**
   * Retorna o conteúdo HTML do editor ativo
   */
  function getEditorContent() {
    const editor = getActiveTextEditorArea();
    // CORREÇÃO: Usar innerHTML para manter cores e formatação ao reconectar
    return editor ? editor.innerHTML : "";
  }
  // MONITORAR DIGITAÇÃO LOCAL (PC -> SITE)
  document.addEventListener("input", (e) => {
    if (
      e.target.getAttribute("contenteditable") === "true" ||
      e.target.tagName === "TEXTAREA"
    ) {
      // CORREÇÃO: Usar innerHTML para pegar as cores e negrito
      const currentText = e.target.innerHTML;

      ipcRenderer.send("send-text-to-remote", currentText);

      // Envia para TODOS os usuários conectados na internet
      broadcastTextUpdate(currentText);

      // 3. Atualiza o Prompter Local
      if (typeof syncContentToPrompter === "function") {
        syncContentToPrompter();
      }
    }
  });

  // 2. SERVIDOR PEDE O TEXTO (Quando o roteirista conecta)
  // Agora envia Full-Sync para sincronização pixel-perfect
  ipcRenderer.on("request-text-for-remote", () => {
    // Envia texto simples para compatibilidade
    const text = getEditorContent();
    ipcRenderer.send("send-text-to-remote", text);

    // NOVO: Envia Full-Sync para sincronização pixel-perfect
    if (typeof broadcastFullSync === 'function') {
      setTimeout(() => broadcastFullSync(), 100);
    }
  });

  // ============================================================
  // 3. SERVIDOR PEDE ESTADO COMPLETO (Cold Start Fix - Wi-Fi Local)
  // ============================================================
  // Quando um roteirista conecta, envia HTML + fontSize + fontFamily
  ipcRenderer.on("request-full-state-for-remote", () => {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    // Coleta o estado atual do editor
    const fullState = {
      htmlContent: editor.innerHTML || "",
      fontSize: parseInt(editor.style.fontSize) || currentFontSizePT || 24,
      fontFamily: editor.style.fontFamily || "Arial",
      textAlign: editor.style.textAlign || "left"
    };

    console.log('📤 Enviando estado completo para remoto:', fullState.fontSize + 'pt');
    ipcRenderer.send("send-full-state-to-remote", fullState);
  });

  // ✅ SOLUÇÃO 1: Quando recebe atualização do roteirista
  ipcRenderer.on("update-from-remote", (event, newText) => {
    const editor = getActiveTextEditorArea();

    // Evita loop infinito: só atualiza se for diferente
    // Compara innerHTML com innerHTML para manter consistência
    if (editor && editor.innerHTML !== newText) {
      editor.innerHTML = newText;

      // 🔴 FEEDBACK VISUAL: Borda vermelha piscando
      flashRedBorder(editor);

      // Sinal Visual de Alerta (Borda Vermelha)
      const container = document.getElementById("document-content-container");
      if (container) {
        container.style.transition = "box-shadow 0.2s";
        container.style.boxShadow = "inset 0 0 0 4px #ff0000";
        setTimeout(() => (container.style.boxShadow = "none"), 400);
      }
      flashRedBorderMultiple(editor, 2);

      // 🔥 O PASSO CRUCIAL: Manda atualizar a janela do Operador IMEDIATAMENTE
      if (typeof syncContentToPrompter === "function") {
        syncContentToPrompter();
      }
    }
  });

  // ✅ SOLUÇÃO 2: Quando recebe atualização de ESTILO do roteirista (fonte, tamanho)
  ipcRenderer.on("style-from-remote", (event, styleData) => {
    if (!styleData) return;

    const editor = getActiveTextEditorArea();
    if (!editor) return;

    if (styleData.type === 'fontSize') {
      const size = parseInt(styleData.value);
      if (size >= 8 && size <= 200) {
        // Atualiza a variável global
        currentFontSizePT = size;

        // Atualiza o tamanho no editor (usar PT, não PX!)
        editor.style.fontSize = size + 'pt';

        // Sincroniza a UI - Input de tamanho na toolbar
        const toolbarSizeInput = document.getElementById('font-size-toolbar-fix');
        if (toolbarSizeInput) {
          toolbarSizeInput.value = size;
        }

        // Sincroniza a UI - Select de tamanho (se existir)
        const toolbarSizeSelect = document.getElementById('font-size-select');
        if (toolbarSizeSelect) {
          const option = toolbarSizeSelect.querySelector(`option[value="${size}"]`);
          if (option) {
            toolbarSizeSelect.value = size;
          }
        }

        // Atualiza também o prompter (aba operator)
        const prompterText = document.getElementById('prompterText-control');
        if (prompterText) {
          prompterText.style.fontSize = size + 'pt';
        }

        // Feedback visual
        flashRedBorder(editor);

        console.log('📥 Estilo recebido do remoto: fontSize =', size + 'pt');
      }
    } else if (styleData.type === 'fontFamily') {
      // Atualiza a fonte no editor
      editor.style.fontFamily = styleData.value;

      // Sincroniza a UI
      const fontSelect = document.getElementById('font-family-select');
      if (fontSelect) {
        fontSelect.value = styleData.value;
      }

      // Feedback visual
      flashRedBorder(editor);

      console.log('📥 Estilo recebido do remoto: fontFamily =', styleData.value);
    } else if (styleData.type === 'alignment') {
      // Atualiza o alinhamento no editor
      editor.style.textAlign = styleData.value;

      // Feedback visual
      flashRedBorder(editor);

      console.log('📥 Estilo recebido do remoto: alignment =', styleData.value);
    }

    // Sincroniza com o prompter
    if (typeof syncContentToPrompter === "function") {
      syncContentToPrompter();
    }
  });


  // ============================================================
  // FUNÇÃO: Sincronizar Estilos com Roteiristas Remotos
  // ============================================================
  /**
   * Sincroniza estilos do editor para roteiristas remotos
   * Coleta cor, font, tamanho, alinhamento e envia via socket
   */
  function broadcastStylesUpdate() {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    const styles = {
      fontColor: globalPrefs.defaultFontColor || '#FFFFFF',
      fontFamily: globalPrefs.defaultFont || 'Arial',
      fontSize: currentFontSizePT || parseInt(editor.style.fontSize) || 24,
      lineSpacing: globalPrefs.lineSpacing || 1.6,
      textAlign: editor.style.textAlign || 'left',
      scale: 100
    };

    // Envia para todos os peers WebRTC
    if (typeof RemoteConnectionModule !== 'undefined' && RemoteConnectionModule.broadcastStylesUpdate) {
      RemoteConnectionModule.broadcastStylesUpdate(styles);
    }

    // Envia para o servidor local (via IPC)
    ipcRenderer.send('broadcast-styles-to-remote', styles);
  }


  // ============================================================
  // FUNÇÃO: Full-Sync - Sincronização Pixel-Perfect Completa
  // ============================================================
  /**
   * Envia estado COMPLETO do editor para roteiristas remotos.
   * Garante sincronização pixel-perfect incluindo:
   * - HTML completo com estilos inline
   * - Estilos computados do editor
   * - Preferências globais
   * - Estado atual da toolbar
   * 
   * @description Payload JSON enviado:
   * {
   *   type: 'full-sync',
   *   timestamp: number,
   *   content: { html: string, plainText: string },
   *   editorStyles: { fontFamily, fontSize, fontColor, lineHeight, textAlign, ... },
   *   globalPrefs: { defaultFont, defaultFontSize, ... },
   *   toolbarState: { selectedFont, selectedSize, isBold, isItalic, ... },
   *   sender: { name: string, role: 'host' }
   * }
   */
  function broadcastFullSync() {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    // Coleta HTML com estilos inline preservados
    const htmlContent = getCleanContent(editor);
    const plainText = editor.innerText || editor.textContent || '';

    // Coleta estilos computados do editor
    const computedStyle = window.getComputedStyle(editor);
    const editorStyles = {
      fontFamily: computedStyle.fontFamily || globalPrefs.defaultFont || 'Arial',
      fontSize: currentFontSizePT || parseInt(computedStyle.fontSize) || 24,
      fontColor: computedStyle.color || globalPrefs.defaultFontColor || '#000000',
      backgroundColor: computedStyle.backgroundColor || '#FFFFFF',
      lineHeight: parseFloat(computedStyle.lineHeight) || globalPrefs.lineSpacing || 1.5,
      textAlign: computedStyle.textAlign || 'left',
      fontWeight: computedStyle.fontWeight || 'normal',
      fontStyle: computedStyle.fontStyle || 'normal',
      textDecoration: computedStyle.textDecoration || 'none'
    };

    // Coleta estado da toolbar
    const fontSelect = document.getElementById('font-family-select');
    const sizeSelect = document.getElementById('font-size-toolbar-fix');
    const sizeCustom = document.getElementById('font-size-custom');

    const toolbarState = {
      selectedFont: fontSelect ? fontSelect.value : 'Arial',
      selectedSize: sizeCustom && sizeCustom.value ? sizeCustom.value : (sizeSelect ? sizeSelect.value : '24'),
      colorMode: 'foreground',
      isBold: document.queryCommandState('bold'),
      isItalic: document.queryCommandState('italic'),
      isUnderline: document.queryCommandState('underline'),
      alignment: getActiveAlignment()
    };

    // Monta payload completo
    const fullSyncPayload = {
      type: 'full-sync',
      timestamp: Date.now(),
      content: {
        html: htmlContent,
        plainText: plainText
      },
      editorStyles: editorStyles,
      globalPrefs: {
        defaultFont: globalPrefs.defaultFont || 'Arial',
        defaultFontSize: globalPrefs.defaultFontSize || 24,
        defaultFontColor: globalPrefs.defaultFontColor || '#FFFFFF',
        backgroundColor: globalPrefs.backgroundColor || '#000000',
        lineSpacing: globalPrefs.lineSpacing || 1.5,
        prompterMargin: globalPrefs.prompterMargin || 40,
        theme: document.body.classList.contains('dark-mode') ? 'dark' : 'light'
      },
      toolbarState: toolbarState,
      sender: {
        name: 'Host',
        role: 'host'
      }
    };

    console.log('📤 Enviando Full-Sync:', fullSyncPayload.timestamp);

    // Envia via IPC para o servidor local
    ipcRenderer.send('send-full-sync-to-remote', fullSyncPayload);

    // Envia para peers WebRTC (se conectado)
    if (typeof RemoteConnectionModule !== 'undefined' && RemoteConnectionModule.broadcastFullSync) {
      RemoteConnectionModule.broadcastFullSync(fullSyncPayload);
    }
  }

  /**
   * Retorna o alinhamento ativo no editor
   * @returns {string} 'left' | 'center' | 'right' | 'justify'
   */
  function getActiveAlignment() {
    if (document.queryCommandState('justifyCenter')) return 'center';
    if (document.queryCommandState('justifyRight')) return 'right';
    if (document.queryCommandState('justifyFull')) return 'justify';
    return 'left';
  }


  // ============================================================
  // SEÇÃO 50: VERIFICAÇÃO DE CONECTIVIDADE
  // ============================================================
  // Testa conexão com internet antes de iniciar WebRTC

  /**
   * Verifica se há conexão com a internet
   * @returns {Promise<boolean>} - true se online, false se offline
   */
  async function checkInternetConnection() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 segundos

      // Tenta um HEAD para ser rápido
      const response = await fetch("https://www.google.com", {
        method: 'HEAD',
        mode: 'no-cors', // Evita erros de política de segurança
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return true;
    } catch (error) {
      console.log("ℹ️ Sistema offline detectado.");
      return false; // Retorna false em vez de dar erro no console
    }
  }


  // ============================================================
  // SEÇÃO 51: CONEXÃO WEBRTC (INTERNET P2P)
  // ============================================================
  // Estabelece conexão peer-to-peer via servidor de sinalização

  let signalingSocket = null;
  let peers = {}; // Lista de conexões WebRTC ativas
  let myRoomId = null;

  /**
   * Inicia conexão WebRTC com servidor de sinalização
   * Cria sala única e aguarda outros participantes
   */
  async function startWebRTCConnection() {
    // 🔥 NOVO: Verifica internet ANTES de tentar conectar
    const hasInternet = await checkInternetConnection();

    if (!hasInternet) {
      // Mostra alerta amigável
      const alertDiv = document.createElement('div');
      alertDiv.className = 'alert alert-danger alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3';
      alertDiv.style.zIndex = '9999';
      alertDiv.innerHTML = `
            <i class="bi bi-wifi-off"></i> 
            <strong>No Connection!</strong> 
            Connect to the internet to use this mode.
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
      document.body.appendChild(alertDiv);

      // Remove o alerta após 5 segundos
      setTimeout(() => alertDiv.remove(), 5000);

      // Para o processo e volta o botão ao normal
      if (btnToggleServerModal) {
        btnToggleServerModal.disabled = false;
      }

      // 🔴 ADICIONE ESTA LINHA PARA ARRUMAR O ÍCONE:
      if (sidebarIcon) {
        sidebarIcon.classList.remove('broadcast-live');
        sidebarIcon.classList.add('broadcast-offline');
      }

      if (btnToggleServerModal) {
        btnToggleServerModal.disabled = false;
      }

      return; // ❌ PARA AQUI - Não tenta conectar

      // 🟢 AO FINAL DO SUCESSO DA CONEXÃO INTERNET:
      if (sidebarIcon) {
        sidebarIcon.classList.remove('broadcast-offline');
        sidebarIcon.classList.add('broadcast-live'); // Fica verde
      }
    }

    // ✅ TEM INTERNET - Continua normalmente
    console.log("✅ Internet OK - Connecting...");

    // 1. Conecta ao servidor de sinalização
    signalingSocket = ioClient(SIGNALING_URL, {
      timeout: 10000, // 10 segundos de timeout
      reconnection: false // Não reconecta automaticamente
    });

    // 🔥 NOVO: Tratamento de erro de conexão
    signalingSocket.on('connect_error', (error) => {
      console.error("❌ Erro ao conectar:", error);

      const alertDiv = document.createElement('div');
      alertDiv.className = 'alert alert-warning alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3';
      alertDiv.style.zIndex = '9999';
      alertDiv.innerHTML = `
            <i class="bi bi-exclamation-triangle"></i> 
            <strong>Connection Failed!</strong> 
           We were unable to connect to the server. Please try again.
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
      document.body.appendChild(alertDiv);

      setTimeout(() => alertDiv.remove(), 5000);

      // Limpa tudo e volta ao estado inicial
      stopWebRTCConnection();
      updateServerUI(false);

      if (btnToggleServerModal) {
        btnToggleServerModal.disabled = false;
      }
    });

    // 2. Gera ID
    myRoomId = Math.floor(100000 + Math.random() * 900000).toString();

    // 3. Cria sala
    signalingSocket.emit('create-room', myRoomId);

    // 4. Atualiza UI
    updateServerUI(true, `roteiro.promptiq.com.br | ID: ${myRoomId}`);

    // 🟢 ADICIONE ISTO AQUI PARA O ÍCONE DA SIDEBAR FICAR VERDE:
    const sidebarIconInternet = document.querySelector("#btn-open-remote-modal i");
    if (sidebarIconInternet) {
      sidebarIconInternet.classList.remove('broadcast-offline');
      sidebarIconInternet.classList.add('broadcast-live'); // Ativa o piscar verde
      console.log("🟢 Ícone Internet agora está VERDE");
    }
    // 5. Ouve novos usuários entrando
    signalingSocket.on('user-connected', (userData) => {
      const targetId = userData.id || userData;
      const userName = userData.name || "Usuário Internet";

      console.log("New user connected:", userData);

      if (!peers[targetId]) createPeerConnection(targetId, true);
      peers[targetId].userName = userName;
    });

    // 6. Ouve sinais técnicos
    signalingSocket.on('signal', async (data) => {
      const senderId = data.sender;

      // Se não temos conexão com esse cara ainda, cria uma
      if (!peers[senderId]) {
        createPeerConnection(senderId, false);
      }

      const peer = peers[senderId];
      const signal = data.signal;

      try {
        if (signal.type === 'offer') {
          await peer.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          signalingSocket.emit('signal', { target: senderId, signal: peer.localDescription });
        } else if (signal.type === 'answer') {
          await peer.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
          await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (e) {
        console.error("Erro no sinal WebRTC:", e);
      }
    });

    // Se alguém desconectar
    signalingSocket.on('user-disconnected', (userId) => {
      if (peers[userId]) {
        const remoteName = peers[userId].userName || "Visitante (Web)";

        // 1. Adiciona no log LOCAL
        addLogEntry({
          msg: `${remoteName} saiu da sala.`,
          type: 'logout',
          source: 'Internet',
          user: remoteName
        });

        // 2. ⭐ ENVIA PARA O MAIN PROCESS AVISAR O SERVIDOR LOCAL
        ipcRenderer.send('user-disconnected-remote', {
          name: remoteName,
          source: 'Internet'
        });

        // 3. Fecha a conexão
        peers[userId].close();
        delete peers[userId];

        console.log("UsuÃ¡rio desconectado:", userId);
      }
    });
  }

  function createPeerConnection(targetId, isInitiator) {
    const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const peer = new RTCPeerConnection(config);

    // Guarda na lista de peers
    peers[targetId] = peer;

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        signalingSocket.emit('signal', { target: targetId, signal: { candidate: event.candidate } });
      }
    };

    if (isInitiator) {
      // Host cria o canal
      const channel = peer.createDataChannel("teleprompter");
      setupDataChannelHooks(channel, targetId);

      peer.createOffer().then(offer => {
        peer.setLocalDescription(offer);
        signalingSocket.emit('signal', { target: targetId, signal: offer });
      });
    } else {
      // Cliente recebe o canal
      peer.ondatachannel = (event) => {
        setupDataChannelHooks(event.channel, targetId);
      };
    }

    return peer;
  }

  function setupDataChannelHooks(channel, userId) {
    if (peers[userId]) {
      peers[userId].dataChannel = channel;
    }

    channel.onopen = () => {
      console.log(`Canal aberto com ${userId}`);

      const editor = document.querySelector('.text-editor-area');
      if (editor) {
        channel.send(JSON.stringify({ type: 'update', content: editor.innerHTML }));
      }

      const savedName = (peers[userId] && peers[userId].userName) ? peers[userId].userName : "Visitor (Internet)";

      addLogEntry({
        msg: `${savedName} Entered the room.`,
        type: 'login',
        source: 'Internet',
        user: savedName
      });
    };

    // ⭐ NOVO: Monitorar quando o canal FECHA (usuário saiu)
    channel.onclose = () => {
      console.log(`Canal fechado com ${userId}`);

      const savedName = (peers[userId] && peers[userId].userName) ? peers[userId].userName : "Visitor (Internet)";

      // ADICIONA NO LOG QUE ELE SAIU
      addLogEntry({
        msg: `${savedName} Left the room.`,
        type: 'logout',
        source: 'Internet',
        user: savedName
      });

      // Envia para o servidor local (Wi-Fi) também saber
      ipcRenderer.send('user-disconnected-remote', {
        name: savedName,
        source: 'Internet'
      });

      // Limpa da memória
      if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
      }
    };

    channel.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'update') {
        const editor = document.querySelector('.text-editor-area');

        if (editor && editor.innerHTML !== data.content) {
          editor.innerHTML = data.content;

          flashRedBorder(editor);

          const container = document.getElementById(`doc-${activeDocumentId}`);
          if (container) {
            flashRedBorder(container);
          }

          if (typeof syncContentToPrompter === 'function') syncContentToPrompter();

          broadcastTextUpdate(data.content, userId);

          const remoteName = (peers[userId] && peers[userId].userName) ? peers[userId].userName : "Roteirista (Web)";

          addLogEntry({
            msg: `${remoteName} is typing...`,
            type: 'edit',
            source: 'Internet',
            user: remoteName
          });

          flashRedBorderMultiple(editor, 2);
        }
      }
    };
  }

  /**
   * Envia texto para todos os peers conectados
   * @param {string} content - Conteúdo HTML a enviar
   * @param {string} ignoreId - ID do peer a ignorar (quem enviou)
   */
  function broadcastTextUpdate(content, ignoreId = null) {
    Object.keys(peers).forEach(id => {
      if (id !== ignoreId) { // Não manda de volta para quem digitou
        const peer = peers[id];
        if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
          peer.dataChannel.send(JSON.stringify({ type: 'update', content: content }));
        }
      }
    });
  }

  // ============================================================
  // SEÇÃO 52: VOICE TRACKING (RASTREAMENTO POR VOZ)
  // ============================================================
  // Sincroniza scroll do prompter com a fala do apresentador

  const btnVoiceTrack = document.getElementById("btn-voice-tracking");
  const labelVoiceTrack = document.getElementById("voice-status-label");
  let voiceModeActive = false;

  // 1. OUVIR O GERENCIADOR DE VOZ
  window.addEventListener("voice-tracking-event", (e) => {
    const { type, data } = e.detail;

    if (type === "ready") {
      if (btnVoiceTrack) {
        btnVoiceTrack.disabled = false;
        if (labelVoiceTrack) labelVoiceTrack.innerText = "OFF";
        console.log("🎤 VOICE TRACKING: IA Pronta!");
      }
    } else if (type === "text") {
      // Texto chegou! Vamos ver o que é.
      if (voiceModeActive) {
        console.log("🎤 OUVIDO:", data); // <--- OLHE ISSO NO CONSOLE
        rolarParaTextoFalado(data);
      }
    }
  });

  // 2. CLIQUE NO BOTÃO
  if (btnVoiceTrack) {
    btnVoiceTrack.addEventListener("click", async () => {
      if (!window.VoiceManager)
        return alert("Erro: Voice Manager não carregou.");

      voiceModeActive = !voiceModeActive;
      const sucesso = await window.VoiceManager.toggle(voiceModeActive);

      if (voiceModeActive && sucesso) {
        btnVoiceTrack.classList.add("btn-danger", "text-white");
        btnVoiceTrack.classList.remove("btn-light");
        if (labelVoiceTrack) labelVoiceTrack.innerText = "ON";

        // Para rolagem automática para a voz assumir
        if (typeof ScrollEngine !== "undefined") ScrollEngine.stop();
        if (typeof ipcRenderer !== "undefined")
          ipcRenderer.send("control-prompter", "stop");

        console.log("🎤 Microfone ATIVADO");
      } else {
        btnVoiceTrack.classList.remove("btn-danger", "text-white");
        btnVoiceTrack.classList.add("btn-light");
        if (labelVoiceTrack) labelVoiceTrack.innerText = "OFF";
        voiceModeActive = false;
        console.log("🎤 Microfone DESATIVADO");
      }
    });
  }

  // --- VARIÁVEIS GLOBAIS DE OTIMIZAÇÃO ---
  let cacheDoRoteiro = []; // Guarda o texto limpo na memória
  let ponteiroLeitura = 0; // Onde paramos de ler (índice do array)
  let ultimaContagemNos = 0; // Para saber se o texto mudou

  // --- FUNÇÃO 1: MAPEIA O TEXTO (Roda apenas quando necessário) ---
  function atualizarCacheDoRoteiro(container) {
    console.log("⚡ Indexando roteiro para performance...");
    cacheDoRoteiro = []; // Limpa cache antigo

    const treeWalker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT
    );
    let currentNode;

    while ((currentNode = treeWalker.nextNode())) {
      // Pré-calcula a limpeza do texto AGORA para não fazer isso durante a fala
      let textoCru = currentNode.nodeValue;

      // Limpeza pesada (feita uma única vez aqui)
      let textoLimpo = textoCru
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~]/g, "")
        .trim();

      if (textoLimpo.length > 0) {
        cacheDoRoteiro.push({
          node: currentNode.parentElement, // Guarda a referência do elemento HTML
          texto: textoLimpo,
        });
      }
    }

    ultimaContagemNos = cacheDoRoteiro.length;
    console.log(
      `✅ Roteiro indexado: ${ultimaContagemNos} segmentos de texto prontos.`
    );
  }

  function rolarParaTextoFalado(textoFalado) {
    if (!textoFalado || roteiroIndexado.length === 0 || !voiceModeActive)
      return;

    // 1. Limpeza rápida da fala recebida
    let falaLimpa = textoFalado
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~]/g, "")
      .trim();

    if (falaLimpa.length < 3) return;

    // 2. BUSCA INTELIGENTE
    // Em vez de buscar o texto inteiro, buscamos as últimas palavras (mais chance de acerto)
    const palavras = falaLimpa.split(/\s+/);
    const termoBusca =
      palavras.length > 2 ? palavras.slice(-2).join(" ") : falaLimpa;

    // 3. ENCONTRAR NO CACHE
    // Procuramos a partir da posição atual para evitar que o prompter "pule" para trás
    // caso você diga uma palavra comum que apareceu no início do texto.
    for (let i = posicaoAtualNoRoteiro; i < roteiroIndexado.length; i++) {
      if (roteiroIndexado[i].busca.includes(termoBusca)) {
        const alvo = roteiroIndexado[i].elemento;

        // Destaque visual opcional
        document
          .querySelectorAll(".lendo-agora")
          .forEach((el) => el.classList.remove("lendo-agora"));
        alvo.classList.add("lendo-agora");

        // --- A MÁGICA DA INTEGRAÇÃO COM O SCROLL MANUAL ---
        // Em vez de usar scrollIntoView (que é difícil de controlar),
        // calculamos a posição Y do elemento dentro do container.
        const containerRect = prompterContainer.getBoundingClientRect();
        const elementoRect = alvo.getBoundingClientRect();

        // Calcula quanto precisamos rolar para o texto ficar na altura do Marcador (Cue Marker)
        const deslocamentoDesejado =
          elementoRect.top -
          containerRect.top +
          prompterContainer.scrollTop -
          containerRect.height * 0.3;

        // Atualizamos o ScrollEngine para que ele saiba que mudamos de lugar
        ScrollEngine.decimalScroll = deslocamentoDesejado;

        // Aplicamos o movimento usando a GPU (suave)
        const textEl = ScrollEngine.getTextElement();
        if (textEl) {
          textEl.style.transform = `translate3d(0, -${deslocamentoDesejado}px, 0)`;
        }

        posicaoAtualNoRoteiro = i;
        break;
      }
    }
  }

  function prepararRoteiroParaLeitura() {

    const container = document.getElementById("prompterText-control");
    if (!container) return;

    roteiroIndexado = [];
    // Usamos TreeWalker para pegar apenas os nós de texto, ignorando tags HTML
    const treeWalker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT
    );
    let currentNode;

    while ((currentNode = treeWalker.nextNode())) {
      const textoOriginal = currentNode.nodeValue.trim();
      if (textoOriginal.length > 1) {
        // Guardamos o texto já "limpo" (sem acentos e minúsculo) para busca ultra rápida
        const textoBusca = textoOriginal
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[.,\/#!$%\^&\*;:{}=\-_`~]/g, "");

        roteiroIndexado.push({
          elemento: currentNode.parentElement, // O <span> ou <p> que contém esse texto
          busca: textoBusca,
        });
      }
    }
    posicaoAtualNoRoteiro = 0;
    console.log(
      `[Voz] Cache pronto: ${roteiroIndexado.length} frases mapeadas.`
    );
  }

  const btnVoice = document.getElementById("btn-voice-tracking");
  const labelVoice = document.getElementById("voice-status-label");

  btnVoice.addEventListener("click", function () {
    // Troca a classe: se tem tira, se não tem coloca
    this.classList.toggle("gravando");

    // Opcional: Mudar o texto
    if (this.classList.contains("gravando")) {
      labelVoice.innerText = "Gravando...";
    } else {
      labelVoice.innerText = "Parado"; // ou o texto original
    }
  });


  // ============================================================
  // SEÇÃO 53: SISTEMA DE LOGS DE ATIVIDADE
  // ============================================================
  // Painel que mostra entradas/saídas e edições de usuários remotos

  let isLogOpen = false;
  let logCounter = 0;
  let lastEditUser = "";
  let lastEditTime = 0;

  // Elementos do HTML
  const logContainer = document.getElementById('vscode-log-container');
  const logBody = document.getElementById('log-body');
  const logChevron = document.getElementById('log-chevron');
  const logBadge = document.getElementById('log-badge');

  // 1. Função de Abrir/Fechar (Toggle)
  function toggleLogPanel() {
    isLogOpen = !isLogOpen;
    if (isLogOpen) {
      logBody.classList.add('open');
      logChevron.classList.add('open');
      logBadge.style.display = 'none'; // Some o contador ao abrir
    } else {
      logBody.classList.remove('open');
      logChevron.classList.remove('open');
    }
  }
  // Torna a função global para o onclick do HTML funcionar
  window.toggleLogPanel = toggleLogPanel;


  // 2. Função que Adiciona o Log (Com a correção do 'undefined')
  function addLogEntry(data) {
    console.log("📝 [LOG] Recebendo entrada de log:", data);

    // 🔴 NOVO: Se a mensagem for sobre "Você" saindo da sala, ignora e não cria o log
    if (data.user === "Você" && data.type === 'logout') {
      return;
    }
    // Debounce (evitar repetição rápida)
    if (data.type === 'edit') {
      const now = Date.now();
      if (data.user === lastEditUser && (now - lastEditTime) < 2000) return;
      lastEditUser = data.user;
      lastEditTime = now;
    }

    // Atualiza contador se estiver fechado
    if (!isLogOpen) {
      logCounter++;
      logBadge.style.display = 'inline-block';
      logBadge.innerText = logCounter > 9 ? '9+' : logCounter;
    } else {
      logCounter = 0;
    }

    // Configuração dos Ícones
    let iconColor = "#cccccc";
    let svgPath = "";

    if (data.type === 'login') {
      iconColor = "#73c991"; // Verde
      svgPath = `<path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>`;
    } else if (data.type === 'logout') {
      iconColor = "#f14c4c"; // Vermelho
      svgPath = `<path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>`;
    } else {
      iconColor = "#3794ff"; // Azul
      svgPath = `<path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.378-.378.106.378-.378z"/>`;
    }

    // Tratamento de Texto
    // Se user for undefined ou null, usa "Anônimo"
    const userName = data.user || "Anônimo";

    // Remove o nome da mensagem para não ficar duplicado
    let actionText = data.msg.replace(userName, '').trim();
    if (actionText.startsWith('está')) actionText = 'digitando...'; // Simplifica

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Cria o HTML da linha
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `
        <svg class="log-icon" width="12" height="12" viewBox="0 0 16 16" fill="${iconColor}">${svgPath}</svg>
    <div style="display:flex; flex-direction:column; line-height: 1.2;">
        <div>
            <span class="log-user-name" style="font-weight: 600;">${userName}</span>
            <span class="log-source-tag" style="font-size: 9px; margin-left: 4px; opacity: 0.6;">(${data.source})</span>
        </div>
        <span class="log-action-text" style="color: ${iconColor}; opacity: 0.9; font-style: italic">${actionText}</span>
    </div>
    <span class="log-time-tag" style="font-size: 9px; margin-left: auto; opacity: 0.5;">${time}</span>
`;

    logBody.appendChild(row);
    logBody.scrollTop = logBody.scrollHeight;
  }

  // 3. Recebe logs do Main (Wi-Fi)
  ipcRenderer.on('add-log', (event, data) => {
    addLogEntry(data);
  });

  // 4. ESCONDER O LOG NA ABA "OPERATOR"
  document.addEventListener('click', (e) => {
    // Verifica se clicou em algo que tem texto (abas)
    const targetText = e.target.innerText || "";

    // Se clicou na aba Operator, adiciona a classe que esconde
    if (targetText.includes('Operator')) {
      logContainer.classList.add('log-hidden');
    }
    // Se clicou em Home ou Edit, remove a classe e mostra de novo
    else if (targetText.includes('Home') || targetText.includes('Edit')) {
      logContainer.classList.remove('log-hidden');
    }
  });







  // ============================================================
  // SEÇÃO 54: SINCRONIZAÇÃO DE PREFERÊNCIAS NA INTERFACE
  // ============================================================
  // Aplica preferências salvas aos controles da toolbar

  function syncInterfaceWithPreferences() {
    if (!globalPrefs) return;

    // 1. Sincroniza Botões de Estilo (B, I, U)
    const attrs = globalPrefs.defaultFontAttributes || [];
    const btnBold = document.getElementById('bold-btn') || document.querySelector('button[data-command="bold"]');
    const btnItalic = document.getElementById('italic-btn') || document.querySelector('button[data-command="italic"]');
    const btnUnderline = document.getElementById('underline-btn') || document.querySelector('button[data-command="underline"]');

    const toggleBtn = (btn, isActive) => {
      if (btn) {
        if (isActive) btn.classList.add('active', 'tool-active'); // Adiciona as duas classes para garantir
        else btn.classList.remove('active', 'tool-active');
      }
    };

    toggleBtn(btnBold, attrs.includes('bold'));
    toggleBtn(btnItalic, attrs.includes('italic'));
    toggleBtn(btnUnderline, attrs.includes('underline'));

    // 2. Sincroniza FONTE (Barra de Ferramentas)
    const fontSelect = document.getElementById('font-family-select');
    if (fontSelect) {
      fontSelect.value = globalPrefs.defaultFont;
      // Se a fonte não existir na lista, força visualmente (opcional)
      if (fontSelect.selectedIndex === -1) {
        const newOpt = new Option(globalPrefs.defaultFont, globalPrefs.defaultFont);
        fontSelect.add(newOpt);
        fontSelect.value = globalPrefs.defaultFont;
      }
    }



    // 4. Sincroniza Menu Superior e Cores
    if (typeof updateFontUIState === 'function') {
      updateFontUIState(globalPrefs.defaultFont, globalPrefs.defaultFontSize);
    }
    const colorInput = document.getElementById('font-color-picker');
    if (colorInput) colorInput.value = globalPrefs.defaultFontColor;
  }


  // ============================================================
  // SEÇÃO 55: LISTENERS DO MENU FORMAT (FONTE)
  // ============================================================
  // Aplica fonte selecionada no menu superior

  document.querySelectorAll('.font-option').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();

      const val = item.getAttribute('data-value');
      console.log("🔤 Fonte selecionada do menu FORMAT:", val);

      restoreSelection();

      // Aplica a fonte
      document.execCommand("fontName", false, val);

      // ✅ SINCRONIZA COM O PROMPTER
      if (typeof syncContentToPrompter === "function") {
        syncContentToPrompter();
      }

      updateFontUIState(val, null);

      const editor = getActiveTextEditorArea();
      if (editor) editor.focus();

      console.log("✅ Fonte aplicada e sincronizada!");
    });
  });


  // ============================================================
  // SEÇÃO 56: LISTENERS DO MENU FORMAT (TAMANHO)
  // ============================================================
  // Aplica tamanho de fonte selecionado no menu superior

  document.querySelectorAll('.size-option').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();

      const val = parseInt(item.getAttribute('data-value'));
      console.log("📐 Tamanho selecionado do menu FORMAT:", val);

      // 1. RESTAURA A SELEÇÃO
      restoreSelection();

      // 2. APLICA NO EDITOR (ABA EDIT)
      applyExactFontSizeToEditor(val);

      // 3. APLICA NO OPERATOR (ABA OPERATOR)
      applyExactFontSizeToOperator(val);

      // 4. ✅ SINCRONIZA COM O PROMPTER (ISSO ERA O QUE FALTAVA!)
      if (typeof syncContentToPrompter === "function") {
        syncContentToPrompter();
      }

      // 5. SINCRONIZA A INTERFACE
      updateFontUIState(null, val);

      // 6. Coloca o foco de volta no editor
      const editor = getActiveTextEditorArea();
      if (editor) editor.focus();

      console.log("✅ Font size aplicado e sincronizado!");
    });
  });

  // ============================================================
  // SEÇÃO 57: APLICAÇÃO DE TAMANHO DE FONTE EXATO
  // ============================================================
  // Funções para aplicar tamanho em PT no editor e prompter

  /**
   * Aplica tamanho de fonte exato (em pt) no texto selecionado
   * @param {number} sizeInPt - Tamanho em pontos
   */
  function applyExactFontSize(sizeInPt) {
    if (!sizeInPt) return;

    // 1. Salva na memória global para a aba Operator não perder o valor
    currentFontSizePT = sizeInPt;

    const editor = getActiveTextEditorArea();
    if (!editor) return;
    editor.focus();

    // 2. Aplica no Editor (Aba Edit) usando CSS real (pt)
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("fontSize", false, "7");

    const fontElements = editor.querySelectorAll('span[style*="xxx-large"], font[size="7"]');
    fontElements.forEach(el => {
      el.removeAttribute("size");
      el.style.fontSize = sizeInPt + "pt";
    });

    // 3. FORÇA NO OPERATOR (Aba Operator)
    // Isso resolve o problema da fonte não crescer o suficiente lá
    const prompterText = document.getElementById('prompterText-control');
    if (prompterText) {
      prompterText.style.fontSize = sizeInPt + "pt";
      prompterText.style.lineHeight = "1.2";
    }

    // 4. Sincroniza o número exibido na caixinha da barra e no menu Format
    updateFontUIState(null, sizeInPt);
  }

  // ============================================================
  // SEÇÃO 58: INPUT DE TAMANHO NA TOOLBAR
  // ============================================================
  // Permite digitação direta do tamanho de fonte

  const toolbarSizeFix = document.getElementById('font-size-toolbar-fix');

  if (toolbarSizeFix) {
    toolbarSizeFix.addEventListener('input', (e) => {
      const valor = parseInt(e.target.value) || 12;

      // Validação: não deixar menor que 8 ou maior que 100
      if (valor < 8 || valor > 100) return;

      // 1. ATUALIZA A MEMÓRIA GLOBAL
      currentFontSizePT = valor;

      // 2. APLICA NO EDITOR (ABA EDIT) - TEXTO VISÍVEL
      applyExactFontSizeToEditor(valor);

      // 3. APLICA NO OPERATOR (ABA OPERATOR) - TEXTO DO PROMPTER
      applyExactFontSizeToOperator(valor);

      // 4. SINCRONIZA A INTERFACE
      updateFontUIState(null, valor);

      // 5. SALVA NAS PREFERÊNCIAS (Optional - se usar localStorage/ipc)
      ipcRenderer.send('save-settings', { defaultFontSize: valor });

      // 6. ENVIA PARA OS REMOTOS (Roteiristas conectados)
      ipcRenderer.send('send-style-to-remote', {
        type: 'fontSize',
        value: valor,
        name: 'Host'
      });
    });

    // Devolve foco ao editor quando apertar Enter
    toolbarSizeFix.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const editor = getActiveTextEditorArea();
        if (editor) editor.focus();
      }
    });
  }


  // ============================================================
  // SEÇÃO 59: FUNÇÕES DE APLICAÇÃO DE FONTE
  // ============================================================
  // Aplica tamanho no editor e prompter separadamente

  /**
   * Aplica tamanho exato no editor (aba Edit)
   */
  function applyExactFontSizeToEditor(sizeInPt) {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    console.log("✏️ Aplicando font size no Editor:", sizeInPt + "pt");

    // 1. Aplica no container do editor como estilo base
    editor.style.fontSize = `${sizeInPt}pt`;

    // 2. Atualiza a variável global
    currentFontSizePT = sizeInPt;

    // 3. Se há seleção ativa, aplica apenas na seleção
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      editor.focus();
      document.execCommand("styleWithCSS", false, true);

      // Aplica via execCommand (limitado a 1-7)
      const fontSizeValue = Math.max(1, Math.min(7, Math.floor(sizeInPt / 4)));
      document.execCommand("fontSize", false, fontSizeValue);

      // Corrige os spans criados para usar o valor real em PT
      const fontSpans = editor.querySelectorAll('span[style*="font-size"], font[size]');
      fontSpans.forEach(el => {
        el.removeAttribute("size");
        el.style.fontSize = `${sizeInPt}pt`;
      });
    } else {
      // 4. Se não há seleção, aplica em TODO o conteúdo
      // Aplica recursivamente em todos os elementos com font-size inline
      const allElements = editor.querySelectorAll('*');
      allElements.forEach(el => {
        if (el.style && el.style.fontSize) {
          el.style.fontSize = `${sizeInPt}pt`;
        }
      });

      // Também remove fonts legadas
      const legacyFonts = editor.querySelectorAll('font[size]');
      legacyFonts.forEach(font => {
        font.removeAttribute("size");
        font.style.fontSize = `${sizeInPt}pt`;
      });
    }

    // 5. Sincroniza com o prompter
    if (typeof syncContentToPrompter === "function") {
      syncContentToPrompter();
    }

    if (activeDocumentId) {
      markDocumentAsUnsaved(activeDocumentId);
    }
  }

  /**
   * Aplica tamanho exato no prompter (aba Operator)
   */
  function applyExactFontSizeToOperator(sizeInPt) {
    const prompterText = document.getElementById('prompterText-control');

    if (prompterText) {
      // APLICAÇÃO DIRETA E FORÇADA
      prompterText.style.fontSize = `${sizeInPt}pt`;
      prompterText.style.lineHeight = "1.4"; // Mantém espaçamento legível
    }

    console.log(`✅ Font Size Operator atualizado para: ${sizeInPt}pt`);
  }


  // ============================================================
  // SEÇÃO 60: ATUALIZAÇÃO DE UI DE FONTE
  // ============================================================
  // Sincroniza checkmarks e inputs de fonte na interface

  /**
   * Atualiza checkmarks e inputs de fonte na UI
   */
  function updateFontUIState(fontName, fontSize) {
    // Atualiza a caixa de entrada da toolbar
    const toolbarSizeFix = document.getElementById('font-size-toolbar-fix');
    if (fontSize && toolbarSizeFix) {
      toolbarSizeFix.value = fontSize;
    }

    // Atualiza memória global
    if (fontSize) {
      currentFontSizePT = fontSize;
    }

    // Limpa checkmarks anteriores
    document.querySelectorAll(
      '.menu-item[data-action="set-font"], ' +
      '.font-option, ' +
      '.menu-item[data-action="set-size"], ' +
      '.size-option'
    ).forEach(el => el.classList.remove('checked', 'active'));

    // Aplica checkmark no font atual (se for mudança de fonte)
    if (fontName) {
      const cleanFont = fontName.replace(/['"]/g, "");
      const fontItem = document.querySelector(`[data-value="${cleanFont}"]`);
      if (fontItem) fontItem.classList.add('checked', 'active');
    }

    // Aplica checkmark no tamanho atual
    if (fontSize) {
      const sizeItem = document.querySelector(`[data-value="${fontSize}"]`);
      if (sizeItem) sizeItem.classList.add('checked', 'active');
    }
  }

  // ============================================================
  // SEÇÃO 61: CONTROLES DE TAMANHO DA TOOLBAR
  // ============================================================
  // Select de tamanhos pré-definidos e input customizado

  const fontSizePreset = document.getElementById('font-size-preset');
  const fontSizeCustom = document.getElementById('font-size-custom');

  // 1. SELECT DE TAMANHOS PRÉ-DEFINIDOS
  if (fontSizePreset) {
    fontSizePreset.addEventListener('change', (e) => {
      const val = parseInt(e.target.value);

      if (val > 0) {


        console.log("📐 Tamanho pré-definido selecionado:", val);

        // Aplica em tudo
        applyExactFontSizeToEditor(val);
        applyExactFontSizeToOperator(val);
        updateFontUIState(null, val);

        // Limpa e sincroniza o input customizado com o mesmo valor
        if (fontSizeCustom) fontSizeCustom.value = val;

        // Foco no editor
        getActiveTextEditorArea()?.focus();
      }
    });
  }

  // 2. INPUT CUSTOMIZADO (Digite qualquer número)
  if (fontSizeCustom) {
    // Aplica apenas quando pressionar Enter ou sair do campo (não em tempo real)
    fontSizeCustom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = parseInt(e.target.value);
        if (val >= 8 && val <= 100) {
          console.log("📐 Tamanho customizado confirmado:", val);
          applyExactFontSizeToEditor(val);
          applyExactFontSizeToOperator(val);
          updateFontUIState(null, val);

          // Limpa o select pré-definido
          if (fontSizePreset) fontSizePreset.value = "";

          getActiveTextEditorArea()?.focus();
        }
      }
    });

    // Valida e aplica o valor quando sai do input
    fontSizeCustom.addEventListener('blur', (e) => {
      const val = parseInt(e.target.value);

      if (val && val >= 8 && val <= 100) {
        console.log("📐 Tamanho customizado aplicado (blur):", val);
        applyExactFontSizeToEditor(val);
        applyExactFontSizeToOperator(val);
        updateFontUIState(null, val);

        // Limpa o select pré-definido
        if (fontSizePreset) fontSizePreset.value = "";
      } else if (val < 8) {
        fontSizeCustom.value = "8";
        applyExactFontSizeToEditor(8);
        applyExactFontSizeToOperator(8);
      } else if (val > 100) {
        fontSizeCustom.value = "100";
        applyExactFontSizeToEditor(100);
        applyExactFontSizeToOperator(100);
      }
    });
  }



  // ============================================================
  // SEÇÃO 62: LIMPEZA DE FORMATAÇÃO ANTIGA
  // ============================================================
  // Remove estilos inline herdados de cópia/colagem

  /**
   * Limpa formatação antiga de documentos colados
   * @param {string} htmlContent - HTML a ser limpo
   * @returns {string} - HTML limpo
   */
  function cleanOldFormatting(htmlContent) {
    console.log("🧹 Limpando formatação antiga...");

    // Cria um container temporário
    const temp = document.createElement("div");
    temp.innerHTML = htmlContent;

    // 1. REMOVE TAGS ANTIGAS (<font>, <b>, <i>, <u>)
    const oldTags = temp.querySelectorAll("font, b, i, u, strong, em");
    oldTags.forEach((tag) => {
      // Extrai o texto e o texto dos filhos
      while (tag.firstChild) {
        tag.parentNode.insertBefore(tag.firstChild, tag);
      }
      tag.parentNode.removeChild(tag);
    });

    // 2. REMOVE ATRIBUTOS ANTIGOS
    const allElements = temp.querySelectorAll("*");
    allElements.forEach((el) => {
      // Remove atributos de formatação antiga
      el.removeAttribute("face");     // <font face="">
      el.removeAttribute("size");     // <font size="">
      el.removeAttribute("color");    // <font color="">
      el.removeAttribute("bgcolor");  // <div bgcolor="">

      // Remove estilos antigos (mantém cores e essencial)
      if (el.style) {
        const currentStyles = el.style.cssText;

        // Se tem estilo, filtra (preserva cores do usuário)
        if (currentStyles) {
          // Remove apenas font-family e font-size antigos
          // PRESERVA: color, background-color (cores aplicadas pelo usuário)
          let newStyle = el.style.cssText;
          newStyle = newStyle.replace(/font-family:\s*[^;]+;?/gi, "");
          newStyle = newStyle.replace(/font-size:\s*[^;]+;?/gi, "");
          // NÃO remove mais: color, background-color, background

          el.style.cssText = newStyle;
        }
      }
    });

    // 3. NORMALIZA ESPAÇAMENTO
    // Remove divs vazias
    temp.querySelectorAll("div:empty, span:empty").forEach((el) => {
      // Se não tem conteúdo, remove
      if (el.textContent.trim() === "") {
        el.parentNode.removeChild(el);
      }
    });

    // 4. GARANTE QUE PARÁGRAFOS SÃO <p>
    // Substitui divs por p se apropriado
    const divs = temp.querySelectorAll("div");
    divs.forEach((div) => {
      // Se não tem classe ou ID, e só tem texto, vira <p>
      if (!div.className && !div.id && div.children.length === 0) {
        const p = document.createElement("p");
        p.innerHTML = div.innerHTML;
        div.parentNode.replaceChild(p, div);
      }
    });

    console.log("✅ Formatação limpa!");
    return temp.innerHTML;
  }

  // ============================================================
  // SEÇÃO 63: FORMATAÇÃO PADRÃO PARA DOCUMENTOS NOVOS
  // ============================================================
  // Aplica fonte e tamanho padrão ao abrir/criar documento

  /**
   * Aplica formatação padrão das preferências ao editor
   * @param {HTMLElement} editor - Elemento do editor
   */
  function applyDefaultFormatting(editor) {
    console.log("🎨 Aplicando formatação padrão ao editor...");

    // Força o navegador a usar estilos CSS
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("defaultParagraphSeparator", false, "p");

    // Define a fonte padrão
    if (globalPrefs && globalPrefs.defaultFont) {
      document.execCommand("fontName", false, globalPrefs.defaultFont);
    }

    // Define o tamanho padrão
    if (typeof currentFontSizePT !== "undefined" && currentFontSizePT > 0) {
      const fontSizeValue = Math.floor(currentFontSizePT / 4);
      document.execCommand("fontSize", false, fontSizeValue);

      // Corrige para PT
      const spans = editor.querySelectorAll("span[style*='font-size']");
      spans.forEach((span) => {
        span.style.fontSize = `${currentFontSizePT}pt`;
      });
    }
  }

  // ===============================================================
  // SEÇÃO 64: BOTÃO RETOMAR RECENTE
  // Atalho para abrir o último documento editado diretamente.
  // ===============================================================
  const btnResume = document.getElementById('btn-resume-recent');

  if (btnResume) {
    btnResume.addEventListener('click', () => {
      // Reutiliza a lógica pronta do menu "File > Open Recent"
      // Isso vai pegar automaticamente o primeiro da lista e abrir.
      performMenuAction('open-recent');
    });
  }




  // ===============================================================
  // SEÇÃO 65: LÓGICA DE MENSAGENS RÁPIDAS (QUICK MESSAGES)
  // Menu modal com categorias de mensagens predefinidas para o
  // apresentador. Inclui atalhos de teclado (Shift+M) e mensagens
  // personalizadas com envio via IPC broadcast.
  // ===============================================================

  const quickMsgModal = document.getElementById('quick-message-modal');
  const quickMsgCatList = document.getElementById('quick-msg-cat-list');
  const quickMsgActionList = document.getElementById('quick-msg-action-list');
  const closeQuickMsgBtn = document.getElementById('close-quick-msg');

  let activeCategory = null;

  /**
   * Abre ou fecha o menu de mensagens rápidas.
   * Renderiza as categorias e seleciona a primeira por padrão.
   */
  function toggleQuickMenu() {
    if (quickMsgModal.classList.contains('d-none')) {
      quickMsgModal.classList.remove('d-none');
      renderCategories();
      // Seleciona a primeira categoria por padrão
      if (quickMessageConfig.categories.length > 0) {
        selectCategory(quickMessageConfig.categories[0].id);
      }
    } else {
      quickMsgModal.classList.add('d-none');
    }
  }

  // 2. Renderiza as Categorias (Coluna Esquerda)
  function renderCategories() {
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

  // 3. Seleciona Categoria e Mostra Ações (Coluna Direita)
  function selectCategory(catId) {
    activeCategory = catId;
    renderCategories(); // Atualiza a cor do botão da esquerda

    quickMsgActionList.innerHTML = ''; // Limpa a coluna da direita

    // === LÓGICA ESPECIAL PARA MENSAGEM PERSONALIZADA (FINAL) ===
    if (catId === 'custom') {
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

      // --- LÓGICA DE ENVIO DO INPUT (ESCRITO) ---
      const sendCustomText = () => {
        const text = document.getElementById('custom-msg-input').value;
        if (text.trim() !== '') {
          triggerOverlayMessage({
            message: text.toUpperCase(),
            bg: '#6f42c1', // Roxo
            color: '#ffffff',
            icon: 'bi-chat-quote-fill'
          });
          document.getElementById('custom-msg-input').value = '';
        }
      };

      document.getElementById('btn-send-custom').onclick = sendCustomText;

      document.getElementById('custom-msg-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          sendCustomText();
        }
        e.stopPropagation();
      });

      // --- LÓGICA DOS BOTÕES DE ATALHO (CLICOU, ENVIOU) ---

      // Botão FALE MAIS ALTO
      document.getElementById('btn-preset-louder').onclick = () => {
        triggerOverlayMessage({
          message: 'FALE MAIS ALTO',
          bg: '#ffc107', // Amarelo
          color: '#000000', // Texto preto para contraste
          icon: 'bi-volume-up-fill'
        });
      };

      // Botão SORRIA
      document.getElementById('btn-preset-smile').onclick = () => {
        triggerOverlayMessage({
          message: 'SORRIA',
          bg: '#0dcaf0', // Ciano
          color: '#000000',
          icon: 'bi-emoji-smile-fill'
        });
      };

      return;
    }

    // === LÓGICA PADRÃO (Para as outras categorias) ===
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

  // Função auxiliar para os botões rápidos dentro do "Escrever"
  function setCustomPreset(text) {
    const input = document.getElementById('custom-msg-input');
    if (input) {
      input.value = text;
      input.focus();
    }
  }

  // ===============================================================
  // SEÇÃO 66: DISPARO DE MENSAGEM OVERLAY
  // Envia mensagem para o main process que distribui via broadcast.
  // ===============================================================

  /**
   * Envia mensagem de overlay para todas as janelas via IPC.
   * @param {Object} item - Objeto com message, bg, color e icon.
   */
  function triggerOverlayMessage(item) {
    // Envia para o Processo Main distribuir para todas as janelas
    ipcRenderer.send('broadcast-overlay-message', item);
  }

  // ===============================================================
  // SEÇÃO 67: RECEPÇÃO DE MENSAGEM OVERLAY
  // Listener IPC que exibe a mensagem visualmente na tela.
  // ===============================================================

  /**
   * Recebe mensagem de overlay e exibe na tela do prompter.
   * Auto-esconde após 4 segundos.
   */
  ipcRenderer.on('show-overlay-message', (event, item) => {
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

      // Esconde automaticamente após 4 segundos
      setTimeout(() => {
        overlay.classList.add('d-none');
      }, 4000);
    }
  });

  // ===============================================================
  // SEÇÃO 68: ATALHOS DE TECLADO PARA MENSAGENS RÁPIDAS
  // Shift+M abre o menu, ESC fecha. Funciona em qualquer aba.
  // ===============================================================

  /**
   * Listener de teclado para atalhos de mensagens rápidas.
   * Shift+M: Abre/fecha o menu
   * ESC: Fecha se estiver aberto
   */
  document.addEventListener('keydown', (e) => {
    // Se apertar Shift + M (Menu)
    if (e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      // Só abre se estiver na aba Operator para não atrapalhar a edição
      const operatorTab = document.getElementById('operator-tab-pane');
      if (operatorTab && operatorTab.classList.contains('active')) {
        toggleQuickMenu();
      } else {
        // Se quiser que abra em qualquer lugar, remova o if acima
        toggleQuickMenu();
      }
    }

    // Fecha com ESC
    if (e.key === 'Escape' && !quickMsgModal.classList.contains('d-none')) {
      toggleQuickMenu();
    }
  });

  if (closeQuickMsgBtn) {
    closeQuickMsgBtn.addEventListener('click', toggleQuickMenu);
  }

  // ===============================================================
  // SEÇÃO 69: LÓGICA DE ABAS INTELIGENTE (AUTO-PAUSE)
  // Pausa automática ao trocar de aba para evitar perda de posição.
  // + Preservação de scroll do Operator
  // + Navegação por duplo clique do Editor para o Operator
  // ===============================================================
  // IMPLEMENTAÇÃO: Movido para módulo externo tab-navigation.js
  // O módulo TabNavigationManager gerencia:
  //   - Persistência de posição do scroll do Operator
  //   - Navegação contextual: duplo clique no Editor -> Operator
  //   - Mapeamento de palavras por índice entre containers
  // ===============================================================

  // Inicializa o módulo de navegação entre abas
  if (typeof TabNavigationManager !== 'undefined') {
    TabNavigationManager.init();
  } else {
    console.warn('⚠️ TabNavigationManager não encontrado. Navegação entre abas limitada.');
  }


  // ===============================================================
  // SEÇÃO 70: LISTENERS DE MUDANÇA DE ESTILOS (SINCRONIZA COM REMOTOS)
  // Monitora mudanças de cor, font, tamanho e envia para roteiristas
  // ===============================================================

  const fontColorPicker = document.getElementById('font-color-picker');
  if (fontColorPicker) {
    fontColorPicker.addEventListener('change', () => {
      if (typeof broadcastStylesUpdate === 'function') {
        broadcastStylesUpdate();
      }
    });
  }

  if (fontFamilySelect) {
    fontFamilySelect.addEventListener('change', () => {
      if (typeof broadcastStylesUpdate === 'function') {
        broadcastStylesUpdate();
      }
    });
  }

  const fontSizeInput = document.getElementById('font-size-toolbar-fix');
  if (fontSizeInput) {
    fontSizeInput.addEventListener('change', () => {
      if (typeof broadcastStylesUpdate === 'function') {
        broadcastStylesUpdate();
      }
    });
  }

  // ===============================================================
  // SEÇÃO 70: CORREÇÃO TELA PRETA (RESINCRONIA AUTOMÁTICA)
  // Reenvia texto, scroll e configurações quando a janela de
  // broadcast solicita sincronização após ser aberta.
  // ===============================================================

  ipcRenderer.on('request-resync-data', () => {
    console.log("📺 Janela de Broadcast pediu sincronização!");

    // 1. Envia o Texto Atual
    if (typeof syncContentToPrompter === 'function') {
      syncContentToPrompter();
    }

    // 2. Envia a Posição do Scroll (como razão para sincronização precisa)
    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.decimalScroll !== undefined) {
      const container = document.querySelector('.prompter-in-control');
      const textEl = document.getElementById('prompterText-control');
      const containerHeight = container ? container.clientHeight : 0;
      const contentHeight = textEl ? textEl.scrollHeight : 0;

      // Desconta margin-bottom para cálculo preciso
      const computedStyle = textEl ? window.getComputedStyle(textEl) : null;
      const marginBottom = computedStyle ? (parseFloat(computedStyle.marginBottom) || 0) : 0;
      const pureContentHeight = contentHeight - marginBottom;
      const maxScroll = Math.max(1, pureContentHeight - containerHeight);
      const scrollRatio = Math.min(1, Math.max(0, ScrollEngine.decimalScroll / maxScroll));

      ipcRenderer.send('sync-scroll-position', {
        ratio: scrollRatio,
        pixels: ScrollEngine.decimalScroll,
        maxScroll: maxScroll
      });
    }

    // 3. Solicita reenvio das configurações do main (não salva, apenas pede)
    ipcRenderer.send('request-initial-settings');

    console.log("✅ Dados reenviados para a TV!");
  });

  // ===============================================================
  // SEÇÃO 71: BOTÃO ABRIR BROADCAST
  // Abre a janela de projeção externa para TV/monitor secundário.
  // ===============================================================

  const btnOpenBroadcast = document.getElementById('btn-open-broadcast');

  if (btnOpenBroadcast) {
    btnOpenBroadcast.addEventListener('click', () => {
      console.log("📡 Abrindo janela de Broadcast...");
      ipcRenderer.send('open-projection-window');

      // Feedback visual
      btnOpenBroadcast.innerHTML = '<i class="bi bi-tv"></i> Broadcast Ativo';
      btnOpenBroadcast.classList.add('btn-success');
      btnOpenBroadcast.classList.remove('btn-primary');
    });
  }

  // ============================================================
  // SEÇÃO FINAL: GERENCIADOR DE ATALHOS DE TECLADO (Global)
  // ============================================================

  document.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey; // Ctrl ou Command (Mac)
    const isShift = e.shiftKey;
    const isAlt = e.altKey;
    const key = e.key.toLowerCase();

    // --- Atalhos Universais ---

    // Alt + F4: Fechar App (Segurança extra)
    if (isAlt && e.key === 'F4') {
      e.preventDefault();
      performMenuAction('exit-app');
      return;
    }

    // F11: Tela Cheia (Fullscreen)
    if (e.key === 'F11') {
      e.preventDefault();
      ipcRenderer.send("control-window", "fullscreen"); // Garanta que esse handler existe no main.js
      return;
    }

    // --- Atalhos com CTRL ---
    if (isCtrl) {
      switch (key) {
        // ARQUIVO
        case 'n':
          e.preventDefault();
          if (isShift) {
            // Ctrl + Shift + N: Nova Janela
            performMenuAction('open-file-in-new-window');
          } else {
            // Ctrl + N: Novo Script
            performMenuAction('new-script');
          }
          break;

        case 'o': // Ctrl + O: Abrir
          e.preventDefault();
          performMenuAction('open-script');
          break;

        case 's':
          e.preventDefault(); // Bloqueia salvar página HTML
          if (isShift) {
            // Ctrl + Shift + S: Salvar Como
            performMenuAction('save-as-script');
          } else {
            // Ctrl + S: Salvar
            performMenuAction('save-script');
          }
          break;

        case 'w': // Ctrl + W: Fechar Documento (NÃO O APP)
          e.preventDefault();
          performMenuAction('close-document');
          break;

        case 'p': // Ctrl + P: Imprimir
          e.preventDefault();
          performMenuAction('print-document');
          break;

        // FERRAMENTAS
        case 'f': // Ctrl + F: Buscar
          e.preventDefault();
          performMenuAction('find-replace');
          break;

        // TEMAS (Se você quiser manter seus atalhos customizados)
        case 'l': // Ctrl + L: Light
          e.preventDefault();
          performMenuAction('theme-light');
          break;

        case 'd': // Ctrl + D: Dark
          e.preventDefault();
          // Cuidado: Ctrl+D nativo pode ser "Adicionar aos Favoritos" ou "Duplicar"
          performMenuAction('theme-dark');
          break;

        case 'h': // Ctrl + H: Comparação de Textos (Timeline)
          e.preventDefault();
          // Simula o clique no botão de histórico que já existe
          const btnTimeline = document.getElementById("timeline-btn");
          if (btnTimeline) btnTimeline.click();
          else console.warn("Botão Timeline não encontrado!");
          break;
      }
    }
  });

  // ============================================================
  // SEÇÃO: SHADOW BACKUP (Redundância de Segurança)
  // ============================================================
  // Sistema automático de backup que salva cópias físicas do roteiro
  // a cada 5 minutos em Documentos/Promptiq_Backups

  /**
   * prepareBackupData
   * ------------------
   * Prepara os dados para o Shadow Backup.
   * Gera duas versões do conteúdo:
   * - plainText: Texto puro (innerText) para recuperação rápida
   * - htmlContent: HTML completo com estilos para visualização fiel
   * 
   * @returns {Object|null} Objeto com { plainText, htmlContent, timestamp } ou null se não houver conteúdo
   */
  function prepareBackupData() {
    const editor = getActiveTextEditorArea();
    if (!editor) return null;

    // 1. Captura o texto puro (sem formatação)
    const plainText = editor.innerText || '';

    // Se não há conteúdo, não faz backup
    if (!plainText.trim()) return null;

    // 2. Captura o HTML interno (com formatação)
    const htmlInner = getCleanContent(editor) || editor.innerHTML;

    // 3. Obtém estilos do editor para replicar no arquivo HTML
    const computedStyle = window.getComputedStyle(editor);
    const backgroundColor = computedStyle.backgroundColor || '#FFFFFF';
    const fontColor = computedStyle.color || '#000000';
    const fontFamily = computedStyle.fontFamily || 'Arial, sans-serif';
    const fontSize = computedStyle.fontSize || '12pt';
    const lineHeight = computedStyle.lineHeight || '1.5';

    // 4. Monta o HTML completo com DOCTYPE e estilos
    const timestamp = new Date().toISOString();
    const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="generator" content="Promptiq Shadow Backup">
    <meta name="backup-timestamp" content="${timestamp}">
    <title>Promptiq Backup - ${new Date().toLocaleDateString('pt-BR')}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            background-color: ${backgroundColor};
            color: ${fontColor};
            font-family: ${fontFamily};
            font-size: ${fontSize};
            line-height: ${lineHeight};
            padding: 40px;
            max-width: 100%;
            word-wrap: break-word;
        }
        p {
            margin-bottom: 1em;
        }
        /* Preserva estilos inline do editor */
        span[style], font[style], b, i, u, strong, em {
            /* Mantém estilos originais */
        }
    </style>
</head>
<body>${htmlInner.trim()}</body>
</html>`;

    return {
      plainText,
      htmlContent,
      timestamp
    };
  }

  /**
   * executeShadowBackup
   * --------------------
   * Executa o backup silenciosamente.
   * Não exibe mensagens ao usuário para não interromper o trabalho.
   */
  function executeShadowBackup() {
    try {
      const backupData = prepareBackupData();

      if (backupData) {
        ipcRenderer.send('save-backup-files', backupData);
        console.log('[Shadow Backup] Backup enviado para o main process.');
      } else {
        console.log('[Shadow Backup] Nenhum conteúdo para backup.');
      }
    } catch (error) {
      // Silenciosamente ignora erros para não travar a aplicação
      console.error('[Shadow Backup] Erro ao preparar backup:', error.message);
    }
  }

  // Intervalo de backup: 5 minutos (300.000 ms)
  const SHADOW_BACKUP_INTERVAL = 5 * 60 * 1000; // 300.000 ms

  // Inicia o timer de backup automático
  let shadowBackupTimer = setInterval(executeShadowBackup, SHADOW_BACKUP_INTERVAL);

  console.log('[Shadow Backup] Sistema iniciado. Backup a cada 5 minutos.');

})
