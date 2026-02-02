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

  // ====== SPELL CHECK VISUAL ======
  const spell = require("../js/spellchecker");

  // Elemento onde o texto é editado
  const editor = document.getElementById("editor"); // use o ID do seu editor

  // Cria popup de sugestões
  const suggestionBox = document.createElement("div");
  suggestionBox.id = "spell-suggestions";
  suggestionBox.style.position = "absolute";
  suggestionBox.style.background = "#222";
  suggestionBox.style.color = "#fff";
  suggestionBox.style.border = "1px solid #444";
  suggestionBox.style.borderRadius = "6px";
  suggestionBox.style.padding = "6px 8px";
  suggestionBox.style.fontSize = "13px";
  suggestionBox.style.zIndex = 9999;
  suggestionBox.style.display = "none";
  suggestionBox.style.cursor = "pointer";
  suggestionBox.style.boxShadow = "0 2px 5px rgba(0,0,0,0.3)";
  document.body.appendChild(suggestionBox);

  // OTIMIZAÇÃO: Cache para armazenar o último texto verificado
  let lastCheckedText = "";

  function spellCheckEditor() {
    const text = editor.innerText;
    
    // OTIMIZAÇÃO: Early Return. Se o texto é idêntico ao último check, para aqui.
    // Evita recriar o DOM inteiro desnecessariamente (Reflow/Repaint).
    if (text === lastCheckedText) return;
    
    lastCheckedText = text; // Atualiza o cache
    
    // ... (Mantenha o resto da lógica original: const words = text.split...)
    const words = text.split(/\s+/);
    let html = text;
    let hasChanges = false; // Flag para saber se precisamos tocar no DOM

    for (const word of words) {
      // OTIMIZAÇÃO: Ignora palavras curtas para poupar CPU
      const result = spell.runSpellCheck(word);
      if (!result.isCorrect && word.length > 2) { 
        html = html.replace(
          new RegExp(`\\b${word}\\b`, "g"),
          `<span class="spell-error" data-word="${word}">${word}</span>`
        );
        hasChanges = true;
      }
    }

    // OTIMIZAÇÃO: Só altera o innerHTML se realmente houve mudança de erro ortográfico
    if (hasChanges) {
        editor.innerHTML = html;
        attachSpellEvents();
    }
  }
  // Adiciona evento de clique em palavras erradas
  function attachSpellEvents() {
    const errorWords = document.querySelectorAll(".spell-error");
    errorWords.forEach((el) => {
      el.style.textDecoration = "underline red wavy";
      el.style.cursor = "pointer";
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const word = el.dataset.word;
        const suggestions = spell.getSuggestions(word, "pt-BR");

        if (suggestions.length === 0) return;

        // Mostra popup
        suggestionBox.innerHTML = "";
        suggestions.forEach((sug) => {
          const opt = document.createElement("div");
          opt.textContent = sug;
          opt.style.padding = "3px 6px";
          opt.style.borderRadius = "4px";
          opt.addEventListener(
            "mouseenter",
            () => (opt.style.background = "#555")
          );
          opt.addEventListener(
            "mouseleave",
            () => (opt.style.background = "transparent")
          );
          opt.addEventListener("click", () => {
            el.outerHTML = sug; // Substitui diretamente
            suggestionBox.style.display = "none";
          });
          suggestionBox.appendChild(opt);
        });

        const rect = el.getBoundingClientRect();
        
        // --- INÍCIO DA CORREÇÃO ---
        const suggestionBoxHeight = 160; // Altura estimada do menu de sugestões (ajuste se necessário)
        const viewportHeight = window.innerHeight; // Altura da janela visível
        
        suggestionBox.style.left = rect.left + "px";

        // Verifica se o espaço restante abaixo da palavra é menor que a altura do menu
        if (viewportHeight - rect.bottom < suggestionBoxHeight) {
            // Posiciona ACIMA da palavra
            suggestionBox.style.top = "auto";
            // Calcula a distância do topo da palavra até o topo da viewport, e posiciona
            // a caixa a essa distância do BOTTOM da viewport (+ 5px de margem)
            suggestionBox.style.bottom = viewportHeight - rect.top + 5 + "px"; 
        } else {
            // Posiciona ABAIXO da palavra
            suggestionBox.style.top = rect.bottom + 5 + "px";
            suggestionBox.style.bottom = "auto";
        }
        // --- FIM DA CORREÇÃO ---
        
        suggestionBox.style.display = "block";
      });
    });
  }

  // Fecha popup ao clicar fora
  document.addEventListener("click", () => {
    suggestionBox.style.display = "none";
  });

  // Executa checagem a cada 2 segundos
  setInterval(spellCheckEditor, 2000);
});

