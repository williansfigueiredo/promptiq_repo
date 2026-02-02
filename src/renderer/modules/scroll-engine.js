// ============================================================
// scroll-engine.js
// ============================================================
// DESCRIÇÃO: Motor de rolagem suave do teleprompter
// FUNÇÃO: Controla a rolagem automática do texto do prompter
//         com velocidade variável, aceleração suave e
//         sincronização com janelas de projeção externa.
// ============================================================

const { ipcRenderer } = require('electron');

/**
 * ScrollEngine
 * -------------
 * Motor de animação de rolagem para teleprompter profissional.
 * 
 * Características:
 * - Rolagem via requestAnimationFrame (60 FPS suave)
 * - Velocidade variável de -100 a +100
 * - Sincronização com janelas de broadcast
 * - Suporte a loop contínuo
 * - Controle preciso via teclado e mouse
 */
const ScrollEngine = {

  // ============================================================
  // ESTADO INTERNO
  // ============================================================
  isRunning: false,       // Se está rolando no momento
  speed: 0,               // Velocidade atual (-100 a +100)
  lastFrameTime: 0,       // Timestamp do último frame (para deltaTime)
  decimalScroll: 0,       // Posição de scroll com precisão decimal
  animationFrameId: null, // ID do requestAnimationFrame

  // ============================================================
  // REFERÊNCIAS EXTERNAS (injetadas na inicialização)
  // ============================================================
  globalPrefs: null,              // Configurações globais
  updateProgressBar: null,        // Função para atualizar barra de progresso
  handlePlaybackTimer: null,      // Função para controlar timer

  // ============================================================
  // FUNÇÃO: Obter Elemento de Texto do Prompter
  // ============================================================
  /**
   * getTextElement
   * ----------------
   * Retorna o elemento DOM que contém o texto do teleprompter.
   */
  getTextElement: function () {
    return document.getElementById("prompterText-control");
  },

  // ============================================================
  // FUNÇÃO: Iniciar Rolagem
  // ============================================================
  /**
   * start
   * ------
   * Inicia a animação de rolagem automática.
   * Configura o modo GPU para performance máxima.
   */
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

    // ========================================
    // MODO GPU: Transform em vez de scrollTop
    // ========================================
    // Trava o scroll nativo e assume controle via CSS transform
    container.style.overflowY = "hidden";
    container.scrollTop = 0;

    // Ativa aceleração de hardware
    textEl.style.willChange = "transform";
    textEl.style.transform = `translate3d(0, -${this.decimalScroll}px, 0)`;

    // ========================================
    // ATUALIZA UI DOS BOTÕES
    // ========================================
    const playBtn = document.getElementById("play-btn");
    const pauseBtn = document.getElementById("pause-btn");
    if (playBtn) playBtn.classList.add("d-none");
    if (pauseBtn) pauseBtn.classList.remove("d-none");

    // Inicia Timer de playback
    if (this.handlePlaybackTimer) this.handlePlaybackTimer('start');

    // Inicia o loop de animação
    this.loop();
  },

  // ============================================================
  // FUNÇÃO: Pausar Rolagem
  // ============================================================
  /**
   * pause
   * ------
   * Pausa a rolagem mantendo a posição atual.
   * Devolve o controle de scroll para o usuário.
   */
  pause: function () {
    this.isRunning = false;
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);

    const textEl = this.getTextElement();
    const container = document.querySelector(".prompter-in-control");

    if (container && textEl) {
      // ========================================
      // DEVOLVE CONTROLE AO USUÁRIO
      // ========================================
      textEl.style.transform = "none";
      textEl.style.willChange = "auto";
      container.style.overflowY = "auto";
      container.scrollTop = this.decimalScroll;
    }

    // Atualiza UI dos botões
    const playBtn = document.getElementById("play-btn");
    const pauseBtn = document.getElementById("pause-btn");
    if (playBtn) playBtn.classList.remove("d-none");
    if (pauseBtn) pauseBtn.classList.add("d-none");

    if (this.handlePlaybackTimer) this.handlePlaybackTimer('pause');
  },

  // ============================================================
  // FUNÇÃO: Parar Rolagem (Reset)
  // ============================================================
  /**
   * stop
   * -----
   * Para a rolagem e volta ao início do texto.
   */
  stop: function () {
    this.pause();

    const container = document.querySelector(".prompter-in-control");
    if (container) {
      container.scrollTop = 0;
      this.decimalScroll = 0;
    }

    this.setSpeed(0);
    if (this.handlePlaybackTimer) this.handlePlaybackTimer('stop');
    if (this.updateProgressBar) this.updateProgressBar(0);
  },

  // ============================================================
  // FUNÇÃO: Definir Velocidade
  // ============================================================
  /**
   * setSpeed
   * ---------
   * Define a velocidade de rolagem.
   * 
   * @param {number} val - Velocidade de -100 a +100
   *                       Negativo = para cima
   *                       Positivo = para baixo
   */
  setSpeed: function (val) {
    let newSpeed = parseInt(val);

    // Limita aos valores permitidos
    if (newSpeed < -100) newSpeed = -100;
    if (newSpeed > 100) newSpeed = 100;

    this.speed = newSpeed;

    // Atualiza UI
    const speedSlider = document.getElementById("control-speed-slider");
    const speedValueSpan = document.getElementById("current-speed-value");
    if (speedSlider) speedSlider.value = newSpeed;
    if (speedValueSpan) speedValueSpan.textContent = newSpeed;
  },

  // ============================================================
  // FUNÇÃO: Alterar Velocidade Relativamente
  // ============================================================
  /**
   * changeSpeedBy
   * --------------
   * Aumenta ou diminui a velocidade atual.
   * Se parado e velocidade != 0, inicia automaticamente.
   * 
   * @param {number} delta - Quanto adicionar à velocidade
   */
  changeSpeedBy: function (delta) {
    this.setSpeed(this.speed + delta);

    // Auto-start se tiver velocidade
    if (this.speed !== 0 && !this.isRunning) {
      this.start();
    }
  },

  // ============================================================
  // FUNÇÃO: Loop de Animação (60 FPS)
  // ============================================================
  /**
   * loop
   * -----
   * Loop principal de animação usando requestAnimationFrame.
   * Calcula movimento baseado em deltaTime para consistência.
   */
  loop: function () {
    if (!this.isRunning) return;

    const now = performance.now();
    const deltaTime = now - this.lastFrameTime; // Tempo desde último frame (ms)
    this.lastFrameTime = now;

    // ========================================
    // CÁLCULO DE VELOCIDADE (FÓRMULA LINEAR)
    // ========================================
    // Velocidade 50 = ~150 pixels por segundo
    // Fator de multiplicação ajustável
    const speedMultiplier = 3.0;
    const pixelsPerSecond = this.speed * speedMultiplier;

    // Quantos pixels mover neste frame específico
    const pixelsToScroll = (pixelsPerSecond * deltaTime) / 1000;

    const textEl = this.getTextElement();
    const container = document.querySelector(".prompter-in-control");

    if (container && textEl) {
      if (Math.abs(pixelsToScroll) > 0) {
        this.decimalScroll += pixelsToScroll;

        const contentHeight = textEl.offsetHeight;
        const containerHeight = container.clientHeight;

        // Limite máximo de scroll (fundo do texto)
        const maxScroll = Math.max(0, contentHeight - containerHeight + (containerHeight / 2));

        // ========================================
        // ATUALIZA BARRA DE PROGRESSO
        // ========================================
        const scrollRatio = Math.min(1, Math.max(0, this.decimalScroll / (contentHeight - containerHeight)));
        if (this.updateProgressBar) this.updateProgressBar(scrollRatio);

        // ========================================
        // LÓGICA DE LOOP CONTÍNUO
        // ========================================
        if (pixelsToScroll > 0 && this.decimalScroll >= maxScroll) {
          // Chegou no fim
          if (this.globalPrefs && this.globalPrefs.continuousLoop) {
            this.decimalScroll = 0; // Loop: Volta ao topo instantaneamente
          } else {
            this.pause(); // Para
            return;
          }
        } else if (pixelsToScroll < 0 && this.decimalScroll <= 0) {
          this.decimalScroll = 0; // Não sobe além do topo
        }

        // ========================================
        // APLICA MOVIMENTO VIA GPU
        // ========================================
        textEl.style.transform = `translate3d(0, -${this.decimalScroll}px, 0)`;
      }
    }

    // ========================================
    // SINCRONIZAÇÃO COM JANELA DE PROJEÇÃO
    // ========================================
    if (textEl) {
      const container = document.querySelector('.prompter-in-control');
      const containerHeight = container ? container.clientHeight : 0;

      // Obtém altura PURA do conteúdo (sem margens/paddings do CSS)
      // Usamos getBoundingClientRect para pegar o tamanho real renderizado
      const textRect = textEl.getBoundingClientRect();
      const pureContentHeight = textEl.scrollHeight;

      // Pega os estilos computados para extrair margin-bottom
      const computedStyle = window.getComputedStyle(textEl);
      const marginBottom = parseFloat(computedStyle.marginBottom) || 0;

      // Altura do conteúdo real (sem margin-bottom extra)
      const actualContentHeight = pureContentHeight - marginBottom;

      // Scroll máximo baseado no conteúdo puro
      const maxScrollPure = Math.max(1, actualContentHeight - containerHeight);

      // Razão normalizada (0 a 1) - baseada no conteúdo real
      const scrollRatio = Math.min(1, Math.max(0, this.decimalScroll / maxScrollPure));

      // Envia razão para outras janelas
      ipcRenderer.send('sync-scroll-position', {
        ratio: scrollRatio,
        pixels: this.decimalScroll,
        maxScroll: maxScrollPure
      });
    }

    // Agenda próximo frame
    this.animationFrameId = requestAnimationFrame(() => this.loop());
  },

  // ============================================================
  // FUNÇÃO: Inicializar Dependências
  // ============================================================
  /**
   * init
   * -----
   * Injeta dependências externas necessárias.
   */
  init: function (options) {
    this.globalPrefs = options.globalPrefs || {};
    this.updateProgressBar = options.updateProgressBar;
    this.handlePlaybackTimer = options.handlePlaybackTimer;
  }
};

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrollEngine;
}
