// ============================================================
// projection-mirror.js
// ============================================================
// DESCRIÇÃO: Alimenta a janela de projeção (tela estendida) com o PRÓPRIO prompter do operador.
// FUNÇÃO: Em vez de a projeção remontar o texto com layout próprio (e nunca ficar igual), o
//         operador envia:
//   - "layout": HTML + estilos do #prompterText-control, largura/altura do prompter, cor de
//               fundo e posição do marcador de leitura (só quando algo muda);
//   - "scroll": posição (px), velocidade e se está rodando (a projeção interpola entre os quadros,
//               então a rolagem fica fluida mesmo com poucas mensagens).
// A projeção reproduz o prompter na MESMA largura lógica do operador e apenas amplia para o tamanho
// do monitor: quebras de linha idênticas, mesma linha sob o marcador, qualquer resolução.
// Só trabalha enquanto a projeção está aberta.
// ============================================================

(function () {
  const { ipcRenderer } = require('electron');

  const SCROLL_SEND_MS = 33;      // rodando: ~30 mensagens/s (a projeção interpola o resto)
  const LAYOUT_DEBOUNCE_MS = 120;

  let active = false;
  let rafId = 0;
  let layoutTimer = null;
  let contentObserver = null;
  let chromeObserver = null;
  let resizeObserver = null;

  let contentDirty = true;
  let contentChangedSinceSend = true;
  let cachedHtml = '';
  let lastLayoutKey = '';
  let lastControlStyle = '';
  let last = { y: NaN, running: null, speed: null, sentAt: 0 };

  const $ = (id) => document.getElementById(id);
  const getControl = () => $('prompterText-control');
  const getContainer = () => document.querySelector('.prompter-in-control');

  // Estilos inline do prompter SEM os que o motor de rolagem muda a cada quadro.
  function controlStyleText(control) {
    const s = control.style;
    const parts = [];
    for (let i = 0; i < s.length; i++) {
      const prop = s[i];
      if (prop === 'transform' || prop === 'will-change') continue;
      const priority = s.getPropertyPriority(prop) ? ' !important' : '';
      parts.push(`${prop}:${s.getPropertyValue(prop)}${priority}`);
    }
    return parts.join(';');
  }

  // Centro do marcador de leitura como fração da altura do prompter.
  function readCue(container) {
    const marker = $('cueMarker-control');
    if (!marker) return { cueFrac: 0.5, cueVisible: true };
    const markerRect = marker.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const height = container.clientHeight || 1;
    const center = markerRect.top + markerRect.height / 2 - containerRect.top;
    return {
      cueFrac: Math.max(0, Math.min(1, center / height)),
      cueVisible: marker.style.display !== 'none'
    };
  }

  function buildLayout() {
    const control = getControl();
    const container = getContainer();
    // Operator oculto (outra aba): sem layout não há medidas confiáveis; mantém o último quadro.
    if (!control || !container || container.clientHeight === 0 || container.clientWidth === 0) return null;

    if (contentDirty) {
      cachedHtml = control.innerHTML;
      contentDirty = false;
    }

    const style = controlStyleText(control);
    lastControlStyle = style;
    const containerStyle = getComputedStyle(container);
    return {
      html: cachedHtml,
      style,
      // Contexto de layout do contêiner (display/padding mudam como as margens se somam).
      viewport: {
        display: containerStyle.display,
        flexDirection: containerStyle.flexDirection,
        alignItems: container.style.alignItems || containerStyle.alignItems,
        textAlign: container.style.textAlign || '',
        padding: containerStyle.padding
      },
      width: container.clientWidth,
      height: container.clientHeight,
      bg: containerStyle.backgroundColor,
      fontBoost: document.body.classList.contains('font-boost'),
      ...readCue(container)
    };
  }

  function sendLayout(force = false) {
    layoutTimer = null;
    if (!active) return;
    const layout = buildLayout();
    if (!layout) return;

    const key = JSON.stringify([
      layout.style, layout.viewport, layout.width, layout.height, layout.bg,
      layout.fontBoost, layout.cueFrac, layout.cueVisible, layout.html.length
    ]);
    if (!force && key === lastLayoutKey && !contentChangedSinceSend) return;
    lastLayoutKey = key;
    contentChangedSinceSend = false;
    ipcRenderer.send('projection-layout', layout);
  }

  function scheduleLayout() {
    if (layoutTimer || !active) return;
    layoutTimer = setTimeout(() => sendLayout(false), LAYOUT_DEBOUNCE_MS);
  }

  function sampleScroll(force = false) {
    const control = getControl();
    const container = getContainer();
    const engine = window.ScrollEngine;
    if (!control || !container || !engine || container.clientHeight === 0) return;

    const running = !!engine.isRunning;
    const speed = engine.speed || 0;
    const y = running ? (engine.decimalScroll || 0) : (container.scrollTop || 0);
    const now = Date.now();

    const stateChanged = running !== last.running || speed !== last.speed;
    const moved = Math.abs(y - last.y) >= 0.5;
    const due = running && now - last.sentAt >= SCROLL_SEND_MS;
    if (!force && !stateChanged && !(moved && (!running || due))) return;

    last = { y, running, speed, sentAt: now };
    ipcRenderer.send('projection-scroll', {
      y,
      running,
      v: running ? speed * 3 * (engine.speedScale || 1) : 0,
      t: now
    });
  }

  function tick() {
    if (!active) return;
    sampleScroll();
    rafId = requestAnimationFrame(tick);
  }

  function startMirroring() {
    if (active) return;
    active = true;
    contentDirty = true;
    contentChangedSinceSend = true;
    lastLayoutKey = '';
    last = { y: NaN, running: null, speed: null, sentAt: 0 };

    const control = getControl();
    const container = getContainer();

    if (control) {
      contentObserver = new MutationObserver((records) => {
        let relevant = false;
        for (const record of records) {
          // O motor de rolagem reescreve transform/will-change a cada quadro: não é mudança de layout.
          if (record.target === control && record.type === 'attributes') {
            if (controlStyleText(control) !== lastControlStyle) relevant = true;
            continue;
          }
          contentDirty = true;
          contentChangedSinceSend = true;
          relevant = true;
        }
        if (relevant) scheduleLayout();
      });
      contentObserver.observe(control, {
        childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style']
      });
    }

    // Cor de fundo (inverter), marcador (arrastar/ocultar) e reforço de fonte (classe do body).
    chromeObserver = new MutationObserver(scheduleLayout);
    if (container) chromeObserver.observe(container, { attributes: true, attributeFilter: ['style'] });
    const marker = $('cueMarker-control');
    if (marker) chromeObserver.observe(marker, { attributes: true, attributeFilter: ['style'] });
    chromeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    if (container && window.ResizeObserver) {
      resizeObserver = new ResizeObserver(scheduleLayout);
      resizeObserver.observe(container);
    }

    sendLayout(true);
    sampleScroll(true);
    rafId = requestAnimationFrame(tick);
  }

  function stopMirroring() {
    active = false;
    cancelAnimationFrame(rafId);
    clearTimeout(layoutTimer);
    layoutTimer = null;
    [contentObserver, chromeObserver, resizeObserver].forEach((o) => o && o.disconnect());
    contentObserver = chromeObserver = resizeObserver = null;
  }

  function renderButton(open) {
    const button = $('btn-extend-screen');
    if (!button) return;
    button.classList.toggle('btn-warning', !open);
    button.classList.toggle('btn-success', open);
    button.innerHTML = open
      ? '<i class="bi bi-display"></i> Extended Screen: ON'
      : '<i class="bi bi-display"></i> Extend Screen';
    button.title = open ? 'Click to close the extended screen' : 'Open the extended screen (second monitor)';
  }

  function init() {
    const button = $('btn-extend-screen');
    if (button) {
      button.addEventListener('click', () => {
        ipcRenderer.send(active ? 'close-projection-window' : 'open-projection-window');
      });
    }

    ipcRenderer.on('projection-state', (_event, state) => {
      renderButton(!!(state && state.open));
      if (state && state.open) startMirroring();
      else stopMirroring();
    });

    // A projeção acabou de abrir (ou foi reaberta): reenvia o quadro completo.
    ipcRenderer.on('projection-request-frame', () => {
      if (!active) startMirroring();
      contentDirty = true;
      sendLayout(true);
      sampleScroll(true);
    });

    renderButton(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
