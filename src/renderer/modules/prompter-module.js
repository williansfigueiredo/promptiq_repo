// js/prompter-renderer.js (FASE 4: Receptor e Controlador de Rolagem Completo)

document.addEventListener("DOMContentLoaded", () => {
  const { ipcRenderer } = require("electron");

  const prompterTextContainer = document.getElementById(
    "prompterTextContainer"
  );
  const prompterText = document.getElementById("prompterText");
  const cueMarker = document.getElementById("cueMarker");

  let scrollState = {
    isRunning: false,
    speedValue: 50, // Padrão
    scrollPosition: 0,
    containerHeight: 0,
    contentHeight: 0,
    lastTimestamp: 0,
  };

  // === FUNÇÕES DE ROLAGEM ===

  function updateContentDimensions() {
    if (!prompterTextContainer || !prompterText) return;

    scrollState.containerHeight = prompterTextContainer.offsetHeight;
    scrollState.contentHeight = prompterText.scrollHeight;

    if (!scrollState.isRunning) {
      scrollState.scrollPosition = 0;
      prompterTextContainer.scrollTop = scrollState.scrollPosition;
    }
  }

  function scrollLoop(timestamp) {
    if (!scrollState.isRunning) {
      scrollState.lastTimestamp = 0;
      return;
    }

    if (!scrollState.lastTimestamp) {
      scrollState.lastTimestamp = timestamp;
    }

    const elapsed = timestamp - scrollState.lastTimestamp;
    scrollState.lastTimestamp = timestamp;

    // Fator de ajuste: Quanto maior o speedValue (1 a 100), mais rápido rola.
    const speedFactor = scrollState.speedValue / 100;

    // Aumenta a distância para rolar com base no tempo e velocidade
    const distanceToScroll = 0.05 * speedFactor * elapsed;

    scrollState.scrollPosition += distanceToScroll;

    prompterTextContainer.scrollTop = scrollState.scrollPosition;

    const maxScroll = scrollState.contentHeight - scrollState.containerHeight;

    // Verifica se o scroll atingiu o final (final do texto passa o centro do marcador)
    if (
      scrollState.scrollPosition >=
      maxScroll + scrollState.containerHeight * 0.5
    ) {
      scrollState.isRunning = false;
      prompterTextContainer.scrollTop =
        maxScroll + scrollState.containerHeight * 0.5;
    }

    if (scrollState.isRunning) {
      window.requestAnimationFrame(scrollLoop);
    }
  }

  // === CONTROLES DO PROMPTER ===

  function startScrolling() {
    if (!scrollState.isRunning) {
      updateContentDimensions();
      scrollState.isRunning = true;
      scrollState.lastTimestamp = 0;
      window.requestAnimationFrame(scrollLoop);
    }
  }

  function pauseScrolling() {
    scrollState.isRunning = false;
  }

  function stopScrolling() {
    pauseScrolling();
    scrollState.scrollPosition = 0;
    if (prompterTextContainer) prompterTextContainer.scrollTop = 0;
  }

  // === APLICAÇÃO DE CONFIGURAÇÕES ===

  function applySettings(settings) {
    if (!prompterText || !cueMarker) return;

    // Aplica configurações visuais do Prompter
    document.body.style.backgroundColor = settings.backgroundColor || "#000000";
    document.body.style.transform =
      settings.mirrorMode === "scaleX(-1)" ? "scaleX(-1)" : "none";

    // Aplica estilo da Fonte (Novos campos)
    prompterText.style.fontFamily = settings.defaultFont || "Arial";
    prompterText.style.color = settings.defaultFontColor || "#FFFFFF";

    // Escala e Tamanho da Fonte
    const scaleFactor = (settings.prompterFontScale || 30) / 100;
    const baseSize = settings.defaultFontSize || 12;
    prompterText.style.fontSize = `${baseSize * scaleFactor * 4}px`;

    // Espaçamento de Linha e Margem
    prompterText.style.lineHeight = settings.lineSpacing || 1.5;
    const marginValue = settings.prompterMargin || 40;
    prompterText.style.paddingLeft = `${marginValue}px`;
    prompterText.style.paddingRight = `${marginValue}px`;

    // Cue (Marcador)
    cueMarker.style.color = settings.cueColor || "#00FF00";
    cueMarker.textContent = settings.cueType === "bar" ? "—" : ">>";

    // Configurações de Rolagem
    scrollState.speedValue = settings.overallSpeed || 50;

    updateContentDimensions();
  }

  // === LISTENERS IPC (COMANDOS) ===

  // 1. Receptor do Texto (Vindo do main.js)
  ipcRenderer.on("set-prompter-text", (event, content) => {
    if (prompterText) {
      // Usa innerHTML para manter a formatação (b, i, u)
      prompterText.innerHTML = content;
      stopScrolling();
    }
  });

  // 2. Receptor de Configurações
  ipcRenderer.on("update-settings", (event, settings) => {
    applySettings(settings);
  });

  // 3. Receptor de Comandos de Controle (Play/Pause/Stop/Speed)
  ipcRenderer.on("control-prompter", (event, command) => {
    if (typeof command === "string") {
      switch (command) {
        case "play":
          startScrolling();
          break;
        case "pause":
          pauseScrolling();
          break;
        case "stop":
          stopScrolling();
          break;
      }
    } else if (typeof command === "object" && command.command === "speed") {
      scrollState.speedValue = command.value;
    }
  });

  // Inicialização: Garante que as dimensões sejam calculadas após o carregamento
  window.addEventListener("resize", updateContentDimensions);
  window.onload = updateContentDimensions;

  // ====== SPELL CHECK VISUAL (DESATIVADO) ======
  // Removido para melhorar performance.
  // O spellchecker nativo do Chromium cuida da verificação ortográfica.
  // O sublinhado vermelho aparece automaticamente em palavras erradas
  // quando editor.spellcheck = true e o idioma está configurado.
});

