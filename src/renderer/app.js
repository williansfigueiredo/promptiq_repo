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

  // Focar o editor por código (toolbar, menus) faz o navegador rolar até o cursor de
  // texto — que costuma estar longe do trecho que o operador está vendo, e o texto
  // "pula". Sem opções explícitas, o foco programático do editor nunca rola.
  const nativeHtmlFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options) {
    if (options === undefined && this.classList && this.classList.contains("text-editor-area")) {
      return nativeHtmlFocus.call(this, { preventScroll: true });
    }
    return nativeHtmlFocus.call(this, options);
  };

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
  // CLIPBOARD HISTORY: Rastreia textos copiados
  // ============================================================
  // Envia para o main process cada texto copiado para mostrar no menu de contexto

  document.addEventListener('copy', () => {
    setTimeout(() => {
      const selection = window.getSelection();
      const copiedText = selection ? selection.toString().trim() : '';
      if (copiedText && copiedText.length >= 2) {
        ipcRenderer.send('clipboard-item-copied', copiedText);
      }
    }, 10);  // Pequeno delay para garantir que o clipboard foi atualizado
  });

  // ============================================================
  // SEÇÃO 2: VARIÁVEIS DE ESTADO DO PROMPTER
  // ============================================================
  // Memória persistente de posição e configurações do prompter

  // Memória persistente do prompter
  let roteiroIndexado = [];
  let posicaoAtualNoRoteiro = 0;
  let voiceModeActive = false;

  let currentFontSizePT = 12;
  let currentPrompterFontScale = 100;
  let currentLineSpacing = 0;
  // Fonte escolhida na sessão pelo operador. Preserva a fonte mesmo quando outras
  // preferências (ex.: Line Spacing) são salvas e reaplicadas. "" = usa o padrão.
  let currentFontFamily = "";

  // Evita sync duplicado durante transformações em massa (ex.: Uppercase em roteiro inteiro)
  let _bulkEditDepth = 0;
  let _remoteEchoSuppressDepth = 0;
  let _remoteUpdateTimer = null;

  function beginBulkEdit() {
    _bulkEditDepth++;
  }

  function endBulkEdit(done) {
    _bulkEditDepth = Math.max(0, _bulkEditDepth - 1);
    if (_bulkEditDepth === 0 && typeof done === "function") done();
  }

  function shouldBroadcastToRemotes() {
    return _remoteEchoSuppressDepth === 0;
  }

  function runWithoutRemoteBroadcast(fn) {
    _remoteEchoSuppressDepth++;
    try {
      return fn();
    } finally {
      _remoteEchoSuppressDepth = Math.max(0, _remoteEchoSuppressDepth - 1);
    }
  }

  function normalizeRemoteEditorHtml(html) {
    if (!html || typeof html !== "string") return "";
    try {
      const temp = document.createElement("div");
      temp.innerHTML = html;
      temp.querySelectorAll("[style]").forEach((el) => {
        let s = el.getAttribute("style") || "";
        s = s.replace(/font-size\s*:[^;]+;?/gi, "");
        s = s.replace(/font-family\s*:[^;]+;?/gi, "");
        s = s.replace(/line-height\s*:[^;]+;?/gi, "");
        s = s.trim().replace(/\s*;\s*;/g, ";");
        if (s.replace(/;/g, "").trim()) el.setAttribute("style", s);
        else el.removeAttribute("style");
      });
      temp.querySelectorAll("font[size]").forEach((el) => el.removeAttribute("size"));
      temp.querySelectorAll("font[face]").forEach((el) => el.removeAttribute("face"));
      temp.querySelectorAll("[data-para-idx]").forEach((el) => el.removeAttribute("data-para-idx"));
      // Wrapper de estilo global que o próprio app envia ao roteirista (getRemoteSyncContent):
      // já vale no container do editor, não pode virar conteúdo.
      temp.querySelectorAll("[data-host-style]").forEach((el) => el.replaceWith(...Array.from(el.childNodes)));
      temp.querySelectorAll(".script-read").forEach((el) => el.classList.remove("script-read"));
      temp.querySelectorAll("[data-read]").forEach((el) => el.removeAttribute("data-read"));
      return temp.innerHTML;
    } catch (_) {
      return html;
    }
  }

  // ------------------------------------------------------------------
  // Estrutura válida: inline (span/b/i/u/font...) contendo BLOCOS (p/div...)
  // ------------------------------------------------------------------
  // Aplicar tamanho/negrito numa seleção com vários parágrafos gera
  // <span style="font-size:30pt;font-weight:bold"><div>…</div><p>…</p></span>.
  // O roteirista (remote.html) "conserta" esse documento de 1 bloco só quebrando em <br>,
  // o que destruía o span (negrito/tamanho) e as margens do operador na 1ª edição remota.
  // Aqui o span vira estilo em cada bloco, mantendo exatamente a mesma aparência.
  const HEAL_BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE"]);
  const HEAL_INLINE_SELECTOR = "span, b, strong, i, em, u, s, strike, font, a, mark";
  const HEAL_QUICK_SELECTOR =
    ":is(span,b,strong,i,em,u,s,strike,font,a,mark) > :is(p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,table)";

  function inlineHasBlockChild(el) {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && HEAL_BLOCK_TAGS.has(c.tagName)) return true;
    }
    return false;
  }

  function inlineStyleProps(el) {
    const props = {};
    for (let i = 0; i < el.style.length; i++) {
      const name = el.style[i];
      props[name] = el.style.getPropertyValue(name);
    }
    switch (el.tagName) {
      case "B":
      case "STRONG":
        if (!props["font-weight"]) props["font-weight"] = "bold";
        break;
      case "I":
      case "EM":
        if (!props["font-style"]) props["font-style"] = "italic";
        break;
      case "U":
        if (!props["text-decoration-line"]) props["text-decoration-line"] = "underline";
        break;
      case "S":
      case "STRIKE":
        if (!props["text-decoration-line"]) props["text-decoration-line"] = "line-through";
        break;
      case "FONT":
        if (el.getAttribute("color") && !props["color"]) props["color"] = el.getAttribute("color");
        if (el.getAttribute("face") && !props["font-family"]) props["font-family"] = el.getAttribute("face");
        break;
      default:
    }
    return props;
  }

  /** Troca `el` (inline com blocos dentro) pelos seus filhos, passando o estilo para cada bloco. */
  function unwrapInlineWithBlocks(el) {
    const props = inlineStyleProps(el);
    const frag = document.createDocumentFragment();
    let run = null;

    Array.from(el.childNodes).forEach((child) => {
      if (child.nodeType === 1 && HEAL_BLOCK_TAGS.has(child.tagName)) {
        Object.keys(props).forEach((name) => {
          if (!child.style.getPropertyValue(name)) child.style.setProperty(name, props[name]);
        });
        frag.appendChild(child);
        run = null;
      } else if (child.nodeType === 3 && !child.data.trim() && !run) {
        frag.appendChild(child);
      } else {
        if (!run) {
          run = el.cloneNode(false);
          frag.appendChild(run);
        }
        run.appendChild(child);
      }
    });

    const nodes = Array.from(frag.childNodes);
    el.replaceWith(frag);
    return nodes;
  }

  function healBlockWrappers(root) {
    if (!root || !root.querySelector || !root.querySelector(HEAL_QUICK_SELECTOR)) return false;

    let healed = false;
    for (let pass = 0; pass < 6; pass++) {
      const targets = Array.from(root.querySelectorAll(HEAL_INLINE_SELECTOR)).filter(inlineHasBlockChild);
      if (!targets.length) break;
      targets.forEach((el) => {
        if (root.contains(el)) {
          unwrapInlineWithBlocks(el);
          healed = true;
        }
      });
    }
    return healed;
  }

  /**
   * O HTML vindo do roteirista tem font-size/font-family/line-height removidos (o operador
   * decide os tamanhos). Isso apagava também a formatação do próprio operador (trechos em
   * 48pt, fonte própria...). Aqui devolvemos ao novo HTML os tamanhos/fontes que o texto
   * do operador já tinha, bloco a bloco (mesmo texto = mesmo bloco; bloco editado = bloco
   * na mesma posição entre dois blocos iguais).
   */
  function restoreHostSizing(oldEditor, html) {
    const SIZING = ["font-size", "font-family", "line-height"];
    const SIZING_SELECTOR = '[style*="font-size"], [style*="font-family"], [style*="line-height"]';
    try {
      if (!oldEditor || !html || !oldEditor.querySelector(SIZING_SELECTOR)) return html;

      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const oldBlocks = Array.from(oldEditor.children);
      const newBlocks = Array.from(tmp.children);
      if (!oldBlocks.length || !newBlocks.length) return html;

      const sig = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
      const hasSizing = (el) => !!el.style && SIZING.some((p) => el.style.getPropertyValue(p));
      const copySizing = (from, to) => {
        SIZING.forEach((p) => {
          const v = from.style.getPropertyValue(p);
          if (v) to.style.setProperty(p, v);
        });
      };

      // 1) Blocos com o mesmo texto (o mais próximo da posição original).
      const oldBySig = new Map();
      oldBlocks.forEach((b, j) => {
        const s = sig(b);
        if (!oldBySig.has(s)) oldBySig.set(s, []);
        oldBySig.get(s).push(j);
      });
      const used = new Set();
      const pair = new Array(newBlocks.length).fill(-1);
      newBlocks.forEach((nb, i) => {
        const candidates = oldBySig.get(sig(nb));
        if (!candidates) return;
        let best = -1;
        let bestDist = Infinity;
        candidates.forEach((j) => {
          const d = Math.abs(j - i);
          if (!used.has(j) && d < bestDist) {
            bestDist = d;
            best = j;
          }
        });
        if (best >= 0) {
          used.add(best);
          pair[i] = best;
        }
      });

      // 2) Blocos editados: mesma posição relativa entre dois blocos já casados.
      let prevNew = -1;
      let prevOld = -1;
      for (let i = 0; i < newBlocks.length; i++) {
        if (pair[i] >= 0) {
          prevNew = i;
          prevOld = pair[i];
          continue;
        }
        let nextOld = oldBlocks.length;
        for (let k = i + 1; k < newBlocks.length; k++) {
          if (pair[k] >= 0) {
            nextOld = pair[k];
            break;
          }
        }
        const candidate = prevOld + 1 + (i - prevNew - 1);
        if (candidate < nextOld && !used.has(candidate)) {
          used.add(candidate);
          pair[i] = candidate;
        }
      }

      // 3) Copia os estilos de tamanho/fonte de cada bloco antigo para o novo.
      newBlocks.forEach((nb, i) => {
        if (pair[i] < 0) return;
        const ob = oldBlocks[pair[i]];
        if (hasSizing(ob)) copySizing(ob, nb);

        const oldEls = Array.from(ob.querySelectorAll("*"));
        const newEls = Array.from(nb.querySelectorAll("*"));
        const sameShape =
          oldEls.length === newEls.length && oldEls.every((el, k) => el.tagName === newEls[k].tagName);

        if (sameShape) {
          oldEls.forEach((el, k) => {
            if (hasSizing(el)) copySizing(el, newEls[k]);
          });
        } else {
          // Estrutura mudou (trecho editado): casa pelos elementos com o mesmo texto.
          const free = oldEls.filter(hasSizing);
          newEls.forEach((el) => {
            if (hasSizing(el)) return;
            const idx = free.findIndex((o) => o.tagName === el.tagName && sig(o) === sig(el));
            if (idx >= 0) copySizing(free.splice(idx, 1)[0], el);
          });
        }
      });

      return tmp.innerHTML;
    } catch (_) {
      return html;
    }
  }

  function getOperatorFontSizePt() {
    const prompter = document.getElementById("prompterText-control");
    const editor = getActiveTextEditorArea();
    let size = parseInt(prompter?.style.fontSize, 10);
    if (!size || size <= 0) size = parseInt(editor?.style.fontSize, 10);
    if ((!size || size <= 0) && typeof currentFontSizePT === "number" && currentFontSizePT > 0) {
      size = currentFontSizePT;
    }
    if (!size || size <= 0) {
      size = (typeof globalPrefs !== "undefined" && globalPrefs?.defaultFontSize) || 24;
    }
    return size;
  }

  function getPrompterFontScale() {
    return currentPrompterFontScale > 0 ? currentPrompterFontScale : 100;
  }

  function getScaledPrompterFontSize(sizeInPt) {
    const baseSize = Number.parseFloat(sizeInPt);
    if (!Number.isFinite(baseSize) || baseSize <= 0) return 0;
    return Math.round(baseSize * getPrompterFontScale()) / 100;
  }

  function applyPrompterFontScale(control, baseSize) {
    if (!control) return;

    const scaledSize = getScaledPrompterFontSize(baseSize);
    if (scaledSize > 0) control.style.fontSize = `${scaledSize}pt`;

    control.querySelectorAll('[style*="font-size"]').forEach((element) => {
      let elementBaseSize = Number.parseFloat(element.dataset.promptiqBaseFontSize);
      if (!Number.isFinite(elementBaseSize)) {
        elementBaseSize = Number.parseFloat(element.style.fontSize);
        if (!Number.isFinite(elementBaseSize)) return;
        element.dataset.promptiqBaseFontSize = String(elementBaseSize);
      }

      element.style.fontSize = `${getScaledPrompterFontSize(elementBaseSize)}pt`;
    });
  }

  function getStableOperatorFontSizePt() {
    const toolbarInput = document.getElementById("font-size-toolbar-fix");
    const toolbarSize = parseInt(toolbarInput?.value, 10);
    if (toolbarSize > 0) return toolbarSize;

    if (typeof currentFontSizePT === "number" && currentFontSizePT > 0) {
      return currentFontSizePT;
    }

    return getOperatorFontSizePt();
  }

  function getVisibleEditorFontSizePt(editor) {
    if (!editor) return 0;

    const probe =
      editor.querySelector('[style*="font-size"]') ||
      editor.querySelector('font[size]') ||
      editor.querySelector('p, div, span, h1, h2, h3') ||
      editor;

    const px = parseFloat(window.getComputedStyle(probe).fontSize) || 0;
    if (px <= 0) return 0;

    return Math.round((px / 96) * 72);
  }

  function rebroadcastReadProgress() {
    _lastReadUpdateTime = 0;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (typeof updateReadProgress === "function") {
          updateReadProgress(true, true);
          return;
        }
        const snap = typeof getReadProgressSnapshot === "function" ? getReadProgressSnapshot() : null;
        if (snap && typeof broadcastReadProgressUpdate === "function") {
          broadcastReadProgressUpdate(snap);
        }
      });
    });
  }

  function applyOperatorEditorTypography(editor, preserveFontSize = false) {
    if (!editor) return;
    const prompter = document.getElementById("prompterText-control");

    // ===================================================================
    // CORREÇÃO: Preservar o tamanho de fonte do editor durante edições remotas
    // ===================================================================
    // Quando o roteirista edita remotamente, não queremos que o font size
    // seja sobrescrito com o do operador. Isso evita que um texto de 48pt
    // caia para 30pt apenas porque o operador tem tamanho diferente.
    if (!preserveFontSize) {
      const size = getOperatorFontSizePt();
      currentFontSizePT = size;
      editor.style.fontSize = `${size}pt`;
    }

    editor.style.lineHeight = prompter?.style.lineHeight || editor.style.lineHeight || "1.4";
    // Preserva a fonte escolhida pelo operador (container-level) mesmo após edições
    // remotas que removem as tags <font face> inline.
    const font =
      currentFontFamily ||
      prompter?.style.fontFamily ||
      editor.style.fontFamily ||
      (typeof globalPrefs !== "undefined" && globalPrefs ? globalPrefs.defaultFont : "");
    if (font) {
      editor.style.fontFamily = font;
      if (prompter && !prompter.style.fontFamily) prompter.style.fontFamily = font;
    }
    if (prompter?.style.textAlign) editor.style.textAlign = prompter.style.textAlign;
  }

  /**
   * Aplica a fonte escolhida pelo operador em TODO o roteiro, fixando no container
   * (editor + prompter) e nas preferências globais. Remove tags/estilos de fonte
   * inline para que a fonte seja uniforme e sobreviva às edições do roteirista.
   * Retorna o nome da fonte aplicada.
   */
  function applyOperatorFontFamily(fontName) {
    if (!fontName) return null;
    const editor = getActiveTextEditorArea();
    const prompter = document.getElementById("prompterText-control");

    if (editor) {
      // Remove fontes inline conflitantes (mantém o restante do estilo intacto)
      editor.querySelectorAll("font[face]").forEach((el) => el.removeAttribute("face"));
      editor.querySelectorAll('[style*="font-family"]').forEach((el) => {
        el.style.removeProperty("font-family");
        if (!el.getAttribute("style")) el.removeAttribute("style");
      });
      editor.style.fontFamily = fontName;
    }
    if (prompter) prompter.style.fontFamily = fontName;
    if (typeof globalPrefs !== "undefined" && globalPrefs) {
      globalPrefs.defaultFont = fontName;
    }
    // Guarda a fonte da sessão para que ela não seja perdida quando outras
    // preferências (Line Spacing, etc.) forem salvas e reaplicadas.
    currentFontFamily = fontName;
    // Persiste a fonte nas configurações para sobreviver a reinícios.
    try {
      ipcRenderer.send("save-settings", { defaultFont: fontName });
    } catch (_) { }

    if (typeof syncContentToPrompter === "function") {
      syncContentToPrompter({ preserveVisibleAnchor: true });
    }
    if (typeof markDocumentAsUnsaved === "function" && typeof activeDocumentId !== "undefined") {
      markDocumentAsUnsaved(activeDocumentId);
    }
    if (typeof scheduleAutoSave === "function") scheduleAutoSave();

    return fontName;
  }

  function applyRemoteEditorUpdate(newHtml) {
    const editor = getActiveTextEditorArea();
    if (!editor || typeof newHtml !== "string") return false;

    // Referência da estrutura do operador (já "curada") para devolver tamanhos/fontes próprios.
    const hostRef = editor.cloneNode(true);
    healBlockWrappers(hostRef);
    const normalized = restoreHostSizing(hostRef, normalizeRemoteEditorHtml(newHtml));
    if (editor.innerHTML === normalized || getCleanContent(editor) === normalized) return false;

    // ===================================================================
    // Capturar posição de scroll ANTES de qualquer mudança
    // ===================================================================
    const wasScrolling = ScrollEngine.isRunning;
    const scrollPosBefore = ScrollEngine.decimalScroll || 0;

    if (wasScrolling) {
      console.log(`🔒 Sincronizando edição remota. Scroll protegido em: ${scrollPosBefore}px`);
    }

    // ===================================================================
    // CORREÇÃO: Preservar o fontSize do container ANTES de substituir o HTML
    // ===================================================================
    // O tamanho GLOBAL do roteiro é o do container do editor (o que o operador escolheu).
    // Não derivar de um trecho com tamanho próprio (ex.: o 1º span em 48pt), senão o
    // roteiro inteiro e o prompter passam a usar esse tamanho.
    const prompterEl = document.getElementById("prompterText-control");
    const containerPt = parseFloat(editor.style.fontSize) || 0;
    const preservedPt =
      containerPt ||
      (typeof currentFontSizePT === "number" && currentFontSizePT > 0 ? currentFontSizePT : 0) ||
      getStableOperatorFontSizePt() ||
      30;
    const preservedFontSize = `${preservedPt}pt`;
    currentFontSizePT = preservedPt;

    runWithoutRemoteBroadcast(() => {
      beginBulkEdit();
      editor.innerHTML = normalized;
      // ===================================================================
      // CORREÇÃO: RESTAURAR o tamanho de fonte do editor após substituir o HTML
      // Passa true para preserveFontSize para não sobrescrever com font do operador
      // ===================================================================
      editor.style.fontSize = preservedFontSize;
      if (prompterEl) applyPrompterFontScale(prompterEl, preservedPt);
      applyOperatorEditorTypography(editor, true);
      endBulkEdit(() => {
        if (typeof syncContentToPrompter === "function") {
          // Preserva o PONTO DE LEITURA (parágrafo sob a seta) via âncora de
          // conteúdo, para o texto não saltar quando o roteirista edita.
          // OBS: o tamanho/espaçamento do prompter já são aplicados dentro de
          // syncContentToPrompter (applyPrompterContainerStyles) ANTES da
          // âncora ser restaurada, mantendo o reposicionamento preciso. Por
          // isso não chamamos applyExactFontSizeToOperator aqui (evita mudar o
          // layout depois da âncora e causar pequeno salto).
          syncContentToPrompter({
            skipRemoteBroadcast: true,
            skipReadProgressRebroadcast: true,
            // Sempre preserva o ponto de leitura em edição remota (playback ou
            // scroll manual). A âncora cuida do caso "no topo" sem efeito.
            preserveScrollDuringRemoteEdit: true,
          });
        }

        // A âncora de conteúdo (em syncContentToPrompter) já reposicionou o
        // scroll para manter o mesmo parágrafo sob a seta. Não forçamos pixel
        // antigo nem congelamos a rolagem — o playback continua suave.

        rebroadcastReadProgress();
      });
    });

    return true;
  }

  function afterRemoteEditorApplied(editor) {
    if (!editor) return;
    flashRedBorder(editor);
    const container = document.getElementById("document-content-container");
    if (container) {
      container.style.transition = "box-shadow 0.2s";
      container.style.boxShadow = "inset 0 0 0 4px #ff0000";
      setTimeout(() => (container.style.boxShadow = "none"), 400);
    }
    flashRedBorderMultiple(editor, 2);
    if (typeof markDocumentAsUnsaved === "function" && typeof activeDocumentId !== "undefined") {
      markDocumentAsUnsaved(activeDocumentId);
    }
    if (typeof scheduleAutoSave === "function") scheduleAutoSave();
    if (isInternetServerActive && typeof broadcastTextUpdate === "function") {
      broadcastTextUpdate(getRemoteSyncContent());
    }
  }

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
  const lineSpacingToolbar = document.getElementById("line-spacing-toolbar");
  const prompterMarginSelect = document.getElementById("prompter-margin-select");
  const operatorEditPanel = document.getElementById("operator-edit-panel");

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
  const opBtnToggleEditPanel = document.getElementById("op-btn-toggle-edit-panel");

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

  // Seleciona um valor no <select>; se a opção não existir, cria uma para nunca
  // exibir o campo vazio (ex.: espaçamento/margem/tamanho vindos das Preferences).
  function setSelectValueSafe(select, value, label) {
    if (!select || value === undefined || value === null || value === "") return;
    const strValue = String(value);
    let option = Array.from(select.options).find((o) => o.value === strValue);
    if (!option) {
      option = new Option(label || strValue, strValue);
      select.add(option);
    }
    select.value = strValue;
  }

  // O modo edição mostra o texto no tamanho REAL (o número da barra, sem o Prompter Font
  // Scale); a escala em % só vale no prompter/tela cheia. Aqui só copiamos fundo, cor e
  // margens do prompter (via variáveis CSS).
  function applyPrompterLookToEditPanel() {
    const control = document.getElementById("prompterText-control");
    const container = document.querySelector(".prompter-in-control");
    if (!operatorEditPanel || !control || !container) return;

    const controlStyle = window.getComputedStyle(control);
    const bg = window.getComputedStyle(container).backgroundColor;
    const fg = controlStyle.color;

    const style = operatorEditPanel.style;
    style.setProperty("--op-edit-bg", bg);
    style.setProperty("--op-edit-fg", fg);
    style.setProperty("--op-edit-pad-l", controlStyle.paddingLeft);
    style.setProperty("--op-edit-pad-r", controlStyle.paddingRight);
  }

  function isEditPanelOpen() {
    return !!operatorEditPanel && !operatorEditPanel.classList.contains("collapsed");
  }

  // O prompter (oculto durante a edição) mudou de layout/conteúdo desde a abertura?
  // Se sim, ao fechar a edição ele é reancorado no ponto de leitura de antes.
  let _promptDirty = false;
  let _openPromptAnchor = null;

  // Mantém o visual do modo edição (escala/cor/margens) em dia quando o prompter
  // muda com o painel aberto (ex.: Prompter Font Scale vindo das Preferences).
  function refreshEditPanelLookIfOpen() {
    if (isEditPanelOpen()) {
      applyPrompterLookToEditPanel();
    }
  }

  // Âncora (parágrafo + fração) de uma linha de referência dentro de uma lista de blocos.
  function captureAnchorFromBlocks(blocks, refY) {
    if (!blocks.length) return null;

    const chosen = firstBlockBelow(blocks, refY);

    const r = blocks[chosen].getBoundingClientRect();
    return {
      idx: chosen,
      totalBlocks: blocks.length,
      fraction: Math.max(0, Math.min(1, (refY - r.top) / (r.height || 1))),
      text: normalizeAnchorText(blocks[chosen].textContent),
      prevText: chosen > 0 ? normalizeAnchorText(blocks[chosen - 1].textContent) : "",
      nextText: chosen < blocks.length - 1 ? normalizeAnchorText(blocks[chosen + 1].textContent) : "",
    };
  }

  const EDITOR_REF_FRAC = 0.3;

  // Trecho que o usuário está vendo no EDITOR (linha à fração `frac` do topo da área visível).
  function captureEditorAnchorInfo(frac = EDITOR_REF_FRAC) {
    const editor = getActiveTextEditorArea();
    if (!editor || editor.clientHeight <= 0) return null;

    const anchor = captureAnchorFromBlocks(
      getBlockElements(editor),
      editor.getBoundingClientRect().top + editor.clientHeight * frac
    );
    return anchor ? { anchor, cueFrac: frac } : null;
  }

  // Trecho sob a seta do prompter, no formato aceito por syncEditorScrollToPrompterAnchor.
  function capturePrompterAnchorInfo() {
    const container = document.querySelector(".prompter-in-control");
    if (!container || container.clientHeight <= 0) return null;

    const anchor = captureCueAnchor();
    if (!anchor) return null;

    const rect = container.getBoundingClientRect();
    return {
      anchor,
      cueFrac: Math.max(0, Math.min(1, (getCueViewportY() - rect.top) / (rect.height || 1))),
    };
  }

  // Posiciona o editor no trecho descrito por anchorInfo.
  function syncEditorScrollToPrompterAnchor(anchorInfo) {
    const editor = getActiveTextEditorArea();
    if (!editor || !anchorInfo || !anchorInfo.anchor) return;

    const blocks = getBlockElements(editor);
    if (!blocks.length) return;

    const idx = findAnchorBlockIndex(blocks, anchorInfo.anchor);
    const blockRect = blocks[idx].getBoundingClientRect();
    const pointY = blockRect.top + anchorInfo.anchor.fraction * (blockRect.height || 0);
    const editorRect = editor.getBoundingClientRect();
    const targetY = editorRect.top + editor.clientHeight * anchorInfo.cueFrac;

    editor.scrollTop = Math.max(0, editor.scrollTop + (pointY - targetY));
  }

  // Qualquer interação manual cancela re-ancoragens pendentes (edição e mudanças de estilo).
  let _positionHoldRunId = 0;
  let _activeHold = null;
  // O operador moveu/editou o texto no editor nesta sessão de edição (rolou, clicou, digitou)?
  let _editUserMoved = false;
  let _editViewFrac = EDITOR_REF_FRAC;
  function invalidatePositionHolds() {
    _positionHoldRunId += 1;
    _activeHold = null;
  }
  const cancelPositionHolds = (e) => {
    if (e && e.target && e.target.closest && e.target.closest("#toolbar-content, #operator-toolbar")) return;
    if (e && e.target && e.target.closest && e.target.closest("#operator-edit-panel")) _editUserMoved = true;
    invalidatePositionHolds();
  };
  document.addEventListener("wheel", cancelPositionHolds, { capture: true, passive: true });
  document.addEventListener("pointerdown", cancelPositionHolds, true);
  document.addEventListener("keydown", cancelPositionHolds, true);

  function runAtCheckpoints(delays, runId, fn) {
    delays.forEach((ms) => {
      setTimeout(() => {
        if (runId !== _positionHoldRunId) return;
        fn();
      }, ms);
    });
  }

  /**
   * Segura o ponto de leitura (prompter) e o ponto visto no editor durante uma
   * mudança de estilo/configuração (fonte, tamanho, cor, margem, escala...).
   * Reaplica a âncora após o reflow até o layout estabilizar, então o texto
   * nunca volta ao início nem se desloca.
   */
  function holdReadPosition() {
    const operatorPane = document.getElementById("operator-tab-pane");
    if (!operatorPane || !operatorPane.classList.contains("active")) return;

    const runId = ++_positionHoldRunId;
    const container = document.querySelector(".prompter-in-control");
    const control = document.getElementById("prompterText-control");
    if (!container || !control) return;

    const editing = isEditPanelOpen();
    // Com a edição aberta só o EDITOR está visível: o prompter (oculto) é reancorado
    // uma única vez ao fechar o painel, em vez de forçar seu layout a cada mudança.
    if (editing) _promptDirty = true;

    // Mudanças encadeadas (ação + settings devolvidas pelo main) reutilizam a âncora
    // original: recapturar no meio do reflow guardaria um ponto já deslocado.
    let hold = _activeHold && Date.now() - _activeHold.time < 1500 ? _activeHold : null;
    if (!hold) {
      hold = {
        time: Date.now(),
        promptAnchor: !editing && container.clientHeight > 0 ? captureCueAnchor() : null,
        fallbackScroll: ScrollEngine.decimalScroll || (editing ? 0 : container.scrollTop) || 0,
        editorInfo: editing ? captureEditorAnchorInfo() : null,
      };
    }
    _activeHold = hold;
    const { promptAnchor, fallbackScroll, editorInfo } = hold;

    runAtCheckpoints([0, 80, 250, 600, 1200], runId, () => {
      if (!ScrollEngine.isRunning && !isEditPanelOpen()) {
        let restored = false;
        if (promptAnchor) {
          ScrollEngine.invalidateMetrics();
          restored = restoreCueAnchor(promptAnchor);
        }
        if (!restored && fallbackScroll > 0 && Math.abs(container.scrollTop - fallbackScroll) > 1) {
          ScrollEngine.decimalScroll = fallbackScroll;
          container.scrollTop = fallbackScroll;
        }

        const contentH = control.offsetHeight || control.scrollHeight || 1;
        ipcRenderer.send("sync-scroll-position", {
          textPercent: Math.min(1, Math.max(0, (ScrollEngine.decimalScroll || 0) / contentH)),
        });
      }

      if (editorInfo && !operatorEditPanel.classList.contains("collapsed")) {
        syncEditorScrollToPrompterAnchor(editorInfo);
      }
    });
  }

  // Esc captura o trecho ANTES de qualquer mudança de layout (sair do fullscreen,
  // abrir o painel...), para o editor abrir exatamente no ponto que o operador via.
  let _escPreAnchor = null;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const collapsed = !operatorEditPanel || operatorEditPanel.classList.contains("collapsed");
      _escPreAnchor = collapsed ? { info: capturePrompterAnchorInfo(), time: Date.now() } : null;
    },
    true
  );

  // Estado do último fechamento do painel: permite reabrir (Esc, Esc) exatamente
  // onde o editor estava, se o prompter não foi movido nesse intervalo.
  let _lastEditClose = null;

  function setOperatorEditPanelCollapsed(
    collapsed,
    { navigateToCaret: wantCaretNav = true, anchorInfo: providedAnchor = null } = {}
  ) {
    if (!operatorEditPanel) return;

    const wasCollapsed = operatorEditPanel.classList.contains("collapsed");
    if (wasCollapsed !== collapsed) {
      invalidatePositionHolds();
      let anchorInfo = null;

      if (!collapsed) {
        // Descarta caret antigo: só vale o que for posicionado nesta sessão de edição.
        if (typeof TabNavigationManager !== "undefined") {
          TabNavigationManager.lastCaretEditor = null;
          TabNavigationManager.lastCaretNode = null;
          TabNavigationManager.caretIntent = false;
        }

        // Ao abrir a edição, pausa a rolagem para o texto não fugir enquanto digita.
        if (typeof ScrollEngine !== "undefined" && ScrollEngine.isRunning) {
          ScrollEngine.pause();
          ipcRenderer.send("control-prompter", "pause");
        }

        // Trecho sob a seta ANTES de cobrir o prompter (ou capturado antes do Esc).
        _openPromptAnchor = providedAnchor || capturePrompterAnchorInfo();
        _promptDirty = false;
        anchorInfo = _openPromptAnchor;

        // Reabertura sem o prompter ter se movido: volta ao ponto exato da edição anterior.
        const promptScroll = ScrollEngine.decimalScroll || 0;
        if (_lastEditClose && Math.abs(_lastEditClose.promptScroll - promptScroll) < 1 && _lastEditClose.editorInfo) {
          anchorInfo = _lastEditClose.editorInfo;
        }
        _editUserMoved = false;
        _editViewFrac = anchorInfo ? anchorInfo.cueFrac : EDITOR_REF_FRAC;
      } else {
        _lastEditClose = {
          editorInfo: captureEditorAnchorInfo(),
          promptScroll: ScrollEngine.decimalScroll || 0,
        };
      }

      // Saindo da edição: o prompter abre no ponto que o operador escolheu (cursor
      // posicionado de propósito e visível) ou, se ele só rolou o editor, no trecho que
      // está vendo. Sem interação alguma, a posição do prompter não muda.
      let navigateToCaret = false;
      let viewedInfo = null;
      if (collapsed && wantCaretNav && typeof TabNavigationManager !== "undefined") {
        navigateToCaret = TabNavigationManager.captureEditorCaretAsPendingNavigation();
        if (navigateToCaret) {
          flushSyncContentToPrompter();
        } else if (_editUserMoved) {
          viewedInfo = captureEditorAnchorInfo(_editViewFrac);
          if (viewedInfo) flushSyncContentToPrompter();
        }
      }

      // O painel é uma camada sobre o prompter (não altera o tamanho dele), então
      // a posição de leitura do prompter é preservada sem nenhum ajuste.
      operatorEditPanel.classList.toggle("collapsed", collapsed);

      if (navigateToCaret) TabNavigationManager.applyPendingNavigationNow();

      if (viewedInfo && restoreCueAnchor(viewedInfo.anchor)) {
        const control = document.getElementById("prompterText-control");
        const contentH = (control && (control.offsetHeight || control.scrollHeight)) || 1;
        ipcRenderer.send("sync-scroll-position", {
          textPercent: Math.min(1, Math.max(0, (ScrollEngine.decimalScroll || 0) / contentH)),
        });
      } else if (collapsed && !navigateToCaret && _promptDirty && _openPromptAnchor) {
        // Fonte/escala/texto mudaram com o prompter oculto: volta ao ponto de leitura de antes.
        flushSyncContentToPrompter();
        if (restoreCueAnchor(_openPromptAnchor.anchor)) {
          const control = document.getElementById("prompterText-control");
          const contentH = (control && (control.offsetHeight || control.scrollHeight)) || 1;
          ipcRenderer.send("sync-scroll-position", {
            textPercent: Math.min(1, Math.max(0, (ScrollEngine.decimalScroll || 0) / contentH)),
          });
        }
      }
      if (collapsed) _promptDirty = false;

      if (!collapsed) {
        applyPrompterLookToEditPanel();
        syncEditorScrollToPrompterAnchor(anchorInfo);

        // O reflow (janela saindo do fullscreen, fontes) pode mover o editor: reaplica.
        const runId = _positionHoldRunId;
        runAtCheckpoints([60, 200, 450, 900], runId, () => {
          if (!operatorEditPanel.classList.contains("collapsed")) {
            applyPrompterLookToEditPanel();
            syncEditorScrollToPrompterAnchor(anchorInfo);
          }
        });
      }
    }

    document.body.classList.toggle("operator-edit-mode", !collapsed);
    window.dispatchEvent(new CustomEvent("operator-edit-mode-changed"));

    if (opBtnToggleEditPanel) {
      opBtnToggleEditPanel.classList.toggle("active", !collapsed);
      opBtnToggleEditPanel.setAttribute(
        "title",
        collapsed ? "Edit script (Esc)" : "Back to prompter (Esc)"
      );
    }
  }

  function ensureOperatorEditPanelVisible(anchorInfo = null) {
    setOperatorEditPanelCollapsed(false, { anchorInfo });
  }

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
  let allowEditorFocusAfterOutsideClick = false;

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
    margins: [40, 0, 100, 200, 300],
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
        name: 'Pacing / Timing',
        icon: 'bi-speedometer2',
        items: [
          { label: 'SLOW DOWN', message: 'SLOW DOWN', color: '#FFFFFF', bg: '#FFC107', icon: 'bi-cone-striped' }, // Yellow
          { label: 'SPEED UP', message: 'SPEED UP', color: '#FFFFFF', bg: '#28A745', icon: 'bi-lightning-fill' }, // Green
          { label: 'STRETCH', message: 'STALL / STRETCH', color: '#FFFFFF', bg: '#17A2B8', icon: 'bi-arrows-expand' }, // Blue
          { label: 'WRAP UP', message: 'WRAP UP NOW', color: '#FFFFFF', bg: '#FD7E14', icon: 'bi-hourglass-bottom' }, // Orange
          { label: 'STOP', message: 'STOP', color: '#FFFFFF', bg: '#DC3545', icon: 'bi-stop-circle-fill' } // Red
        ]
      },
      {
        id: 'camera',
        name: 'Camera / Eye Line',
        icon: 'bi-camera-video',
        items: [
          { label: 'CAM 1', message: '>>> CAM 1 <<<', color: '#000000', bg: '#FFFFFF', icon: 'bi-1-square' },
          { label: 'CAM 2', message: '>>> CAM 2 <<<', color: '#000000', bg: '#FFFFFF', icon: 'bi-2-square' },
          { label: 'CAM 3', message: '>>> CAM 3 <<<', color: '#000000', bg: '#FFFFFF', icon: 'bi-3-square' },
          { label: 'LOOK UP', message: 'LOOK UP', color: '#FFFFFF', bg: '#6C757D', icon: 'bi-arrow-up-circle' }
        ]
      },
      {
        id: 'audio',
        name: 'Audio / Technical',
        icon: 'bi-mic',
        items: [
          { label: 'SPEAK LOUD', message: 'SPEAK LOUDER', color: '#FFFFFF', bg: '#6610F2', icon: 'bi-volume-up' },
          { label: 'BREAK', message: 'COMMERCIAL BREAK', color: '#FFFFFF', bg: '#0DCAF0', icon: 'bi-pause-circle' },
          { label: 'IMPROVISE', message: 'AD-LIB (IMPROVISE)', color: '#000000', bg: '#FFD700', icon: 'bi-mic-mute' }
        ]
      },


      {
        id: 'custom',
        name: 'Write Message',
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

    // Qualquer mudança de configuração (fonte, escala, cores, margens...) mantém o ponto de leitura.
    holdReadPosition();

    // Guarda o defaultFontSize anterior ANTES de sobrescrever globalPrefs,
    // para detectar se o usuário realmente alterou o tamanho nas Preferences.
    const prevDefaultFontSize = globalPrefs ? globalPrefs.defaultFontSize : null;

    const prevDefaultFont = globalPrefs ? globalPrefs.defaultFont : null;

    const prevLineSpacing = globalPrefs ? globalPrefs.lineSpacing : null;

    globalPrefs = settings;

    const savedPrompterScale = Number.parseInt(settings.prompterFontScale, 10);
    currentPrompterFontScale = savedPrompterScale === 30
      ? 100
      : (Number.isFinite(savedPrompterScale) && savedPrompterScale > 0
        ? savedPrompterScale
        : 100);

    // Preserva a fonte ativa da sessão: se o usuário escolheu uma fonte na toolbar
    // e o salvamento de preferências (ex.: Line Spacing) não alterou a fonte,
    // mantém a fonte da sessão para não voltar ao padrão (Arial).
    if (currentFontFamily) {
      const fontChangedInPrefs =
        settings.defaultFont && prevDefaultFont && settings.defaultFont !== prevDefaultFont;
      if (fontChangedInPrefs) {
        currentFontFamily = settings.defaultFont;
      } else {
        globalPrefs.defaultFont = currentFontFamily;
      }
    }

    // Atualiza o espaçamento de linha (Line Spacing) vindo das Preferences.
    // Antes só atualizava quando currentLineSpacing era 0, o que travava o valor
    // após o primeiro carregamento e fazia a mudança não funcionar quando aberta
    // pela aba Operator. Agora atualiza quando: (a) ainda não há valor de sessão,
    // OU (b) o usuário realmente mudou o valor nas Preferences.
    if (settings.lineSpacing) {
      const ls = parseFloat(settings.lineSpacing);
      if (!isNaN(ls) && ls > 0) {
        const prevLs = parseFloat(prevLineSpacing);
        const changedInPrefs = isNaN(prevLs) || ls !== prevLs;
        if (!currentLineSpacing || changedInPrefs) {
          currentLineSpacing = ls;
        }
      }
    }

    // Aplica o tema salvo
    if (settings.appTheme) {
      if (settings.appTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.classList.add('dark-mode');
      } else {
        document.documentElement.removeAttribute('data-theme');
        document.body.classList.remove('dark-mode');
      }
    }

    // Reforço de peso de fonte (Arial mais grossa) — Preferences > Style.
    // Default true: se a chave não existir ainda, mantém ativo.
    const boost = (settings.fontWeightBoost !== false);
    document.body.classList.toggle("font-boost", boost);

    if (settings.defaultFontSize) {
      // Só aplica o tamanho no Operator se o usuário realmente alterou o valor
      // em Preferences, ou se é a carga inicial (prevDefaultFontSize === null).
      // Isso evita que salvar qualquer outra opção (ex.: reforço de fonte)
      // resete o tamanho que estava ativo na sessão.
      const fontSizeChanged = prevDefaultFontSize === null
        || settings.defaultFontSize !== prevDefaultFontSize;

      const fontSizePreset = document.getElementById('font-size-preset');
      const fontSizeCustom = document.getElementById('font-size-custom');

      if (fontSizeChanged) {
        // Não regredir tamanho ativo da sessão (ex.: prefs sem campo default-font-size)
        const sessionSize = currentFontSizePT > 0 ? currentFontSizePT : settings.defaultFontSize;
        const effectiveSize =
          settings.defaultFontSize >= sessionSize ? settings.defaultFontSize : sessionSize;

        currentFontSizePT = effectiveSize;
        if (fontSizePreset) fontSizePreset.value = effectiveSize;
        if (fontSizeCustom) fontSizeCustom.value = effectiveSize;
        applyExactFontSizeToOperator(effectiveSize);
      }
    }

    // Atualiza atalhos de teclado/mouse se HotkeyHandler existir
    if (typeof HotkeyHandler !== 'undefined') {
      HotkeyHandler.updateSettings(settings);
    }

    // Restaura estado dos botões de espelhamento
    if (typeof operatorState !== 'undefined') {
      // Mirror Horizontal
      if (settings.flipHorizontal !== undefined) {
        operatorState.mirrorH = settings.flipHorizontal;
        const btnMirrorH = document.getElementById('op-btn-mirror-h');
        if (btnMirrorH) {
          btnMirrorH.classList.toggle('active', settings.flipHorizontal);
        }
      }
      // Mirror Vertical
      if (settings.flipVertical !== undefined) {
        operatorState.mirrorV = settings.flipVertical;
        const btnMirrorV = document.getElementById('op-btn-mirror-v');
        if (btnMirrorV) {
          btnMirrorV.classList.toggle('active', settings.flipVertical);
        }
      }
    }

    if (typeof applySettingsToVisuals === 'function') {
      preserveOperatorReadPosition(() => {
        applySettingsToVisuals();
      }, 1);
      refreshEditPanelLookIfOpen();
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
  // AUTO-UPDATER: Modal de progresso de download (canto inferior direito)
  // ============================================================
  (function setupUpdateModal() {
    // Injeta estilos uma única vez
    const style = document.createElement('style');
    style.textContent = `
      @keyframes uSlideIn {
        from { transform: translateX(110%); opacity: 0; }
        to   { transform: translateX(0);    opacity: 1; }
      }
      @keyframes uSlideOut {
        from { transform: translateX(0);    opacity: 1; }
        to   { transform: translateX(110%); opacity: 0; }
      }
      #update-progress-panel {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 320px;
        background: #1e1e2e;
        color: #e2e8f0;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        border: 1px solid rgba(255,255,255,0.08);
        padding: 16px 18px 14px;
        z-index: 99999;
        font-family: 'Segoe UI', Arial, sans-serif;
        font-size: 13px;
        animation: uSlideIn 0.35s cubic-bezier(.22,.68,0,1.2) forwards;
      }
      #update-progress-panel.hiding {
        animation: uSlideOut 0.3s ease-in forwards;
      }
      #update-progress-panel .upp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      #update-progress-panel .upp-title {
        font-weight: 600;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 7px;
        color: #a5f3fc;
      }
      #update-progress-panel .upp-title i {
        font-size: 15px;
      }
      #update-progress-panel .upp-close {
        background: none;
        border: none;
        color: #64748b;
        font-size: 18px;
        cursor: pointer;
        line-height: 1;
        padding: 0;
        transition: color .2s;
      }
      #update-progress-panel .upp-close:hover { color: #e2e8f0; }
      #update-progress-panel .upp-version {
        font-size: 12px;
        color: #94a3b8;
        margin-bottom: 10px;
      }
      #update-progress-panel .upp-status {
        font-size: 12px;
        color: #94a3b8;
        margin-bottom: 8px;
      }
      #update-progress-panel .upp-bar-track {
        background: #2d3748;
        border-radius: 99px;
        height: 6px;
        overflow: hidden;
        margin-bottom: 12px;
      }
      #update-progress-panel .upp-bar-fill {
        height: 100%;
        border-radius: 99px;
        background: linear-gradient(90deg, #38bdf8, #818cf8);
        width: 0%;
        transition: width 0.4s ease;
      }
      #update-progress-panel .upp-restart-btn {
        display: none;
        width: 100%;
        background: linear-gradient(90deg, #38bdf8, #818cf8);
        color: #0f172a;
        border: none;
        border-radius: 8px;
        padding: 9px 0;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        transition: opacity .2s, transform .1s;
      }
      #update-progress-panel .upp-restart-btn:hover {
        opacity: .9;
        transform: scale(1.01);
      }
    `;
    document.head.appendChild(style);

    let panel = null;

    function getOrCreatePanel() {
      if (panel && document.body.contains(panel)) return panel;
      panel = document.createElement('div');
      panel.id = 'update-progress-panel';
      panel.innerHTML = `
        <div class="upp-header">
          <span class="upp-title"><i class="bi bi-arrow-repeat"></i> Update</span>
          <button class="upp-close" title="Close">&times;</button>
        </div>
        <div class="upp-version"></div>
        <div class="upp-status">Starting download...</div>
        <div class="upp-bar-track"><div class="upp-bar-fill"></div></div>
        <button class="upp-restart-btn">Restart and Install</button>
      `;
      document.body.appendChild(panel);

      panel.querySelector('.upp-close').addEventListener('click', () => {
        panel.classList.add('hiding');
        setTimeout(() => { if (panel) panel.remove(); panel = null; }, 300);
      });

      panel.querySelector('.upp-restart-btn').addEventListener('click', () => {
        ipcRenderer.send('restart_app');
      });

      return panel;
    }

    function hidePanel() {
      if (panel && document.body.contains(panel)) {
        panel.classList.add('hiding');
        setTimeout(() => { if (panel) panel.remove(); panel = null; }, 300);
      }
    }

    // Disparado pelo auto-check silencioso OU pelo Check Now quando available
    ipcRenderer.on('update-available-silent', (_, info) => {
      const p = getOrCreatePanel();
      p.querySelector('.upp-version').textContent = `New version: ${info.version}`;
      p.querySelector('.upp-status').textContent = 'Downloading update...';
      p.querySelector('.upp-bar-fill').style.width = '0%';
      p.querySelector('.upp-restart-btn').style.display = 'none';
    });

    // Progresso do download
    ipcRenderer.on('update-download-progress', (_, data) => {
      const p = getOrCreatePanel();
      const pct = Math.round(data.percent || 0);
      p.querySelector('.upp-bar-fill').style.width = `${pct}%`;
      const mb = (v) => (v / 1024 / 1024).toFixed(1);
      p.querySelector('.upp-status').textContent =
        `Downloading... ${pct}%  (${mb(data.transferred)} / ${mb(data.total)} MB)`;
    });

    // Download completo — mostra botão de reiniciar
    ipcRenderer.on('update_downloaded', (_, info) => {
      const p = getOrCreatePanel();
      p.querySelector('.upp-version').textContent = `Version ${info.version} ready!`;
      p.querySelector('.upp-bar-fill').style.width = '100%';
      p.querySelector('.upp-status').textContent = 'Download complete. Click to install.';
      p.querySelector('.upp-restart-btn').style.display = 'block';
    });

    // Expõe para o preferences-module poder acionar o painel ao clicar Check Now
    window._showUpdateAvailablePanel = (version) => {
      const p = getOrCreatePanel();
      p.querySelector('.upp-version').textContent = `New version: ${version}`;
      p.querySelector('.upp-status').textContent = 'Downloading update...';
      p.querySelector('.upp-bar-fill').style.width = '0%';
      p.querySelector('.upp-restart-btn').style.display = 'none';
    };
    window._hideUpdatePanel = hidePanel;
  })();


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
   * Mostra o overlay de Standby APENAS na tela de projeção/broadcast
   */
  function showStandby() {
    if (isStandbyActive) return;

    isStandbyActive = true;

    // NÃO mostra na tela principal - apenas envia para a janela de projeção
    ipcRenderer.send('show-standby-projection', {
      imagePath: standbySettings.imagePath,
      enabled: true
    });

    console.log('[Standby] Modo Standby ativado (enviado para projeção)');
  }

  /**
   * Esconde o overlay de Standby na tela de projeção
   */
  function hideStandby() {
    if (!isStandbyActive) return;

    // Envia comando para esconder standby na projeção
    ipcRenderer.send('show-standby-projection', {
      imagePath: null,
      enabled: false
    });

    isStandbyActive = false;
    console.log('[Standby] Modo Standby desativado (enviado para projeção)');
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
      editor.style.fontFamily = currentFontFamily || prefs.defaultFont;
      // Usa o tamanho global se existir, senão usa o padrão das prefs
      editor.style.fontSize = (typeof currentFontSizePT !== 'undefined' && currentFontSizePT > 0)
        ? `${currentFontSizePT}pt`
        : `${prefs.defaultFontSize}pt`;

      editor.style.lineHeight = currentLineSpacing || prefs.lineSpacing;
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
      prompterText.style.fontFamily = currentFontFamily || prefs.defaultFont;
      prompterText.style.color = prefs.defaultFontColor;
      prompterContainer.style.backgroundColor = prefs.backgroundColor;

      // Aplica cor também no container PAI (wrapper)
      const prompterWrapper = document.getElementById("operator-prompter-wrapper");
      if (prompterWrapper && prefs.backgroundColor) {
        prompterWrapper.style.backgroundColor = prefs.backgroundColor;
      }

      // Detecta se está invertido baseado na cor de fundo
      if (prefs.backgroundColor === "#FFFFFF" || prefs.backgroundColor === "white") {
        operatorState.isInverted = true;
      } else if (prefs.backgroundColor === "#000000" || prefs.backgroundColor === "black") {
        operatorState.isInverted = false;
      }

      // Atualiza cores da barra de progresso
      const progressBar = document.getElementById("prompter-custom-scrollbar");
      const progressThumb = document.getElementById("prompter-scrollbar-thumb");
      if (progressBar && prefs.backgroundColor) {
        progressBar.style.backgroundColor = prefs.backgroundColor;
      }
      if (progressThumb) {
        // Usa a cor personalizada se definida, senão usa a cor do texto
        progressThumb.style.backgroundColor = prefs.progressThumbColor || prefs.defaultFontColor || '#FFFFFF';
      }

      // ✅ USA A MEMÓRIA GLOBAL (currentFontSizePT)
      if (typeof currentFontSizePT !== 'undefined' && currentFontSizePT > 0) {
        applyPrompterFontScale(prompterText, currentFontSizePT);
      } else if (prefs.defaultFontSize) {
        // Fallback: usa as preferências se existirem
        applyPrompterFontScale(prompterText, prefs.defaultFontSize);
      }

      prompterContainer.style.display = 'block';
      prompterText.style.paddingTop = '40px';

      const parsedMargin = Number.parseInt(prefs.prompterMargin, 10);
      const userMargin = Number.isFinite(parsedMargin) ? parsedMargin : 40;
      const safeZoneArrow = 20;
      prompterText.style.paddingLeft = `${userMargin + safeZoneArrow}px`;
      prompterText.style.paddingRight = `${userMargin}px`;
      prompterText.style.lineHeight = currentLineSpacing || prefs.lineSpacing || 1.5;

      if (lineSpacingToolbar) {
        setSelectValueSafe(lineSpacingToolbar, parseFloat(currentLineSpacing || prefs.lineSpacing || 1.5), `Line ${parseFloat(currentLineSpacing || prefs.lineSpacing || 1.5)}x`);
      }
      if (prompterMarginSelect) {
        setSelectValueSafe(prompterMarginSelect, userMargin, `Margin ${userMargin}`);
      }

      const foundMarginIndex = operatorState.margins.indexOf(Number(userMargin));
      if (foundMarginIndex >= 0) {
        operatorState.marginIndex = foundMarginIndex;
      }

      applyPrompterTextAlign(getEditorTextAlign(getActiveTextEditorArea()));

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
      // Verifica se deve mostrar o cue marker (padrão: true)
      const shouldShowCue = prefs.showCueMarker !== false;
      cueMarker.style.display = shouldShowCue ? 'flex' : 'none';

      if (shouldShowCue) {
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

  // Controle de validade da reancoragem pós-fullscreen.
  // Cada interação relevante invalida timers antigos para evitar saltos tardios.
  let _fullscreenAnchorRunId = 0;

  function cancelPendingFullscreenAnchorRestore() {
    _fullscreenAnchorRunId += 1;
  }

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
    lastScrollIpcTime: 0,
    lastReadProgressTime: 0,
    lastProgressBarTime: 0,
    scrollIpcMs: 50,
    readProgressMs: 50,
    progressBarMs: 32,
    _metricsCache: null,
    _readProgressHeartbeatId: null,

    invalidateMetrics: function () {
      this._metricsCache = null;
    },

    getScrollMetrics: function (textEl, container) {
      if (this._metricsCache) return this._metricsCache;
      const contentHeight = textEl.offsetHeight;
      const containerHeight = container.clientHeight;
      const maxScroll = Math.max(0, contentHeight - containerHeight + containerHeight / 2);
      const scrollDenom = Math.max(1, contentHeight - containerHeight);
      this._metricsCache = { contentHeight, containerHeight, maxScroll, scrollDenom };
      return this._metricsCache;
    },

    getTextElement: function () {
      return document.getElementById("prompterText-control");
    },

    start: function () {
      if (this.isRunning) return;

      // Se o operador retomou a rolagem, não permitir que callbacks antigos de
      // fullscreen reposicionem o texto alguns ms depois.
      cancelPendingFullscreenAnchorRestore();

      // Garante que o container existe
      const container = document.querySelector(".prompter-in-control");
      if (!container) return;

      const textEl = this.getTextElement();
      if (!textEl) return;

      // Indexa parágrafos para rastreamento de texto lido (uma vez ao iniciar)
      if (typeof ensureParaIndexing === "function") ensureParaIndexing();
      this.invalidateMetrics();

      this.isRunning = true;
      this.lastFrameTime = performance.now();
      this.lastScrollIpcTime = 0;
      this.lastReadProgressTime = 0;
      this.lastProgressBarTime = 0;

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

      requestAnimationFrame(() => {
        if (typeof updateReadProgress === "function") updateReadProgress(true, true);
      });

      this.startReadProgressHeartbeat();
      this.loop();
    },


    pause: function () {
      cancelPendingFullscreenAnchorRestore();
      this.isRunning = false;
      if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;

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

      if (_syncPrompterTimer) {
        clearTimeout(_syncPrompterTimer);
        _syncPrompterTimer = null;
        if (typeof syncContentToPrompter === "function") {
          syncContentToPrompter();
        }
      }

      if (typeof updateReadProgress === "function") updateReadProgress(true, true);
      this.stopReadProgressHeartbeat();
    },

    stop: function () {
      this.stopReadProgressHeartbeat();
      this.pause();
      const container = document.querySelector(".prompter-in-control");
      if (container) {
        container.scrollTop = 0;
        this.decimalScroll = 0;
      }
      this.setSpeed(0);
      handlePlaybackTimer('stop');
      updateProgressBar(0);
      if (typeof clearReadProgress === "function") clearReadProgress();
    },

    setSpeed: function (val) {
      let newSpeed = Number.parseInt(val, 10);
      if (!Number.isFinite(newSpeed)) newSpeed = 0;
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

    startReadProgressHeartbeat: function () {
      this.stopReadProgressHeartbeat();
      this._readProgressHeartbeatId = setInterval(() => {
        if (typeof updateReadProgress === "function") updateReadProgress(true, true);
      }, 250);
    },

    stopReadProgressHeartbeat: function () {
      if (this._readProgressHeartbeatId) {
        clearInterval(this._readProgressHeartbeatId);
        this._readProgressHeartbeatId = null;
      }
    },

    loop: function () {
      if (!this.isRunning) return;

      const now = performance.now();
      const deltaTime = Math.min(now - this.lastFrameTime, 48);
      this.lastFrameTime = now;

      const speedMultiplier = 3.0;
      const pixelsPerSecond = this.speed * speedMultiplier;
      const pixelsToScroll = (pixelsPerSecond * deltaTime) / 1000;

      const textEl = this.getTextElement();
      const container = document.querySelector(".prompter-in-control");

      if (container && textEl && Math.abs(pixelsToScroll) > 0.001) {
        this.decimalScroll += pixelsToScroll;

        const metrics = this.getScrollMetrics(textEl, container);
        const { contentHeight, maxScroll, scrollDenom } = metrics;

        if (now - this.lastProgressBarTime >= this.progressBarMs) {
          this.lastProgressBarTime = now;
          const scrollRatio = Math.min(1, Math.max(0, this.decimalScroll / scrollDenom));
          updateProgressBar(scrollRatio);
        }

        if (pixelsToScroll > 0 && this.decimalScroll >= maxScroll) {
          if (globalPrefs && globalPrefs.continuousLoop) {
            this.decimalScroll = 0;
          } else {
            this.pause();
            return;
          }
        } else if (pixelsToScroll < 0 && this.decimalScroll <= 0) {
          this.decimalScroll = 0;
        }

        textEl.style.transform = `translate3d(0, ${-this.decimalScroll}px, 0)`;

        if (typeof updateReadProgress === "function") updateReadProgress(true, true);
      }

      if (now - this.lastScrollIpcTime >= this.scrollIpcMs && container && textEl) {
        this.lastScrollIpcTime = now;
        const { contentHeight } = this.getScrollMetrics(textEl, container);
        const textPercentage =
          contentHeight > 0 ? Math.min(1, Math.max(0, this.decimalScroll / contentHeight)) : 0;
        const readProgress =
          typeof computeReadProgressPayload === "function" ? computeReadProgressPayload() : null;
        ipcRenderer.send("sync-scroll-position", { textPercent: textPercentage, readProgress });
      }

      if (
        now - this.lastReadProgressTime >= this.readProgressMs &&
        typeof updateReadProgress === "function"
      ) {
        this.lastReadProgressTime = now;
        updateReadProgress(true, true);
      }

      this.animationFrameId = requestAnimationFrame(() => this.loop());
    },
  };

  // Disponibiliza a mesma instância para módulos legados carregados via script tag
  // (ex.: tab-navigation.js, voice-module.js), evitando estados de scroll paralelos.
  window.ScrollEngine = ScrollEngine;
  // Âncora de leitura (parágrafo sob a seta) para tab-navigation.js reposicionar o
  // texto ao voltar ao Operator, mesmo que o layout tenha mudado enquanto estava oculto.
  window.PromptiqReadAnchor = {
    capture: () => captureCueAnchor(),
    restore: (anchor) => {
      // Só reancora se o mesmo parágrafo ainda existe (evita puxar um documento novo).
      const control = document.getElementById("prompterText-control");
      const exists = !!anchor && !!anchor.text && getBlockElements(control).some(
        (b) => normalizeAnchorText(b.textContent) === anchor.text
      );
      return exists ? restoreCueAnchor(anchor) : false;
    },
  };


  // ============================================================
  // SEÇÃO 17: SINCRONIZAÇÃO DE SCROLL MANUAL
  // ============================================================
  // Quando o usuário rola manualmente, sincroniza com a TV

  if (prompterContainer) {
    window.addEventListener("resize", () => {
      if (typeof ScrollEngine !== "undefined") ScrollEngine.invalidateMetrics();
    });

    prompterContainer.addEventListener("scroll", () => {
      // Só executa se o Play estiver desligado (Scroll Manual)
      if (!ScrollEngine.isRunning) {
        // Aba Operator oculta (ex.: usuário foi para Home): o navegador zera o scrollTop
        // do container e dispara "scroll". Isso NÃO é rolagem do usuário e não pode
        // sobrescrever a posição de leitura nem mandar a TV para o início.
        if (prompterContainer.clientHeight === 0) return;
        cancelPendingFullscreenAnchorRestore();

        const el = prompterContainer;
        const textEl = document.getElementById('prompterText-control');

        // Porcentagem da altura do texto que já passou
        const textHeight = textEl ? textEl.offsetHeight : el.scrollHeight;
        const textPercentage = textHeight > 0 ? Math.min(1, Math.max(0, el.scrollTop / textHeight)) : 0;

        // Atualiza a posição interna do motor para quando der Play de novo não pular
        ScrollEngine.decimalScroll = el.scrollTop;

        const readProgress =
          typeof computeReadProgressPayload === "function" ? computeReadProgressPayload() : null;

        // Envia porcentagem para a TV + progresso de leitura para roteiristas
        ipcRenderer.send("sync-scroll-position", { textPercent: textPercentage, readProgress });

        // Atualiza marcação de texto lido no roteirista (tempo real)
        if (typeof updateReadProgress === "function") updateReadProgress(false, true);
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
      if (typeof syncContentToPrompter === "function") {
        syncContentToPrompter({ preserveVisibleAnchor: true });
      }
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
      if (typeof syncContentToPrompter === "function") {
        syncContentToPrompter({ preserveVisibleAnchor: true });
      }

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
        e.preventDefault();
        applyTextAlignment(command);
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
      if (typeof syncContentToPrompter === "function") {
        syncContentToPrompter({ preserveVisibleAnchor: true });
      }
    });
  }

  // ============================================================
  // SEÇÃO 23.0.5: LIMPAR ESCALETA (REMOVER MARCAÇÕES TÉCNICAS)
  // ============================================================
  // Remove marcações de LED, SOM, LUZ, ONLINE, horários, etc.
  // Mantém apenas as falas do MC
  // Versão 3.0: Preview em tempo real + padrões personalizados

  const cleanScriptBtn = document.getElementById("clean-script-btn");
  let currentEditorContent = null;
  let currentEditorTables = [];
  let cleanedPreviewContent = null;
  let originalContent = null; // Para desfazer
  let selectedTables = []; // Array de {tableIndex, columnIndex}

  if (cleanScriptBtn) {
    cleanScriptBtn.addEventListener("click", (e) => {
      e.preventDefault();

      const editor = document.querySelector(".text-editor-area");
      if (!editor) {
        alert("No document open!");
        return;
      }

      // Salva o conteúdo original para poder desfazer
      originalContent = editor.innerHTML;
      currentEditorContent = editor.innerHTML;

      // Reset de tabelas selecionadas
      selectedTables = [];
      renderSelectedTablesList();

      // Detecta tabelas no conteúdo
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = currentEditorContent;
      const tables = tempDiv.querySelectorAll("table");
      currentEditorTables = Array.from(tables);

      console.log(`📊 Detectadas ${currentEditorTables.length} tabelas no documento`);

      // Atualiza o modal com informações das tabelas
      const tableCountEl = document.getElementById("tableCount");
      const tableSelect = document.getElementById("tableSelect");
      const advancedPanel = document.getElementById("advancedCleanPanel");
      const applyBtn = document.getElementById("applyCleanScript");
      const cleanPreview = document.getElementById("cleanPreview");
      const simpleModeRadio = document.getElementById("cleanModeSimple");
      const advancedModeRadio = document.getElementById("cleanModeAdvanced");
      const advancedModeLabel = document.querySelector('label[for="cleanModeAdvanced"]');
      const cleanModeDescription = document.getElementById("cleanModeDescription");

      if (tableCountEl) tableCountEl.textContent = currentEditorTables.length;

      // Sempre reseta o estado de modo ao abrir o modal para evitar
      // ficar "preso" no disabled de uma execução anterior.
      if (simpleModeRadio) simpleModeRadio.checked = true;
      if (advancedPanel) advancedPanel.classList.add("d-none");
      if (cleanModeDescription) {
        cleanModeDescription.textContent = "Automatically removes all technical markers";
      }
      if (advancedModeRadio) {
        advancedModeRadio.disabled = false;
        advancedModeRadio.removeAttribute("title");
      }
      if (advancedModeLabel) {
        advancedModeLabel.classList.remove("disabled");
        advancedModeLabel.removeAttribute("title");
      }

      // Reset do preview e botão
      if (cleanPreview) {
        cleanPreview.innerHTML = `
          <div class="text-center text-muted py-5">
            <i class="bi bi-eye-slash" style="font-size: 3rem; opacity: 0.3;"></i>
            <p class="mt-3">Click \"Generate Preview\" to view the result</p>
          </div>
        `;
      }
      if (applyBtn) applyBtn.disabled = true;

      // Popula select de tabelas
      if (tableSelect) {
        tableSelect.innerHTML = "";
        currentEditorTables.forEach((table, idx) => {
          const option = document.createElement("option");
          option.value = idx;
          option.textContent = `Table ${idx + 1}`;
          tableSelect.appendChild(option);
        });
      }

      // Se tem tabelas, atualiza preview da primeira
      if (currentEditorTables.length > 0) {
        updateTablePreview(0);
      } else {
        // Sem tabelas - oculta opção avançada
        if (advancedModeRadio) {
          advancedModeRadio.disabled = true;
          advancedModeRadio.title = "No table detected in the document";
        }
        if (advancedModeLabel) {
          advancedModeLabel.classList.add("disabled");
          advancedModeLabel.title = "No table detected in the document";
        }
      }

      // Abre o modal
      const modal = new bootstrap.Modal(document.getElementById("cleanScriptModal"));
      modal.show();
    });
  }

  // Atualiza preview das colunas da tabela selecionada
  function updateTablePreview(tableIndex) {
    if (!currentEditorTables[tableIndex]) return;

    const table = currentEditorTables[tableIndex];
    const rows = table.querySelectorAll("tr");

    if (rows.length === 0) return;

    // Pega a primeira linha para contar colunas
    const firstRow = rows[0];
    const cells = firstRow.querySelectorAll("td, th");
    const numColumns = cells.length;

    console.log(`📊 Tabela ${tableIndex + 1}: ${rows.length} linhas, ${numColumns} colunas`);

    // Popula select de colunas
    const columnSelect = document.getElementById("columnSelect");
    if (columnSelect) {
      columnSelect.innerHTML = '<option value="">Auto-detect</option>';

      for (let i = 0; i < numColumns; i++) {
        const option = document.createElement("option");
        option.value = i;
        option.textContent = `Column ${i + 1}`;
        columnSelect.appendChild(option);
      }
    }

    // Cria preview das colunas com melhor visualização
    const preview = document.getElementById("columnPreview");
    if (preview) {
      let previewHTML = "";

      for (let colIdx = 0; colIdx < numColumns; colIdx++) {
        previewHTML += `<div class="mb-2"><strong class="text-primary">Col ${colIdx + 1}:</strong> `;

        // Pega conteúdo das primeiras 2 células desta coluna
        let samples = [];
        for (let rowIdx = 0; rowIdx < Math.min(2, rows.length); rowIdx++) {
          const row = rows[rowIdx];
          const cell = row.querySelectorAll("td, th")[colIdx];
          if (cell) {
            const text = (cell.textContent || "").trim().substring(0, 40);
            if (text) samples.push(text + (text.length >= 40 ? "..." : ""));
          }
        }

        if (samples.length > 0) {
          previewHTML += `<span class="text-muted">${samples.join(" • ")}</span>`;
        } else {
          previewHTML += "<em class='text-muted'>(empty)</em>";
        }

        previewHTML += "</div>";
      }

      preview.innerHTML = previewHTML;
    }
  }

  // Renderiza a lista de tabelas selecionadas
  function renderSelectedTablesList() {
    const listContainer = document.getElementById("selectedTablesList");
    const emptyMessage = document.getElementById("emptyTablesMessage");

    if (!listContainer) return;

    // Remove todos os items exceto a mensagem vazia
    while (listContainer.children.length > 1) {
      listContainer.removeChild(listContainer.lastChild);
    }

    if (selectedTables.length === 0) {
      if (emptyMessage) emptyMessage.classList.remove("d-none");
      return;
    }

    // Oculta mensagem vazia
    if (emptyMessage) emptyMessage.classList.add("d-none");

    // Adiciona cada tabela selecionada
    selectedTables.forEach((item, index) => {
      const div = document.createElement("div");
      div.className = "d-flex justify-content-between align-items-center p-2 mb-1 bg-white border rounded";

      const columnText = item.columnIndex !== "" ? `Col ${parseInt(item.columnIndex) + 1}` : "Auto";

      div.innerHTML = `
        <span class="small">
          <i class="bi bi-table text-primary"></i> 
          <strong>Table ${item.tableIndex + 1}</strong> - ${columnText}
        </span>
        <button type="button" class="btn btn-sm btn-outline-danger btn-sm" data-index="${index}">
          <i class="bi bi-trash"></i>
        </button>
      `;

      // Listener para remover
      const removeBtn = div.querySelector("button");
      removeBtn.addEventListener("click", () => {
        selectedTables.splice(index, 1);
        renderSelectedTablesList();
      });

      listContainer.appendChild(div);
    });
  }

  // Listener do botão adicionar tabela
  const addTableBtn = document.getElementById("addTableBtn");
  if (addTableBtn) {
    addTableBtn.addEventListener("click", () => {
      const tableIndex = parseInt(document.getElementById("tableSelect")?.value ?? 0);
      const columnIndex = document.getElementById("columnSelect")?.value ?? "";

      // Verifica se já foi adicionada
      const alreadyAdded = selectedTables.some(
        item => item.tableIndex === tableIndex && item.columnIndex === columnIndex
      );

      if (alreadyAdded) {
        alert("This table and column combination has already been added!");
        return;
      }

      // Adiciona à lista
      selectedTables.push({ tableIndex, columnIndex });
      renderSelectedTablesList();

      console.log("✅ Adicionada: Tabela", tableIndex + 1, "Coluna", columnIndex || "Auto");
    });
  }

  // Listener para mudança de modo
  document.querySelectorAll('input[name="cleanMode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const advancedPanel = document.getElementById("advancedCleanPanel");
      const description = document.getElementById("cleanModeDescription");

      if (e.target.value === "advanced") {
        advancedPanel?.classList.remove("d-none");
        if (description) description.textContent = "Select which table column contains MC speech lines";
      } else {
        advancedPanel?.classList.add("d-none");
        if (description) description.textContent = "Automatically removes all technical markers";
      }
    });
  });

  // Listener para mudança de tabela selecionada
  const tableSelect = document.getElementById("tableSelect");
  if (tableSelect) {
    tableSelect.addEventListener("change", (e) => {
      updateTablePreview(parseInt(e.target.value));
    });
  }

  // Listener do botão gerar preview
  const generatePreviewBtn = document.getElementById("generatePreview");
  if (generatePreviewBtn) {
    generatePreviewBtn.addEventListener("click", () => {
      const mode = document.querySelector('input[name="cleanMode"]:checked')?.value;
      const formatMCNames = document.getElementById("formatMCNames")?.checked ?? true;
      const removeEmptyLines = document.getElementById("removeEmptyLines")?.checked ?? true;
      const addLineBreaks = document.getElementById("addLineBreaks")?.checked ?? true;
      const removeTechnicalMarks = document.getElementById("removeTechnicalMarks")?.checked ?? true;
      const removeTimestamps = document.getElementById("removeTimestamps")?.checked ?? true;
      const mcPatterns = document.getElementById("mcPatterns")?.value || "MC, MC1, MC2, APRESENTADOR";

      let cleanedHTML = "";
      let stats = { original: 0, cleaned: 0, removed: 0 };

      if (mode === "advanced" && currentEditorTables.length > 0) {
        // Modo avançado: extrai colunas das tabelas selecionadas
        if (selectedTables.length === 0) {
          alert("Add at least one table before generating the preview!");
          return;
        }

        const result = cleanScriptAdvancedMultiple(
          selectedTables,
          formatMCNames,
          removeEmptyLines,
          addLineBreaks,
          removeTechnicalMarks,
          removeTimestamps,
          mcPatterns
        );
        cleanedHTML = result.html;
        stats = result.stats;
      } else {
        // Modo simples: limpeza automática
        const result = cleanScriptSimple(
          formatMCNames,
          removeEmptyLines,
          addLineBreaks,
          removeTechnicalMarks,
          removeTimestamps,
          mcPatterns
        );
        cleanedHTML = result.html;
        stats = result.stats;
      }

      // Atualiza o preview
      const cleanPreview = document.getElementById("cleanPreview");
      const previewStats = document.getElementById("previewStats");
      const applyBtn = document.getElementById("applyCleanScript");

      if (cleanPreview) {
        cleanPreview.innerHTML = cleanedHTML || '<p class="text-muted">No content generated</p>';
      }

      if (previewStats) {
        previewStats.innerHTML = `${stats.cleaned} lines | ${stats.removed} removed`;
        previewStats.className = "badge bg-success small";
      }

      if (applyBtn) {
        applyBtn.disabled = !cleanedHTML;
      }

      // Salva o conteúdo limpo para aplicar depois
      cleanedPreviewContent = cleanedHTML;

      console.log("✅ Preview gerado:", stats);
    });
  }

  // Listener do botão aplicar limpeza
  const applyCleanBtn = document.getElementById("applyCleanScript");
  if (applyCleanBtn) {
    applyCleanBtn.addEventListener("click", () => {
      if (!cleanedPreviewContent) {
        alert("Generate a preview first!");
        return;
      }

      // Aplica o conteúdo limpo ao editor
      const editor = document.querySelector(".text-editor-area");
      if (editor) {
        editor.innerHTML = cleanedPreviewContent;

        // Marca documento como não salvo e sincroniza
        if (typeof markDocumentAsUnsaved === "function") {
          const activeDoc = getActiveDocument();
          if (activeDoc) markDocumentAsUnsaved(activeDoc.id);
        }
        if (typeof syncContentToPrompter === "function") syncContentToPrompter();
      }

      // Fecha o modal
      const modal = bootstrap.Modal.getInstance(document.getElementById("cleanScriptModal"));
      modal?.hide();

      alert("Script cleaned and applied successfully!");
    });
  }

  // Função de limpeza simples (automática)
  function cleanScriptSimple(formatMCNames, removeEmptyLines, addLineBreaks, removeTechnicalMarks, removeTimestamps, mcPatternsStr) {
    console.log("🧹 Modo simples: limpeza automática");

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = currentEditorContent;

    // Substitui <br> por quebras de linha para preservar estrutura
    tempDiv.querySelectorAll('br').forEach(br => {
      br.replaceWith('\n');
    });

    // Substitui </p>, </div> por quebras de linha
    tempDiv.querySelectorAll('p, div').forEach(elem => {
      if (elem.textContent.trim()) {
        elem.after('\n');
      }
    });

    let textContent = tempDiv.textContent || tempDiv.innerText || "";

    // Separa o texto em linhas, preservando estrutura
    let lines = textContent.split("\n").map(l => l.trim());
    const originalCount = lines.length;

    // Filtra as linhas indesejadas
    lines = lines.filter((line) => {
      const trimmed = line.trim();

      if (trimmed === "") return true;

      // Preserva marcações de cena/direção
      if (/^[\[\<\«][\[\<\«].*[\]\>\»][\]\>\»]$/i.test(trimmed) || /^\[.*\]$/i.test(trimmed)) {
        return true;
      }

      // Remove timestamps se solicitado
      if (removeTimestamps) {
        // Formatos: 21:31, 21:398, HH:MM:SS, 14h00, etc
        if (/\d{1,2}[h:]\d{1,4}(?:[:\.]?\d{0,3})?(?:')?/i.test(trimmed)) {
          if (trimmed.length < 20) return false; // Só remove se a linha é curta (provável timestamp isolado)
        }
        // Remove horários de intervalo
        if (/\d{1,2}h\d{0,2}.*?(?:às|[-–—]|a)\s*\d{1,2}h\d{0,2}/i.test(trimmed)) {
          return false;
        }
      }

      // Remove marcações técnicas se solicitado
      if (removeTechnicalMarks) {
        const technicalMarkers = [
          /^\*{0,2}\s*LED\s*[:*]/i,
          /^\*{0,2}\s*SOM\s*[:*]/i,
          /^\*{0,2}\s*LUZ\s*[:*]/i,
          /^\*{0,2}\s*ONLINE\s*[:*]/i,
          /^\*{0,2}\s*C[ÂA]MERA\s*[:*]/i,
          /^\*{0,2}\s*VT\s*[:*]/i,
          /^\*{0,2}\s*V[ÍI]DEO\s*[:*]/i,
          /^\*{0,2}\s*PROJE[ÇC][ÃA]O\s*[:*]/i,
          /^\*{0,2}\s*CENOGRAFIA\s*[:*]/i,
          /^\*{0,2}\s*FIGURINO\s*[:*]/i,
          /^\*{0,2}\s*ADERE[ÇC]O\s*[:*]/i,
          /^\*{0,2}\s*A[ÇC][ÃA]O\s*[:*]/i,
          /^\*{0,2}\s*EFEITO\s*[:*]/i,
          /^\*{0,2}\s*TRANSI[ÇC][ÃA]O\s*[:*]/i,
          /^\*{0,2}\s*OBSERVA[ÇC][ÃA]O\s*[:*]/i,
          /^\*{0,2}\s*OBS\s*[:*]/i,
          /^\*{0,2}\s*NOTA\s*[:*]/i,
          /^\*{0,2}\s*AO\s+VIVO\s*[:*]/i,
          /^\*{0,2}\s*CATEGORIA\s*[:*]/i,
        ];

        for (const marker of technicalMarkers) {
          if (marker.test(trimmed)) return false;
        }
      }

      // Remove decorações
      if (/^[\*\-_=\s]+$/.test(trimmed)) return false;

      return true;
    });

    // Formata nomes de MCs
    if (formatMCNames) {
      lines = lines.map((line) => formatMCName(line, mcPatternsStr));
    }

    // Remove linhas vazias excessivas
    if (removeEmptyLines) {
      lines = removeExcessiveEmptyLines(lines);
    }

    // Adiciona espaçamento entre falas
    if (addLineBreaks) {
      lines = addSpacingBetweenSpeeches(lines);
    }

    const cleanedCount = lines.filter(l => l.trim() !== "").length;
    const removedCount = originalCount - cleanedCount;

    // Converte para HTML
    return {
      html: linesToHTML(lines),
      stats: { original: originalCount, cleaned: cleanedCount, removed: removedCount }
    };
  }

  // Função de limpeza avançada (com seleção de coluna)
  function cleanScriptAdvanced(tableIndex, columnIndex, formatMCNames, removeEmptyLines, addLineBreaks, removeTechnicalMarks, removeTimestamps, mcPatternsStr) {
    console.log(`🎯 Modo avançado: extraindo coluna ${columnIndex} da tabela ${tableIndex}`);

    const table = currentEditorTables[tableIndex];
    if (!table) return { html: "", stats: { original: 0, cleaned: 0, removed: 0 } };

    const rows = table.querySelectorAll("tr");
    let lines = [];

    // Se columnIndex é vazio, detecta automaticamente
    let targetColumn = columnIndex !== "" ? parseInt(columnIndex) : null;

    // Detecção automática: procura coluna com mais texto
    if (targetColumn === null && rows.length > 0) {
      const firstRow = rows[0];
      const cells = firstRow.querySelectorAll("td, th");
      let maxLength = 0;
      let maxIndex = 0;

      cells.forEach((cell, idx) => {
        const text = (cell.textContent || "").trim();
        if (text.length > maxLength) {
          maxLength = text.length;
          maxIndex = idx;
        }
      });

      targetColumn = maxIndex;
      console.log(`🔍 Coluna detectada automaticamente: ${targetColumn + 1}`);
    }

    const originalCount = rows.length;

    // Extrai o conteúdo da coluna selecionada
    rows.forEach((row) => {
      const cells = row.querySelectorAll("td, th");
      const cell = cells[targetColumn];

      if (cell) {
        // Clona o elemento para processar seu HTML
        const cellClone = cell.cloneNode(true);

        // Substitui <br> por quebras de linha
        cellClone.querySelectorAll('br').forEach(br => {
          br.replaceWith('\n');
        });

        // Substitui </p>, </div> por quebras de linha
        cellClone.querySelectorAll('p, div').forEach(elem => {
          elem.after('\n');
        });

        // Pega o texto já com as quebras preservadas
        let text = (cellClone.textContent || "").trim();

        if (text) {
          // Separa por quebras de linha
          const cellLines = text.split('\n');

          // Processa cada linha
          let lastWasEmpty = false;
          cellLines.forEach(line => {
            const trimmedLine = line.trim();

            if (trimmedLine) {
              lines.push(trimmedLine);
              lastWasEmpty = false;
            } else if (!lastWasEmpty) {
              // Adiciona linha vazia apenas se a anterior não era vazia
              lines.push("");
              lastWasEmpty = true;
            }
          });

          // Adiciona espaço extra entre células diferentes (separação de blocos)
          if (!lastWasEmpty) {
            lines.push("");
          }
        }
      }
    });

    // Filtra linhas indesejadas
    lines = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return true;

      // Preserva marcações de cena/direção
      if (/^[\[\<\«][\[\<\«].*[\]\>\»][\]\>\»]$/i.test(trimmed) || /^\[.*\]$/i.test(trimmed)) {
        return true;
      }

      if (removeTimestamps && /\d{1,2}[h:]\d{1,4}/i.test(trimmed) && trimmed.length < 20) {
        return false;
      }

      if (removeTechnicalMarks && /^(LED|SOM|LUZ|ONLINE|C[ÂA]MERA|VT|V[ÍI]DEO|AO\s+VIVO|CATEGORIA)[\s:*]/i.test(trimmed)) {
        return false;
      }

      return true;
    });

    // Formata nomes de MCs
    if (formatMCNames) {
      lines = lines.map((line) => formatMCName(line, mcPatternsStr));
    }

    // Remove linhas vazias excessivas
    if (removeEmptyLines) {
      lines = removeExcessiveEmptyLines(lines);
    }

    // Adiciona espaçamento entre falas
    if (addLineBreaks) {
      lines = addSpacingBetweenSpeeches(lines);
    }

    const cleanedCount = lines.filter(l => l.trim() !== "").length;
    const removedCount = originalCount - cleanedCount;

    console.log(`✅ Extraídas ${cleanedCount} linhas da coluna`);

    return {
      html: linesToHTML(lines),
      stats: { original: originalCount, cleaned: cleanedCount, removed: removedCount }
    };
  }

  // Função de limpeza avançada com múltiplas tabelas
  function cleanScriptAdvancedMultiple(selectedTables, formatMCNames, removeEmptyLines, addLineBreaks, removeTechnicalMarks, removeTimestamps, mcPatternsStr) {
    console.log(`🎯 Modo avançado múltiplo: processando ${selectedTables.length} tabela(s)`);

    let allLines = [];
    let totalOriginal = 0;

    // Processa cada tabela selecionada
    selectedTables.forEach((item, index) => {
      const table = currentEditorTables[item.tableIndex];
      if (!table) return;

      const rows = table.querySelectorAll("tr");
      totalOriginal += rows.length;

      // Se columnIndex é vazio, detecta automaticamente
      let targetColumn = item.columnIndex !== "" ? parseInt(item.columnIndex) : null;

      // Detecção automática: procura coluna com mais texto
      if (targetColumn === null && rows.length > 0) {
        const firstRow = rows[0];
        const cells = firstRow.querySelectorAll("td, th");
        let maxLength = 0;
        let maxIndex = 0;

        cells.forEach((cell, idx) => {
          const text = (cell.textContent || "").trim();
          if (text.length > maxLength) {
            maxLength = text.length;
            maxIndex = idx;
          }
        });

        targetColumn = maxIndex;
        console.log(`🔍 Tabela ${item.tableIndex + 1}: Coluna ${targetColumn + 1} detectada automaticamente`);
      }

      // Adiciona separador entre tabelas (exceto na primeira)
      if (index > 0 && allLines.length > 0) {
        allLines.push("", ""); // Espaço entre tabelas
      }

      // Extrai o conteúdo da coluna selecionada
      rows.forEach((row) => {
        const cells = row.querySelectorAll("td, th");
        const cell = cells[targetColumn];

        if (cell) {
          // Clona o elemento para processar seu HTML
          const cellClone = cell.cloneNode(true);

          // Substitui <br> por quebras de linha
          cellClone.querySelectorAll('br').forEach(br => {
            br.replaceWith('\n');
          });

          // Substitui </p>, </div> por quebras de linha
          cellClone.querySelectorAll('p, div').forEach(elem => {
            elem.after('\n');
          });

          // Pega o texto já com as quebras preservadas
          let text = (cellClone.textContent || "").trim();

          if (text) {
            // Separa por quebras de linha
            const cellLines = text.split('\n');

            // Processa cada linha
            let lastWasEmpty = false;
            cellLines.forEach(line => {
              const trimmedLine = line.trim();

              if (trimmedLine) {
                allLines.push(trimmedLine);
                lastWasEmpty = false;
              } else if (!lastWasEmpty) {
                // Adiciona linha vazia apenas se a anterior não era vazia
                allLines.push("");
                lastWasEmpty = true;
              }
            });

            // Adiciona espaço extra entre células diferentes (separação de blocos)
            if (!lastWasEmpty) {
              allLines.push("");
            }
          }
        }
      });

      console.log(`✅ Tabela ${item.tableIndex + 1}: ${rows.length} linhas processadas`);
    });

    // Filtra linhas indesejadas
    let lines = allLines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return true;

      // Preserva marcações de cena/direção
      if (/^[\[\<\«][\[\<\«].*[\]\>\»][\]\>\»]$/i.test(trimmed) || /^\[.*\]$/i.test(trimmed)) {
        return true;
      }

      if (removeTimestamps && /\d{1,2}[h:]\d{1,4}/i.test(trimmed) && trimmed.length < 20) {
        return false;
      }

      if (removeTechnicalMarks && /^(LED|SOM|LUZ|ONLINE|C[ÂA]MERA|VT|V[ÍI]DEO|AO\s+VIVO|CATEGORIA)[\s:*]/i.test(trimmed)) {
        return false;
      }

      return true;
    });

    // Formata nomes de MCs
    if (formatMCNames) {
      lines = lines.map((line) => formatMCName(line, mcPatternsStr));
    }

    // Remove linhas vazias excessivas
    if (removeEmptyLines) {
      lines = removeExcessiveEmptyLines(lines);
    }

    // Adiciona espaçamento entre falas
    if (addLineBreaks) {
      lines = addSpacingBetweenSpeeches(lines);
    }

    const cleanedCount = lines.filter(l => l.trim() !== "").length;
    const removedCount = totalOriginal - cleanedCount;

    console.log(`✅ Total: ${cleanedCount} linhas extraídas de ${selectedTables.length} tabela(s)`);

    return {
      html: linesToHTML(lines),
      stats: { original: totalOriginal, cleaned: cleanedCount, removed: removedCount }
    };
  }

  // Formata nomes de MCs com padrões personalizados
  function formatMCName(line, mcPatternsStr) {
    const trimmed = line.trim();

    // Detecta marcações de cena/direção entre << >> ou [ ]
    if (/^[\[\<\«][\[\<\«].*[\]\>\»][\]\>\»]$/i.test(trimmed) || /^\[.*\]$/i.test(trimmed)) {
      return `<div style="margin-top: 1.5em; margin-bottom: 1em; padding: 0.5em; background-color: #f0f0f0; border-left: 3px solid #999; font-style: italic; color: #666; font-size: 0.95rem;">${trimmed}</div>`;
    }

    // Pega os padrões definidos pelo usuário
    const customPatterns = mcPatternsStr.split(",").map(p => p.trim().toUpperCase()).filter(p => p);

    // Cria regex dinâmico baseado nos padrões
    const patternsList = customPatterns.map(p => p.replace(/\s+/g, "\\s*")).join("|");
    const mcRegex = new RegExp(`^(\\*{0,2}\\s*)(${patternsList})(\\s*\\d*)(\\/?(\\s*\\d+)?)?(\\*{0,2})(\\s*[:]*)?`, "i");

    if (mcRegex.test(trimmed)) {
      const match = trimmed.match(mcRegex);
      if (match) {
        const mcName = (match[2] + (match[3] || "") + (match[4] || "")).trim().toUpperCase();
        const restOfLine = trimmed.substring(match[0].length).trim();

        // Se a linha tem apenas o nome do MC, retorna formatado como título de bloco
        if (!restOfLine || restOfLine === ":") {
          return `<div style="margin-top: 2.5em; margin-bottom: 0.8em; padding: 0.5em 0; padding-bottom: 0.4em; border-bottom: 3px solid #0066cc; background: linear-gradient(to right, rgba(0,102,204,0.05), transparent);"><strong style="color: #0066cc; font-size: 1.4em; font-weight: 700; letter-spacing: 1px;">${mcName}</strong></div>`;
        }

        // Se tem texto depois do nome, formata junto
        return `<div style="margin-top: 2.5em; margin-bottom: 0.8em;"><strong style="color: #0066cc; font-size: 1.3em; font-weight: 700; letter-spacing: 0.5px;">${mcName}:</strong></div><div style="margin-bottom: 0.6em; line-height: 1.8; font-size: 1.05rem;">${restOfLine}</div>`;
      }
    }

    return line;
  }

  // Remove linhas vazias excessivas (máximo 1 em sequência)
  function removeExcessiveEmptyLines(lines) {
    let cleanedLines = [];
    let emptyCount = 0;

    for (const line of lines) {
      const isEmpty = line.trim() === "" || (typeof line === 'string' && /<div[^>]*>\s*<\/div>/.test(line));

      if (isEmpty) {
        emptyCount++;
        // Permite até 1 linha vazia consecutiva (para separar parágrafos)
        if (emptyCount <= 1) {
          cleanedLines.push(line);
        }
      } else {
        emptyCount = 0;
        cleanedLines.push(line);
      }
    }

    // Remove linhas vazias no início
    while (cleanedLines.length > 0 && cleanedLines[0].trim() === "") {
      cleanedLines.shift();
    }

    // Remove linhas vazias no fim
    while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() === "") {
      cleanedLines.pop();
    }

    return cleanedLines;
  }

  // Adiciona espaçamento entre falas diferentes
  function addSpacingBetweenSpeeches(lines) {
    const result = [];
    let lastWasMCName = false;
    let lastLineWasEmpty = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const isEmpty = trimmed === "";
      const isMCName = /<strong/.test(line) && (/<\/strong>/.test(line) || /border-bottom/.test(line));
      const isSceneMarker = /<div[^>]*background-color: #f0f0f0/.test(line);

      // Se esta linha é um nome de MC e a anterior também era, adiciona espaço extra
      if (isMCName && lastWasMCName && result.length > 0 && !lastLineWasEmpty) {
        result.push("");
      }

      // Se é marcação de cena e linha anterior não era vazia, adiciona espaço
      if (isSceneMarker && result.length > 0 && !lastLineWasEmpty) {
        result.push("");
      }

      result.push(line);
      lastWasMCName = isMCName;
      lastLineWasEmpty = isEmpty;
    }

    return result;
  }

  // Converte linhas para HTML com melhor formatação
  function linesToHTML(lines) {
    let html = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Linha vazia = separador de parágrafo
      if (trimmed === "") {
        html += '<div style="height: 1.2em;"></div>';
        continue;
      }

      // Se já tem tag div com strong (nome de MC formatado)
      if (/<div/.test(line) && /<strong/.test(line)) {
        html += line;
        continue;
      }

      // Se tem strong sozinho (nome de MC)
      if (/<strong/.test(line)) {
        html += line;
        continue;
      }

      // Linha de texto normal
      // Verifica se próxima linha é vazia ou tem MC (fim de bloco)
      const nextLine = lines[i + 1];
      const isEndOfBlock = !nextLine || !nextLine.trim() || /<strong/.test(nextLine);

      const marginBottom = isEndOfBlock ? "1.2em" : "0.4em";
      html += `<div style="margin-bottom: ${marginBottom}; line-height: 1.8; text-align: justify; font-size: 1.05rem;">${line}</div>`;
    }

    return html;
  }

  // ============================================================
  // SEÇÃO 23.1: INICIALIZAÇÃO DO HOTKEY HANDLER
  // ============================================================
  // Atalhos de teclado/mouse configuráveis em Preferences → Controls

  console.log('🎹 Verificando HotkeyHandler:', typeof HotkeyHandler, HotkeyHandler);

  // ------------------------------------------------------------
  // Helpers de navegação por asterisco "*" (bookmarks)
  // ------------------------------------------------------------
  // Varre os nós de texto do prompter e devolve a posição Y (em pixels
  // relativos ao topo do textEl) de CADA asterisco encontrado. As
  // posições já vêm em ordem crescente.
  function getAsteriskYPositions(textEl) {
    if (!textEl) return [];
    const out = [];
    const textRect = textEl.getBoundingClientRect();
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, null);
    const range = document.createRange();
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.nodeValue || '';
      let idx = txt.indexOf('*');
      while (idx !== -1) {
        try {
          range.setStart(node, idx);
          range.setEnd(node, idx + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width || rect.height) {
            out.push(rect.top - textRect.top);
          }
        } catch (_) { /* nó inválido — ignora */ }
        idx = txt.indexOf('*', idx + 1);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  // Aplica scroll para uma posição Y respeitando o modo (rodando ou parado).
  function applyScroll(container, textEl, target) {
    if (!container || !textEl) return;
    if (ScrollEngine.isRunning) {
      ScrollEngine.decimalScroll = target;
      textEl.style.transform = `translate3d(0, -${target}px, 0)`;
    } else {
      // Em modo parado: garante que não há transform residual e usa o scroll
      // nativo do container (que é o que o usuário vê de fato).
      textEl.style.transform = "none";
      container.scrollTop = target;
      ScrollEngine.decimalScroll = target;
    }
  }

  // Lê a posição vertical "real" da rolagem atual, cobrindo os 3 cenários:
  //   1) ScrollEngine rodando → usa decimalScroll (transform ativo)
  //   2) Texto parado, rolado por scroll nativo → usa container.scrollTop
  //   3) Texto parado mas com transform residual → usa decimalScroll
  function readCurrentScrollY(container, textEl) {
    if (!container) return 0;
    if (ScrollEngine.isRunning) return Number.isFinite(ScrollEngine.decimalScroll) ? ScrollEngine.decimalScroll : 0;

    const scrollTop = Number.isFinite(container.scrollTop) ? container.scrollTop : 0;
    const decimal = Number.isFinite(ScrollEngine.decimalScroll) ? ScrollEngine.decimalScroll : 0;

    // A posição atual não deve funcionar como "mínimo" para a navegação manual.
    // Evita forçar a leitura a nunca retroceder.
    if (Math.abs(decimal - scrollTop) > 2) {
      return scrollTop || decimal;
    }

    return scrollTop || decimal;
  }

  // Inicializa com as ações do prompter (se módulo carregou)
  if (typeof HotkeyHandler !== 'undefined' && HotkeyHandler) {
    console.log('🎹 Inicializando HotkeyHandler...');
    HotkeyHandler.init({
      actions: {
        stopExit: () => {
          // Sai do fullscreen ou para o scroll
          if (document.body.classList.contains("operator-fullscreen-mode")) {
            const run = (typeof runFullscreenChangePreservingAnchor === "function")
              ? runFullscreenChangePreservingAnchor
              : (fn) => fn();
            run(() => {
              document.body.classList.remove("operator-fullscreen-mode");
              ipcRenderer.send("control-window", "fullscreen");
            });
          }
          // Fora do fullscreen o Esc NÃO para/zera o prompter: o handler abaixo
          // pausa (se estiver rolando) e alterna o modo edição, mantendo a posição.
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
          const currentSpeed = ScrollEngine.speed || 0;
          ScrollEngine.setSpeed(-currentSpeed);
          if (ScrollEngine.speed !== 0 && !ScrollEngine.isRunning) {
            ScrollEngine.start();
          }
        },
        previousLine: () => {
          const container = document.querySelector(".prompter-in-control");
          const textEl = document.getElementById("prompterText-control");
          if (!container || !textEl) return;

          const lineHeight = parseInt(getComputedStyle(textEl).lineHeight) || 30;
          if (ScrollEngine.isRunning) {
            ScrollEngine.decimalScroll = Math.max(0, ScrollEngine.decimalScroll - lineHeight);
            textEl.style.transform = `translate3d(0, -${ScrollEngine.decimalScroll}px, 0)`;
          } else {
            // Garante estado scrollável (corrige overflow:hidden residual do modo GPU)
            if (container.style.overflowY === "hidden") {
              textEl.style.transform = "none";
              textEl.style.willChange = "auto";
              container.style.overflowY = "auto";
              container.scrollTop = ScrollEngine.decimalScroll || 0;
            }
            container.scrollTop = Math.max(0, container.scrollTop - lineHeight);
            ScrollEngine.decimalScroll = container.scrollTop;
          }
        },
        nextLine: () => {
          const container = document.querySelector(".prompter-in-control");
          const textEl = document.getElementById("prompterText-control");
          if (!container || !textEl) return;

          const lineHeight = parseInt(getComputedStyle(textEl).lineHeight) || 30;
          cancelPendingFullscreenAnchorRestore();
          const maxScroll = Math.max(
            0,
            textEl.offsetHeight - container.clientHeight + container.clientHeight / 2
          );
          if (ScrollEngine.isRunning) {
            ScrollEngine.decimalScroll = Math.min(maxScroll, ScrollEngine.decimalScroll + lineHeight);
            textEl.style.transform = `translate3d(0, -${ScrollEngine.decimalScroll}px, 0)`;
          } else {
            // Garante estado scrollável (corrige overflow:hidden residual do modo GPU)
            if (container.style.overflowY === "hidden") {
              textEl.style.transform = "none";
              textEl.style.willChange = "auto";
              container.style.overflowY = "auto";
              container.scrollTop = ScrollEngine.decimalScroll || 0;
            }
            container.scrollTop = Math.min(maxScroll, container.scrollTop + lineHeight);
            ScrollEngine.decimalScroll = container.scrollTop;
          }
        },
        previousCue: () => {
          // Salta para o ASTERISCO (*) anterior (bookmark). Loopa para o último
          // se já estiver no primeiro. Funciona parado ou rodando.
          const container = document.querySelector(".prompter-in-control");
          const textEl = document.getElementById("prompterText-control");
          if (!container || !textEl) return;

          const positions = getAsteriskYPositions(textEl);
          if (positions.length === 0) return;

          const maxScroll = Math.max(0, textEl.offsetHeight - container.clientHeight);
          // Centraliza o * no meio da tela (metade da altura visível).
          const half = Math.floor(container.clientHeight / 2);
          const targets = positions.map((y) => Math.min(maxScroll, Math.max(0, y - half)));
          const currentY = readCurrentScrollY(container, textEl);

          // Procura o último target ESTRITAMENTE menor que currentY.
          // Pequena tolerância (1px) absorve arredondamentos de subpixel.
          let target = [...targets].reverse().find((t) => t < currentY - 1);
          if (target === undefined) {
            // Loop: vai para o último cue do texto.
            target = targets[targets.length - 1];
          }
          applyScroll(container, textEl, target);
        },
        nextCue: () => {
          // Salta para o PRÓXIMO ASTERISCO (*) (bookmark). Loopa para o
          // primeiro se já estiver no último. Funciona parado ou rodando.
          const container = document.querySelector(".prompter-in-control");
          const textEl = document.getElementById("prompterText-control");
          if (!container || !textEl) return;

          const positions = getAsteriskYPositions(textEl);
          if (positions.length === 0) return;

          const maxScroll = Math.max(0, textEl.offsetHeight - container.clientHeight);
          // Centraliza o * no meio da tela (metade da altura visível).
          const half = Math.floor(container.clientHeight / 2);
          const targets = positions.map((y) => Math.min(maxScroll, Math.max(0, y - half)));
          const currentY = readCurrentScrollY(container, textEl);

          // Procura o primeiro target ESTRITAMENTE maior que currentY.
          let target = targets.find((t) => t > currentY + 1);
          if (target === undefined) {
            // Loop: vai para o primeiro cue do texto.
            target = targets[0];
          }
          applyScroll(container, textEl, target);
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
          const cueMarker = document.getElementById("cueMarker-control");
          if (!cueMarker) return;
          const hidden = cueMarker.style.display === "none";
          cueMarker.style.display = hidden ? "flex" : "none";
          if (globalPrefs) {
            globalPrefs.showCueMarker = hidden;
            ipcRenderer.send("save-settings", globalPrefs);
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
          // Ao entrar no Operator, força flush do conteúdo pendente do Editor
          // para evitar atraso perceptível após corrigir texto e trocar de aba.
          if (typeof flushSyncContentToPrompter === "function") {
            flushSyncContentToPrompter();
          }
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

    // Bloqueia Tab no prompter para evitar navegação indesejada e abertura de modais.
    // Dentro do painel de edição o Tab segue o comportamento normal.
    if (e.key === "Tab") {
      if (e.target && e.target.closest && e.target.closest("#operator-edit-panel")) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Esc: sai do fullscreen e abre o modo de edição na própria Operator;
    // fora do fullscreen alterna entre modo edição e modo operação.
    if (e.key === "Escape") {
      if (document.querySelector(".modal.show")) return;
      const quickMsg = document.getElementById("quick-message-modal");
      if (quickMsg && !quickMsg.classList.contains("d-none")) return;
      const inFullscreen = document.body.classList.contains("operator-fullscreen-mode");
      // Âncora capturada no início do Esc (antes de sair do fullscreen alterar o layout).
      const preAnchor =
        _escPreAnchor && Date.now() - _escPreAnchor.time < 600 ? _escPreAnchor.info : null;

      e.preventDefault();
      // Impede o HotkeyHandler de também chamar ScrollEngine.stop() (resetaria o scroll).
      e.stopImmediatePropagation();

      if (inFullscreen) {
        const run = (typeof runFullscreenChangePreservingAnchor === "function")
          ? runFullscreenChangePreservingAnchor
          : (fn) => fn();
        run(() => {
          document.body.classList.remove("operator-fullscreen-mode");
          ipcRenderer.send("control-window", "fullscreen");
        });
        ensureOperatorEditPanelVisible(preAnchor);
        getActiveTextEditorArea()?.focus({ preventScroll: true });
      } else if (operatorEditPanel && operatorEditPanel.classList.contains("collapsed")) {
        ensureOperatorEditPanelVisible(preAnchor);
        getActiveTextEditorArea()?.focus({ preventScroll: true });
      } else {
        setOperatorEditPanelCollapsed(true, { navigateToCaret: false });
        document.querySelector(".prompter-in-control")?.focus({ preventScroll: true });
      }
    }
  });

  // ============================================================
  // SEÇÃO 24: TRANSFORMAÇÃO DE CAIXA (UPPER/LOWER/TITLE)
  // ============================================================
  // Converte texto selecionado para maiúsculas, minúsculas ou título

  /**
   * Transforma texto nos nós do range, preservando HTML (cores, negrito, etc.).
   * Muito mais rápido que execCommand("insertText") em roteiros grandes.
   */
  function transformTextInRange(range, transformFn) {
    const editor = getActiveTextEditorArea();
    if (!editor || !range || range.collapsed) return false;

    const textNodes = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) textNodes.push(node);
    }
    if (textNodes.length === 0) return false;

    const caseTransform =
      typeof transformFn === "function"
        ? transformFn
        : (text) => text;

    beginBulkEdit();
    try {
      for (let i = textNodes.length - 1; i >= 0; i--) {
        const textNode = textNodes[i];
        const value = textNode.nodeValue;
        if (!value) continue;

        let start = 0;
        let end = value.length;
        if (textNode === range.startContainer) start = range.startOffset;
        if (textNode === range.endContainer) end = range.endOffset;
        if (start >= end) continue;

        const before = value.slice(0, start);
        const middle = value.slice(start, end);
        const after = value.slice(end);
        const transformed = caseTransform(middle);
        if (transformed === middle) continue;

        if (before || after) {
          const parent = textNode.parentNode;
          if (!parent) continue;
          const frag = document.createDocumentFragment();
          if (before) frag.appendChild(document.createTextNode(before));
          frag.appendChild(document.createTextNode(transformed));
          if (after) frag.appendChild(document.createTextNode(after));
          parent.replaceChild(frag, textNode);
        } else {
          textNode.nodeValue = transformed;
        }
      }
    } finally {
      endBulkEdit(() => {
        if (activeDocumentId) markDocumentAsUnsaved(activeDocumentId);
        syncContentToPrompter();
        scheduleAutoSave();
      });
    }

    return true;
  }

  /**
   * Altera a caixa do texto selecionado
   * @param {string} type - 'upper', 'lower' ou 'title'
   */
  function changeCase(type) {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    editor.focus();
    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    if (range.collapsed || selection.toString().length === 0) return;

    let transformFn;
    switch (type) {
      case "upper":
        transformFn = (text) => text.toUpperCase();
        break;
      case "lower":
        transformFn = (text) => text.toLowerCase();
        break;
      case "title":
        transformFn = (text) =>
          text.toLowerCase().replace(/(?:^|\s)\w/g, (match) => match.toUpperCase());
        break;
      default:
        return;
    }

    transformTextInRange(range, transformFn);
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

  // Agrupa chamadas repetidas (teclas, cliques, seleção) em uma por frame: queryCommandState
  // força recálculo de estilo/layout e era executado várias vezes seguidas.
  let _formatMenuStateRaf = 0;
  function updateFormatMenuState() {
    if (_formatMenuStateRaf) return;
    _formatMenuStateRaf = requestAnimationFrame(() => {
      _formatMenuStateRaf = 0;
      updateFormatMenuStateNow();
    });
  }

  function updateFormatMenuStateNow() {
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
    newTab.setAttribute("draggable", "true");
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
      healBlockWrappers(editor);
    } else {
      editor.innerHTML = "";
    }

    editor.style.outline = "none";
    editor.style.overflowY = "auto";
    editor.spellcheck = true;

    editor.addEventListener("paste", (e) => {
      // ===================================================================
      // PROTEÇÃO DE PASTE: Evitar reset de scroll durante playback
      // ===================================================================
      // Marca os elementos existentes antes do paste
      const existingElements = new Set(editor.querySelectorAll("*"));

      // Capturar estado de playback ANTES do paste
      const wasScrolling = typeof ScrollEngine !== "undefined" && ScrollEngine.isRunning;
      const scrollPosBefore = (typeof ScrollEngine !== "undefined") ? ScrollEngine.decimalScroll : 0;

      if (wasScrolling) {
        console.log(`📋 Paste detectado durante playback. Scroll protegido em: ${scrollPosBefore}px`);
      }

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

        // ===================================================================
        // Sincronizar com PROTEÇÃO especial para paste
        // ===================================================================
        if (typeof syncContentToPrompter === "function") {
          syncContentToPrompter();
        }
        if (typeof updateFormatMenuState === "function") {
          updateFormatMenuState();
        }

        // ===================================================================
        // Ativar proteção de scroll MAIS LONGA para paste (400ms vs 250ms)
        // Paste é uma mudança maior, precisa de mais tempo
        // ===================================================================
        if (wasScrolling && typeof ScrollEngine !== "undefined") {
          ScrollEngine.protectScrollDuringUpdate(400);
          console.log(`✅ Proteção de scroll PASTE ativada por 400ms`);

          // Verificação extra após o paste
          requestAnimationFrame(() => {
            const control = document.getElementById("prompterText-control");
            const container = document.querySelector(".prompter-in-control");
            if (control && container && ScrollEngine.isRunning) {
              const scrollDiff = Math.abs(ScrollEngine.decimalScroll - scrollPosBefore);
              if (scrollDiff > 15) {
                console.warn(`⚠️ Paste causou alteração de scroll (${scrollDiff}px). Restaurando...`);
                ScrollEngine.decimalScroll = scrollPosBefore;
                control.style.transform = `translate3d(0, -${scrollPosBefore}px, 0)`;
              } else {
                console.log(`✅ Scroll mantido após paste: ${ScrollEngine.decimalScroll}px`);
              }
            }
          });
        }
      }, 20);  // Aumentado de 10ms para 20ms (paste é mudança maior)
    });

    editor.addEventListener("input", () => {
      if (_bulkEditDepth > 0) return;
      markDocumentAsUnsaved(newId);
      scheduleSyncContentToPrompter();
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
    _lastLocalReadCount = -1;
    const doc = getActiveDocument();
    if (doc) {
      updateTitle();
      syncContentToPrompter();
      broadcastActiveDocumentImmediately();
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

  function reorderDocumentsToMatchTabOrder() {
    if (!documentTabsBar) return;

    const orderedIds = Array.from(
      documentTabsBar.querySelectorAll(".document-tab")
    )
      .map((tab) => parseInt(tab.dataset.target, 10))
      .filter((id) => Number.isFinite(id));

    if (orderedIds.length === 0 || orderedIds.length !== documents.length) return;

    const docsById = new Map(documents.map((doc) => [doc.id, doc]));
    const reordered = [];

    orderedIds.forEach((id) => {
      const doc = docsById.get(id);
      if (doc) reordered.push(doc);
    });

    if (reordered.length === documents.length) {
      documents = reordered;
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

  let draggingTabId = null;
  let tabOrderChangedByDrag = false;

  documentTabsBar?.querySelectorAll(".document-tab").forEach((tab) => {
    tab.setAttribute("draggable", "true");
  });

  documentTabsBar?.addEventListener("dragstart", (e) => {
    const tab = e.target.closest(".document-tab");
    if (!tab || e.target.closest(".close-tab")) {
      e.preventDefault();
      return;
    }

    draggingTabId = parseInt(tab.dataset.target, 10);
    if (!Number.isFinite(draggingTabId)) {
      draggingTabId = null;
      e.preventDefault();
      return;
    }

    tabOrderChangedByDrag = false;
    tab.classList.add("dragging-tab");

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(draggingTabId));
    }
  });

  documentTabsBar?.addEventListener("dragover", (e) => {
    if (draggingTabId === null) return;

    const targetTab = e.target.closest(".document-tab");
    const draggedTab = documentTabsBar.querySelector(
      `.document-tab[data-target="${draggingTabId}"]`
    );

    if (!targetTab || !draggedTab || targetTab === draggedTab) return;

    e.preventDefault();
    const targetRect = targetTab.getBoundingClientRect();
    const shouldInsertBefore =
      (e.clientX - targetRect.left) < (targetRect.width / 2);

    if (shouldInsertBefore) {
      if (draggedTab !== targetTab.previousSibling) {
        documentTabsBar.insertBefore(draggedTab, targetTab);
        tabOrderChangedByDrag = true;
      }
    } else {
      if (draggedTab !== targetTab.nextSibling) {
        documentTabsBar.insertBefore(draggedTab, targetTab.nextSibling);
        tabOrderChangedByDrag = true;
      }
    }
  });

  documentTabsBar?.addEventListener("drop", (e) => {
    if (draggingTabId === null) return;
    e.preventDefault();

    if (tabOrderChangedByDrag) {
      reorderDocumentsToMatchTabOrder();
    }
  });

  documentTabsBar?.addEventListener("dragend", () => {
    if (documentTabsBar) {
      documentTabsBar
        .querySelectorAll(".document-tab.dragging-tab")
        .forEach((tab) => tab.classList.remove("dragging-tab"));
    }

    if (tabOrderChangedByDrag) {
      reorderDocumentsToMatchTabOrder();
    }

    draggingTabId = null;
    tabOrderChangedByDrag = false;
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
      const ext = doc.path.split('.').pop().toLowerCase();
      const readOnlyFormats = ['docx', 'doc', 'pdf'];
      if (readOnlyFormats.includes(ext)) {
        // Formato importado: não pode ser sobrescrito — abre "Save As" direto
        ipcRenderer.send("save-file-dialog", content, doc.id, doc.name);
        return;
      }
      ipcRenderer.send("save-file-direct", content, doc.id, doc.path);
      doc.saved = true;
      updateTabTitle(doc.id, doc.name, true);
    } else {
      ipcRenderer.send("save-file-dialog", content, doc.id, doc.name);
    }
  }

  // Fallback: main process pediu "Save As" (ex.: arquivo bloqueado por EBUSY)
  ipcRenderer.on('prompt-save-as', (event, editorId) => {
    const targetDoc = documents.find(d => d.id === editorId) || getActiveDocument();
    const editor = getActiveTextEditorArea();
    if (targetDoc && editor) {
      const content = getCleanContent(editor);
      ipcRenderer.send("save-file-dialog", content, targetDoc.id, targetDoc.name);
    }
  });

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

  function commandToTextAlign(command) {
    const map = {
      justifyLeft: "left",
      justifyCenter: "center",
      justifyRight: "right",
      justifyFull: "justify",
    };
    return map[command] || "left";
  }

  function getEditorTextAlign(editor) {
    if (!editor) return "left";
    const inline = (editor.style.textAlign || "").trim();
    if (inline) return inline === "start" ? "left" : inline;

    const blocks = editor.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6");
    for (const block of blocks) {
      const blockAlign = (block.style.textAlign || "").trim();
      if (blockAlign) return blockAlign === "start" ? "left" : blockAlign;
    }

    const computed = window.getComputedStyle(editor).textAlign;
    if (computed === "start") return "left";
    return computed || "left";
  }

  function applyPrompterTextAlign(align) {
    const prompterText = document.getElementById("prompterText-control");
    const prompterContainer = document.querySelector(".prompter-in-control");
    if (!prompterText || !prompterContainer) return;

    const normalized =
      align === "start" ? "left" : align === "end" ? "right" : align || "left";

    prompterContainer.style.textAlign = normalized;
    prompterText.style.textAlign = normalized;
    prompterText.style.display = "block";
    prompterText.style.maxWidth = "100%";

    // O alinhamento pertence a cada bloco do roteiro. Mantém o contêiner
    // neutro para que um parágrafo não mova visualmente os demais.
    prompterContainer.style.alignItems = "flex-start";
    prompterText.style.margin = "0";
    prompterText.style.width = "97%";

  }

  function preserveOperatorReadPosition(applyChange, stabilizePasses = 0) {
    if (typeof applyChange !== "function") return;

    const control = document.getElementById("prompterText-control");
    const container = document.querySelector(".prompter-in-control");

    if (!control || !container) {
      applyChange();
      return;
    }

    // Modo edição aberto: o prompter está oculto; só marca para reancorar ao fechar.
    if (isEditPanelOpen()) {
      _promptDirty = true;
      applyChange();
      return;
    }

    // Aba Operator oculta: sem layout (alturas 0) qualquer "correção" zeraria a posição.
    // Só aplica a mudança; a posição salva é restaurada ao voltar ao Operator.
    if (container.clientHeight === 0) {
      applyChange();
      return;
    }

    const wasRunning = typeof ScrollEngine !== "undefined" && ScrollEngine.isRunning;
    const fallbackScroll =
      typeof ScrollEngine !== "undefined" && Number.isFinite(ScrollEngine.decimalScroll)
        ? ScrollEngine.decimalScroll
        : (container.scrollTop || 0);
    const cueAnchor = typeof captureCueAnchor === "function" ? captureCueAnchor() : null;

    applyChange();

    let restoredByAnchor = false;
    if (cueAnchor && typeof restoreCueAnchor === "function") {
      restoredByAnchor = restoreCueAnchor(cueAnchor);
      if (restoredByAnchor && stabilizePasses > 0 && typeof stabilizeCueAnchorAfterRemoteEdit === "function") {
        stabilizeCueAnchorAfterRemoteEdit(cueAnchor, stabilizePasses);
      }
    }

    if (!restoredByAnchor) {
      const containerHeight = container.clientHeight || 0;
      const contentHeight = control.offsetHeight || control.scrollHeight || 0;
      const maxScroll = Math.max(0, contentHeight - containerHeight + containerHeight / 2);
      const clampedScroll = Math.max(0, Math.min(fallbackScroll, maxScroll));

      if (typeof ScrollEngine !== "undefined") {
        ScrollEngine.decimalScroll = clampedScroll;
      }

      if (wasRunning) {
        control.style.willChange = "transform";
        control.style.transform = `translate3d(0, -${clampedScroll}px, 0)`;
      } else {
        control.style.transform = "none";
        container.style.overflowY = "auto";
        container.scrollTop = clampedScroll;
      }
    }

    const contentH = control.offsetHeight || control.scrollHeight || 1;
    const currentScroll =
      typeof ScrollEngine !== "undefined" && Number.isFinite(ScrollEngine.decimalScroll)
        ? ScrollEngine.decimalScroll
        : container.scrollTop || 0;
    const textPercent = Math.min(1, Math.max(0, currentScroll / contentH));
    ipcRenderer.send("sync-scroll-position", { textPercent });
  }

  function applyTextAlignment(command) {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    restoreSelection();
    editor.focus();

    document.execCommand(command, false, null);

    markDocumentAsUnsaved(activeDocumentId);
    syncContentToPrompter({ preserveVisibleAnchor: true });
    updateFormatMenuState();
  }

  function applyStyle(command, value = null) {
    if (["justifyLeft", "justifyCenter", "justifyRight", "justifyFull"].includes(command)) {
      applyTextAlignment(command);
      return;
    }
    restoreSelection();
    document.execCommand(command, false, value);
    const editor = getActiveTextEditorArea();
    if (editor) editor.focus();
    markDocumentAsUnsaved(activeDocumentId);
    syncContentToPrompter({ preserveVisibleAnchor: true });
    updateFormatMenuState();
  }

  // Espaçamento entre linhas é GLOBAL (editor + prompter + preferências). Antes ele
  // embrulhava o parágrafo atual num <div> com line-height inline, conflitando com o
  // valor do prompter/editor (só um bloco mudava e o inline vencia mudanças futuras).
  function applyLineSpacing(value) {
    const numVal = parseFloat(value);
    if (isNaN(numVal) || numVal <= 0) return;

    holdReadPosition();

    currentLineSpacing = numVal;
    if (globalPrefs) globalPrefs.lineSpacing = numVal;
    if (lineSpacingToolbar) {
      setSelectValueSafe(lineSpacingToolbar, numVal, `Line ${numVal}x`);
    }

    document.querySelectorAll(".text-editor-area").forEach((area) => {
      area.style.lineHeight = String(numVal);
      area.querySelectorAll('[style*="line-height"]').forEach((el) => {
        el.style.removeProperty("line-height");
        if (!el.getAttribute("style")) el.removeAttribute("style");
      });
    });

    const prompter = document.getElementById("prompterText-control");
    if (prompter) prompter.style.lineHeight = String(numVal);
    refreshEditPanelLookIfOpen();

    try {
      ipcRenderer.send("save-settings", { lineSpacing: numVal });
    } catch (_) { }

    if (activeDocumentId) markDocumentAsUnsaved(activeDocumentId);
    syncContentToPrompter({ preserveVisibleAnchor: true });
    if (typeof broadcastStylesUpdate === "function") broadcastStylesUpdate();
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
    editor.normalize();
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

  /** HTML idêntico ao do prompter (mesma estrutura de blocos para progresso de leitura). */
  function getRemoteSyncContent() {
    const editor = getActiveTextEditorArea();
    if (!editor) return "";
    const content = getCleanContent(editor);
    const html = typeof processPrompterHtml === "function" ? processPrompterHtml(content) : content;
    const computed = window.getComputedStyle(editor);
    const styleParts = [];

    if (computed.fontWeight && computed.fontWeight !== "400" && computed.fontWeight !== "normal") {
      styleParts.push(`font-weight:${computed.fontWeight}`);
    }
    if (computed.fontStyle && computed.fontStyle !== "normal") {
      styleParts.push(`font-style:${computed.fontStyle}`);
    }
    if (computed.textDecorationLine && computed.textDecorationLine !== "none") {
      styleParts.push(`text-decoration:${computed.textDecoration}`);
    }

    return styleParts.length
      ? `<div data-host-style="1" style="${styleParts.join(";")}">${html}</div>`
      : html;
  }

  function getCleanContent(editor) {
    if (!editor) return "";
    const clone = editor.cloneNode(true);
    const highlights = clone.querySelectorAll(".find-match");
    highlights.forEach((span) => {
      const parent = span.parentNode;
      parent.replaceChild(document.createTextNode(span.textContent), span);
    });
    clone.querySelectorAll("[data-para-idx]").forEach((el) => {
      el.removeAttribute("data-para-idx");
    });
    clone.querySelectorAll(".script-read").forEach((el) => {
      el.classList.remove("script-read");
    });
    clone.querySelectorAll("[data-read]").forEach((el) => {
      el.removeAttribute("data-read");
    });
    return clone.innerHTML;
  }

  function highlightMatches(term) {
    clearSearchHighlights();
    term = typeof term === "string" ? term.trim() : "";
    if (!term) {
      if (modalFindCountSpan) modalFindCountSpan.textContent = "0 de 0";
      return;
    }
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    // Opções de busca
    const caseSensitive = findCaseSensitive?.checked || false;
    const wholeWord = findWholeWord?.checked || false;

    const escapedTerm = term
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");

    // Monta regex baseado nas opções
    let regexPattern;
    if (wholeWord) {
      regexPattern = `(?<![\\p{L}0-9_])${escapedTerm}(?![\\p{L}0-9_])`;
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
    const editor = getActiveTextEditorArea();
    const hasCurrentMatches =
      searchState.matches.length > 0 &&
      searchState.matches.every((match) => editor && editor.contains(match));

    if (!hasCurrentMatches) {
      searchState.matches = [];
      searchState.currentMatchIndex = -1;
      if (modalFindInput?.value) highlightMatches(modalFindInput.value);
    }

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
      allowEditorFocusAfterOutsideClick = true;
      // Clicou fora do modal - minimiza
      minimizeFindModal();
      setTimeout(() => {
        allowEditorFocusAfterOutsideClick = false;
      }, 0);
    }
  });

  document.addEventListener("focusin", (e) => {
    if (!findReplaceModal.classList.contains("show")) return;
    if (findReplaceModal.contains(e.target)) return;
    if (allowEditorFocusAfterOutsideClick) return;

    e.stopPropagation();
    modalFindInput?.focus();
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
        // Aplica cor no CONTAINER DO PROMPTER
        prompterContainer.style.backgroundColor = bgColor;
        prompterContainer.style.color = defaultTextColor;

        const textControl = document.getElementById("prompterText-control");
        if (textControl) textControl.style.color = defaultTextColor;

        // Aplica cor também no container PAI (wrapper)
        const prompterWrapper = document.getElementById("operator-prompter-wrapper");
        if (prompterWrapper) {
          prompterWrapper.style.backgroundColor = bgColor;
        }

        // Aplica cor na barra de progresso
        const progressBar = document.getElementById("prompter-custom-scrollbar");
        const progressThumb = document.getElementById("prompter-scrollbar-thumb");
        if (progressBar) {
          progressBar.style.backgroundColor = bgColor;
        }
        if (progressThumb) {
          progressThumb.style.backgroundColor = defaultTextColor;
        }
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
      // 1. Inverte o estado da variável (True/False)
      operatorState.mirrorH = !operatorState.mirrorH;

      // 2. Muda a cor do botão para indicar que está ativo
      opBtnMirrorH.classList.toggle("active", operatorState.mirrorH);

      // 3. NÃO aplica localmente - apenas envia para a janela de projeção/broadcast
      ipcRenderer.send("save-settings", {
        flipHorizontal: operatorState.mirrorH
      });

      console.log("🗂️ Mirror Horizontal:", operatorState.mirrorH ? "ATIVADO" : "DESATIVADO");
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

  function applyPrompterMargins(marginVal, shouldPersist = true) {
    const numericMargin = Number.parseInt(marginVal, 10);
    if (!Number.isFinite(numericMargin)) return;

    const textControl = document.getElementById("prompterText-control");
    if (!textControl) return;

    preserveOperatorReadPosition(() => {
      const safeZoneArrow = 20;
      textControl.style.paddingLeft = `${numericMargin + safeZoneArrow}px`;
      textControl.style.paddingRight = `${numericMargin}px`;
    }, 1);

    if (prompterMarginSelect) {
      setSelectValueSafe(prompterMarginSelect, numericMargin, `Margin ${numericMargin}`);
    }

    const foundIndex = operatorState.margins.indexOf(numericMargin);
    operatorState.marginIndex = foundIndex >= 0 ? foundIndex : 0;

    if (globalPrefs) {
      globalPrefs.prompterMargin = numericMargin;
    }

    if (shouldPersist) {
      ipcRenderer.send("save-settings", {
        prompterMargin: numericMargin,
      });
    }

    if (operatorEditPanel && !operatorEditPanel.classList.contains("collapsed")) {
      applyPrompterLookToEditPanel();
    }

    console.log("Margem alterada para:", `${numericMargin}px`);
  }

  if (opBtnMargin) {
    opBtnMargin.addEventListener("click", () => {
      operatorState.marginIndex = (operatorState.marginIndex + 1) % operatorState.margins.length;
      const marginVal = operatorState.margins[operatorState.marginIndex];
      applyPrompterMargins(marginVal, true);
    });
  }

  if (prompterMarginSelect) {
    prompterMarginSelect.addEventListener("change", (event) => {
      applyPrompterMargins(event.target.value, true);
    });
  }

  if (lineSpacingToolbar) {
    lineSpacingToolbar.addEventListener("change", (event) => {
      const value = event.target.value;
      if (value) {
        applyLineSpacing(value);
      }
    });
  }

  window.addEventListener("operator-edit-panel:close", () => {
    setOperatorEditPanelCollapsed(true);
  });

  // Toda mudança vinda da barra de formatação / toolbar do Operator (fonte, tamanho,
  // cor, alinhamento, espaçamento, margem, inverter, espelhar...) mantém o ponto do texto.
  const HOLD_TOOLBAR_SELECTOR =
    "#toolbar-content, #op-btn-invert, #op-btn-margin, #op-btn-mirror-h, #op-btn-mirror-v";
  // "input" vem ANTES de "change" nos selects/inputs da barra e já aplica a mudança:
  // capturar só em "change" guardaria um ponto já deslocado.
  ["input", "change", "click", "keydown"].forEach((type) => {
    document.addEventListener(
      type,
      (e) => {
        if (e.target && e.target.closest && e.target.closest(HOLD_TOOLBAR_SELECTOR)) {
          holdReadPosition();
        }
      },
      true
    );
  });

  if (opBtnToggleEditPanel && operatorEditPanel) {
    setOperatorEditPanelCollapsed(operatorEditPanel.classList.contains("collapsed"));
    opBtnToggleEditPanel.addEventListener("click", () => {
      const collapsed = !operatorEditPanel.classList.contains("collapsed");
      setOperatorEditPanelCollapsed(collapsed);
      if (!collapsed) {
        // Foco depois do primeiro frame: o painel aparece antes do layout forçado pelo foco.
        requestAnimationFrame(() => getActiveTextEditorArea()?.focus({ preventScroll: true }));
      }

      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    });
  }

  // ============================================================
  // FULLSCREEN preservando o PONTO DE LEITURA (âncora de conteúdo)
  // ============================================================
  // Entrar/sair de fullscreen redimensiona a janela e re-quebra as linhas,
  // mudando a altura do conteúdo. Como a posição é em pixels, o mesmo pixel
  // passaria a apontar para outro trecho (salto). Aqui capturamos o parágrafo
  // sob a seta ANTES e o reposicionamos DEPOIS que o redimensionamento conclui.
  function runFullscreenChangePreservingAnchor(applyChange) {
    const anchor =
      typeof captureCueAnchor === "function" ? captureCueAnchor() : null;

    const runId = ++_fullscreenAnchorRunId;
    const container = document.querySelector(".prompter-in-control");
    const baselineScroll = ScrollEngine.isRunning
      ? (ScrollEngine.decimalScroll || 0)
      : (container ? (container.scrollTop || 0) : 0);

    applyChange();

    if (!anchor || typeof restoreCueAnchor !== "function") return;

    // O fullscreen do SO é assíncrono; reaplica em alguns instantes até a
    // janela estabilizar (cobre ~600ms da transição) sem congelar de vez.
    const checkpoints = [0, 120, 300, 550];
    checkpoints.forEach((ms) => {
      setTimeout(() => {
        if (runId !== _fullscreenAnchorRunId) return;

        const currentContainer = document.querySelector(".prompter-in-control");
        const currentScroll = ScrollEngine.isRunning
          ? (ScrollEngine.decimalScroll || 0)
          : (currentContainer ? (currentContainer.scrollTop || 0) : 0);

        // Se o usuário já moveu o texto significativamente após o toggle,
        // aborta este lote de restores para não "puxar" para ponto antigo.
        if (Math.abs(currentScroll - baselineScroll) > 24) {
          cancelPendingFullscreenAnchorRestore();
          return;
        }

        if (typeof ScrollEngine !== "undefined") ScrollEngine.invalidateMetrics();
        restoreCueAnchor(anchor);
      }, ms);
    });
  }

  if (opBtnFullscreen) {
    opBtnFullscreen.addEventListener("click", () => {
      // Sai do modo edição (se estiver nele) e vai para o prompter em tela cheia.
      const wasEditing = !!operatorEditPanel && !operatorEditPanel.classList.contains("collapsed");
      if (wasEditing) setOperatorEditPanelCollapsed(true);

      runFullscreenChangePreservingAnchor(() => {
        if (wasEditing) {
          document.body.classList.add("operator-fullscreen-mode");
        } else {
          document.body.classList.toggle("operator-fullscreen-mode");
        }
        ipcRenderer.send("control-window", "fullscreen");
      });
    });
  }

  // Qualquer interação manual após o toggle de fullscreen deve invalidar
  // restores antigos, para não puxar o texto de volta para um ponto stale.
  document.addEventListener("pointerdown", () => cancelPendingFullscreenAnchorRestore(), { passive: true });
  document.addEventListener("wheel", () => cancelPendingFullscreenAnchorRestore(), { passive: true });
  document.addEventListener("scroll", () => cancelPendingFullscreenAnchorRestore(), { passive: true });

  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      document.body.classList.contains("operator-fullscreen-mode")
    ) {
      runFullscreenChangePreservingAnchor(() => {
        document.body.classList.remove("operator-fullscreen-mode");
        ipcRenderer.send("control-window", "fullscreen");
      });
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
  // SEÇÃO 32.1: CLIQUE NO PROMPTER PARA PLAY/PAUSE
  // ============================================================
  // Permite clicar na área do prompter para alternar play/pause

  // Usa prompterContainer já declarado no início do arquivo
  if (prompterContainer) {
    prompterContainer.addEventListener("click", (e) => {
      // Ignora cliques em botões ou controles dentro do container
      if (e.target.closest("button") || e.target.closest("input") || e.target.closest("a")) {
        return;
      }

      // Toggle play/pause
      if (ScrollEngine.isRunning) {
        ScrollEngine.pause();
        ipcRenderer.send("control-prompter", "pause");
      } else {
        ScrollEngine.start();
        ipcRenderer.send("control-prompter", "play");
      }
    });
  }

  // ============================================================
  // SEÇÃO 33: SINCRONIZAÇÃO EDITOR → PROMPTER
  // ============================================================
  let _lastPrompterHtml = "";
  // Assinaturas (por nó de 1º nível) do último conteúdo aplicado ao prompter.
  let _promptSigs = null;

  function promptNodeSig(n) {
    return n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? "#t" + n.data : "#o" + n.nodeType;
  }

  /**
   * Atualiza #prompterText-control trocando apenas o trecho que mudou (prefixo/sufixo
   * iguais são mantidos, com seus estilos e marcações de leitura). Retorna os nós
   * novos, ou null quando o conteúdo foi trocado por inteiro.
   */
  function patchPrompterContent(control, html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const incoming = Array.from(tpl.content.childNodes);
    const sigs = incoming.map(promptNodeSig);
    const old = _promptSigs;
    _promptSigs = sigs;

    const oldLen = control.childNodes.length;
    let prefix = 0;
    let suffix = 0;
    if (old && old.length === oldLen && oldLen > 0) {
      const max = Math.min(oldLen, sigs.length);
      while (prefix < max && old[prefix] === sigs[prefix]) prefix++;
      while (suffix < max - prefix && old[oldLen - 1 - suffix] === sigs[sigs.length - 1 - suffix]) suffix++;
    }

    if (prefix + suffix === 0) {
      control.replaceChildren(...incoming);
      return null;
    }

    const oldNodes = Array.from(control.childNodes);
    const reference = oldLen - suffix < oldLen ? oldNodes[oldLen - suffix] : null;
    for (let i = prefix; i < oldLen - suffix; i++) control.removeChild(oldNodes[i]);

    const fresh = incoming.slice(prefix, sigs.length - suffix);
    fresh.forEach((node) => control.insertBefore(node, reference));
    return fresh;
  }
  let _syncPrompterTimer = null;
  let _remoteTextTimer = null;
  let _lastRemoteHtml = "";

  function scheduleSyncContentToPrompter() {
    clearTimeout(_syncPrompterTimer);
    if (ScrollEngine.isRunning) return;
    // Roteiros grandes: agrupa mais as teclas (cada sync reenvia o texto inteiro por IPC
    // para a projeção/remotos), sem atrasar perceptivelmente os roteiros normais.
    const delay = 80 + Math.min(320, Math.floor(_lastPrompterHtml.length / 2000));
    _syncPrompterTimer = setTimeout(syncContentToPrompter, delay);
  }

  function flushSyncContentToPrompter() {
    if (_syncPrompterTimer) {
      clearTimeout(_syncPrompterTimer);
      _syncPrompterTimer = null;
    }
    if (typeof syncContentToPrompter === "function") {
      syncContentToPrompter();
    }
  }

  function scheduleRemoteTextBroadcast(html) {
    if (!html || !shouldBroadcastToRemotes()) return;
    clearTimeout(_remoteTextTimer);
    _remoteTextTimer = setTimeout(() => {
      if (!shouldBroadcastToRemotes()) return;
      // Sempre o HTML "curado" (igual ao do prompter), nunca o innerHTML cru do editor.
      const content = getRemoteSyncContent();
      if (!content || content === _lastRemoteHtml) return;
      _lastRemoteHtml = content;
      ipcRenderer.send("send-text-to-remote", content);
      if (typeof broadcastTextUpdate === "function") broadcastTextUpdate(content);
    }, 200);
  }

  function broadcastActiveDocumentImmediately() {
    if (!shouldBroadcastToRemotes()) return;

    const content = getRemoteSyncContent();
    if (!content) return;

    clearTimeout(_remoteTextTimer);
    _remoteTextTimer = null;
    _lastRemoteHtml = content;
    ipcRenderer.send("send-text-to-remote", content);
    if (typeof broadcastTextUpdate === "function") {
      broadcastTextUpdate(content);
    }
  }

  function applyPrompterContainerStyles(control, editor, skipFontSize = false) {
    if (!control) return;

    const baseColor = operatorState.isInverted ? "#000000" : "#FFFFFF";
    control.style.color = baseColor;

    if (prompterContainer) {
      const bgColor = operatorState.isInverted ? "#FFFFFF" : "#000000";
      prompterContainer.style.backgroundColor = bgColor;
      const prompterWrapper = document.getElementById("operator-prompter-wrapper");
      if (prompterWrapper) prompterWrapper.style.backgroundColor = bgColor;
    }

    // ===================================================================
    // CORREÇÃO: Sincronização de CONTEÚDO nunca deve mexer no TAMANHO da
    // fonte. O font size é responsabilidade exclusiva de funções dedicadas
    // (applyExactFontSizeToOperator, handler de fonte remota via toolbar,
    // settings-updated-globally, etc). Antes, toda edição de texto (local
    // OU remota) reaplicava aqui o fontSize via getOperatorFontSizePt(),
    // o que podia resetar o tamanho ativo (ex.: 48pt -> 30pt) sempre que o
    // roteirista editava o texto. Mantemos apenas o lineHeight, que é
    // inofensivo e não sofre o mesmo problema.
    // skipFontSize é mantido só por compatibilidade de assinatura.
    if (typeof currentFontSizePT !== "undefined" && currentFontSizePT > 0) {
      control.style.lineHeight = currentLineSpacing || (globalPrefs && globalPrefs.lineSpacing) || 1.5;
    }

    applyPrompterTextAlign(getEditorTextAlign(editor));
  }

  function processPrompterHtml(content) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = content;
    healBlockWrappers(tempDiv);

    tempDiv.querySelectorAll("*").forEach((el) => {
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

    return tempDiv.innerHTML;
  }

  /**
   * Sincroniza conteúdo do editor com o prompter
   * Limpa formatação desnecessária e envia para main process
   * 
   * IMPORTANTE: Esta função agora preserva a posição de scroll
   * mesmo durante atualizações remotas enquanto o teleprompter está em playback!
   */
  function syncContentToPrompter(options = {}) {
    const editor = getActiveTextEditorArea();
    const control = document.getElementById("prompterText-control");
    const preserveAnchor =
      options.preserveScrollDuringRemoteEdit === true || options.preserveVisibleAnchor === true;
    const skipRemoteBroadcast =
      options.skipRemoteBroadcast === true || !shouldBroadcastToRemotes();

    if (!editor) {
      if (control && control.innerHTML !== "") {
        control.innerHTML = "";
        _promptSigs = null;
        _lastPrompterHtml = "";
        _lastRemoteHtml = "";
        ipcRenderer.send("update-prompter-content", "");
      }
      return;
    }

    const content = getCleanContent(editor);
    if (content === _lastPrompterHtml) {
      const isRemoteEdit = options.preserveScrollDuringRemoteEdit === true;
      const cueAnchor = preserveAnchor ? captureCueAnchor() : null;
      applyPrompterContainerStyles(control, editor, isRemoteEdit);
      applyPrompterFontScale(control, currentFontSizePT || globalPrefs?.defaultFontSize);
      if (cueAnchor && control && restoreCueAnchor(cueAnchor)) {
        const contentH = control.offsetHeight || control.scrollHeight || 1;
        const textPercent = Math.min(1, Math.max(0, (ScrollEngine.decimalScroll || 0) / contentH));
        ipcRenderer.send("sync-scroll-position", { textPercent });
      }
      return;
    }

    const finalContent = processPrompterHtml(content);
    if (finalContent === _lastPrompterHtml) {
      const isRemoteEdit = options.preserveScrollDuringRemoteEdit === true;
      const cueAnchor = preserveAnchor ? captureCueAnchor() : null;
      applyPrompterContainerStyles(control, editor, isRemoteEdit);
      applyPrompterFontScale(control, currentFontSizePT || globalPrefs?.defaultFontSize);
      if (cueAnchor && control && restoreCueAnchor(cueAnchor)) {
        const contentH = control.offsetHeight || control.scrollHeight || 1;
        const textPercent = Math.min(1, Math.max(0, (ScrollEngine.decimalScroll || 0) / contentH));
        ipcRenderer.send("sync-scroll-position", { textPercent });
      }
      return;
    }

    _lastPrompterHtml = finalContent;
    _lastRemoteHtml = finalContent;
    if (isEditPanelOpen()) _promptDirty = true;

    if (typeof ScrollEngine !== "undefined") ScrollEngine.invalidateMetrics();

    ipcRenderer.send("update-prompter-content", finalContent);
    if (!skipRemoteBroadcast) {
      ipcRenderer.send("send-text-to-remote", getRemoteSyncContent());
    }

    if (typeof currentFontSizePT !== "undefined" && currentFontSizePT > 0) {
      ipcRenderer.send("sync-projection-font-size", currentFontSizePT);
    }

    if (control) {
      const container = document.querySelector(".prompter-in-control");

      // ===================================================================
      // CORREÇÃO: Sempre usar ScrollEngine.decimalScroll como fonte da verdade
      // Não usar TabNavigationManager.operatorSavedScrollPosition durante playback
      // ===================================================================
      const wasRunning = ScrollEngine.isRunning;
      const savedScroll = ScrollEngine.decimalScroll || (container ? container.scrollTop : 0) || 0;

      // ===================================================================
      // ÂNCORA: durante edição remota, preserva o PARÁGRAFO sob a seta
      // (e não o pixel) para o texto não saltar quando inserem/removem
      // trecho acima do ponto de leitura. Capturada ANTES de trocar o HTML.
      // ===================================================================
      const cueAnchor = preserveAnchor ? captureCueAnchor() : null;

      // ===================================================================
      // Atualizar conteúdo no DOM — só os blocos que mudaram (sem refazer o texto
      // inteiro do prompter: evita reparse/layout de milhares de parágrafos por tecla).
      // ===================================================================
      const freshNodes = patchPrompterContent(control, finalContent);

      const styleBlock = (p) => {
        if (!p.style.marginBottom) p.style.marginBottom = "0.5em";
        p.style.marginTop = "0";
      };
      if (freshNodes) {
        freshNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches("p, div, h1, h2, h3")) styleBlock(n);
          n.querySelectorAll("p, div, h1, h2, h3").forEach(styleBlock);
        });
      } else {
        control.querySelectorAll("p, div, h1, h2, h3").forEach(styleBlock);
      }

      // ===================================================================
      // CORREÇÃO: skipFontSize=true durante edição remota
      // Preserva font size ao invés de sobrescrever com font do operador
      // ===================================================================
      const isRemoteEdit = options.preserveScrollDuringRemoteEdit === true;
      applyPrompterContainerStyles(control, editor, isRemoteEdit);
      applyPrompterFontScale(control, currentFontSizePT || globalPrefs?.defaultFontSize);

      ensureParaIndexing();
      ScrollEngine.invalidateMetrics();

      // ===================================================================
      // Restaurar posição de scroll imediatamente
      // ===================================================================
      const anchored = preserveAnchor && cueAnchor && restoreCueAnchor(cueAnchor);

      if (anchored) {
        // Posição já ajustada pela âncora de conteúdo (mantém o ponto de leitura).
        const fixedScroll = ScrollEngine.decimalScroll;
        if (wasRunning) {
          requestAnimationFrame(() => {
            ScrollEngine.decimalScroll = fixedScroll;
          });
        }

        // Corrige IMEDIATAMENTE a janela de projeção/saída (o que o repórter lê):
        // envia a posição já ancorada como proporção, evitando que a TV fique
        // no pixel antigo (que causa o salto) após a troca de conteúdo.
        const contentH = control.offsetHeight || control.scrollHeight || 1;
        const textPercent = Math.min(1, Math.max(0, fixedScroll / contentH));
        ipcRenderer.send("sync-scroll-position", { textPercent });

        // Faz 2 passes extras para absorver reflow tardio (ex.: espaço/paste)
        // e tornar a atualização visualmente imperceptível.
        const extraPasses = options.preserveScrollDuringRemoteEdit === true ? 2 : 1;
        stabilizeCueAnchorAfterRemoteEdit(cueAnchor, extraPasses);
      } else if (wasRunning) {
        const containerHeight = container ? container.clientHeight : 0;
        const contentHeight = control.offsetHeight;
        const maxScroll = Math.max(0, contentHeight - containerHeight + containerHeight / 2);
        const clampedScroll = Math.min(savedScroll, maxScroll);

        // Restaurar posição de scroll SEM DELAY
        ScrollEngine.decimalScroll = clampedScroll;
        control.style.willChange = "transform";
        control.style.transform = `translate3d(0, -${clampedScroll}px, 0)`;

        // Garantir que o scroll continue suave no próximo frame
        requestAnimationFrame(() => {
          ScrollEngine.decimalScroll = clampedScroll;
        });
      } else if (savedScroll > 0 && container && !isEditPanelOpen()) {
        container.style.overflowY = "auto";
        control.style.transform = "none";
        container.scrollTop = savedScroll;
        ScrollEngine.decimalScroll = savedScroll;
      }
    }

    if (voiceModeActive) prepararRoteiroParaLeitura();

    if (skipRemoteBroadcast && !options.skipReadProgressRebroadcast && !isEditPanelOpen()) {
      rebroadcastReadProgress();
    }
  }

  // ============================================================
  // SEÇÃO 33B: RASTREAMENTO DE TEXTO LIDO (ROTEIRISTA REMOTO)
  // ============================================================
  // Marca no roteirista remoto os parágrafos que já passaram
  // pelo scroll do prompter (cor mais clara, sem tachado).

  let _lastReadUpdateTime = 0;
  const READ_UPDATE_INTERVAL = 100;
  let _readProgressBaseline = -1;

  /**
   * Distância do topo do container até o centro do cue marker (px).
   * Usa style.top (px/%) para funcionar mesmo com aba Operator oculta.
   */
  function getCueOffsetInContainer() {
    const container = document.querySelector(".prompter-in-control");
    const marker = document.getElementById("cueMarker-control");
    if (!container) return window._cachedCueOffsetPx || 0;

    const containerH = container.clientHeight || 0;

    if (marker && marker.style.display !== "none") {
      const top = marker.style.top || "";
      if (top.endsWith("%")) {
        const pct = parseFloat(top);
        if (!isNaN(pct) && containerH > 0) {
          window._cachedCueOffsetPx = containerH * (pct / 100);
          return window._cachedCueOffsetPx;
        }
      }
      const topPx = parseFloat(top);
      if (!isNaN(topPx)) {
        window._cachedCueOffsetPx = topPx;
        return topPx;
      }
      if (containerH > 0) {
        const containerRect = container.getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();
        if (containerRect.height > 0) {
          window._cachedCueOffsetPx = Math.max(
            0,
            markerRect.top + markerRect.height / 2 - containerRect.top
          );
          return window._cachedCueOffsetPx;
        }
      }
    }

    if (containerH > 0) {
      window._cachedCueOffsetPx = containerH * 0.5;
      return window._cachedCueOffsetPx;
    }
    return window._cachedCueOffsetPx || 200;
  }

  function computeReadLinePx(textEl) {
    if (!textEl) return 0;
    const container = document.querySelector(".prompter-in-control");
    let scrollPos = Number.isFinite(ScrollEngine.decimalScroll) ? ScrollEngine.decimalScroll : 0;

    if (container) {
      const scrollTop = Number.isFinite(container.scrollTop) ? container.scrollTop : 0;
      const containerRect = container.getBoundingClientRect();
      const textRect = textEl.getBoundingClientRect();

      // Usa a posição real visível do container e só recorre ao decimal quando o
      // estado do DOM ficou desatualizado. Não impõe um piso mínimo; qualquer
      // posição válida pode ser menor que a atual.
      if (Math.abs(scrollPos - scrollTop) > 2) {
        scrollPos = scrollTop || scrollPos;
      } else {
        scrollPos = scrollTop;
      }

      if (containerRect.height > 0 && textRect.height > 0) {
        const visualScroll = Math.max(0, containerRect.top - textRect.top);
        if (Math.abs(visualScroll - scrollPos) > 2) {
          scrollPos = visualScroll;
        }
      }
    }

    return Math.max(0, scrollPos);
  }

  /**
   * Blocos cujo fundo já passou acima da seta verde (mesma regra visual do Operator).
   */
  function countBlocksPassedCue(blocks) {
    if (!blocks || blocks.length === 0) return { readCount: 0, maxReadIndex: -1 };

    const container = document.querySelector(".prompter-in-control");
    const containerRect = container ? container.getBoundingClientRect() : null;
    const cueY = getCueViewportY();

    if (containerRect && containerRect.height > 0 && cueY > 0) {
      let readCount = 0;
      let maxReadIndex = -1;
      blocks.forEach((block, i) => {
        const rect = block.getBoundingClientRect();
        const midpoint = rect.top + rect.height * 0.5;
        if (midpoint <= cueY + 2) {
          maxReadIndex = i;
          readCount = i + 1;
        }
      });
      return { readCount, maxReadIndex };
    }

    const readLinePx = computeReadLinePx(document.getElementById("prompterText-control"));
    let readCount = 0;
    let maxReadIndex = -1;
    let accumulated = 0;
    blocks.forEach((block, i) => {
      accumulated += block.offsetHeight;
      if (accumulated <= readLinePx + 1) {
        maxReadIndex = i;
        readCount = i + 1;
      }
    });
    return { readCount, maxReadIndex };
  }

  function getBlockBottomInContainer(block, container) {
    if (!block || !container) return 0;
    const containerRect = container.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    return blockRect.bottom - containerRect.top + container.scrollTop;
  }

  /**
   * Retorna a posição Y do cue marker no viewport.
   * Fallback: 50% da altura do container do prompter.
   */
  function getCueViewportY() {
    const container = document.querySelector(".prompter-in-control");
    const marker = document.getElementById("cueMarker-control");
    if (!container) return 0;

    if (marker && marker.style.display !== "none") {
      const r = marker.getBoundingClientRect();
      return r.top + r.height / 2;
    }
    const cr = container.getBoundingClientRect();
    return cr.top + container.clientHeight * 0.5;
  }

  // ============================================================
  // ÂNCORA DE LEITURA (preserva o ponto sob a seta em edições remotas)
  // ============================================================
  // Quando o roteirista edita o texto enquanto o operador está passando o
  // roteiro, a posição em pixels deixa de apontar para o mesmo trecho (texto
  // inserido/removido acima empurra o conteúdo). Estas funções "ancoram" no
  // parágrafo que está sob a seta verde para que ele permaneça no mesmo lugar.

  let _lastAnchorLogTime = 0;

  function normalizeAnchorText(t) {
    return (t || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  /**
   * Captura o parágrafo atualmente sob a seta (cue) no prompter e a fração
   * vertical dentro dele. Usa getBoundingClientRect (preciso, considera margens
   * e padding). Deve ser chamada ANTES de trocar o conteúdo.
   */
  function captureCueAnchor() {
    const control = document.getElementById("prompterText-control");
    const container = document.querySelector(".prompter-in-control");
    if (!control || !container) return null;
    // Com o modo edição aberto o prompter fica oculto (content-visibility): medir o
    // texto dele forçaria o layout completo a cada ação. A âncora é guardada na abertura
    // e reaplicada ao fechar (ver _openPromptAnchor / _promptDirty).
    if (isEditPanelOpen()) return null;
    // Operator oculto (outra aba): sem layout não há âncora confiável.
    if (container.clientHeight === 0) return null;

    const blocks = getBlockElements(control);
    if (!blocks.length) return null;

    const cueY = getCueViewportY();

    // Os blocos estão em ordem vertical: busca binária pelo primeiro cujo fim passa da seta
    // (evita medir milhares de parágrafos).
    const chosen = firstBlockBelow(blocks, cueY);

    const r = blocks[chosen].getBoundingClientRect();
    const h = r.height || 1;
    const fraction = Math.max(0, Math.min(1, (cueY - r.top) / h));

    return {
      idx: chosen,
      totalBlocks: blocks.length,
      fraction,
      text: normalizeAnchorText(blocks[chosen].textContent),
      prevText: chosen > 0 ? normalizeAnchorText(blocks[chosen - 1].textContent) : "",
      nextText: chosen < blocks.length - 1 ? normalizeAnchorText(blocks[chosen + 1].textContent) : "",
    };
  }

  /** Índice do primeiro bloco cujo fim (bottom) fica abaixo de y; o último se nenhum. */
  function firstBlockBelow(blocks, y) {
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (y < blocks[mid].getBoundingClientRect().bottom) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** Encontra, no novo conteúdo, o bloco que corresponde à âncora. */
  function findAnchorBlockIndex(blocks, anchor) {
    // 0) Atalho: o bloco no mesmo índice ainda tem o mesmo texto (caso comum).
    if (anchor.text && anchor.idx >= 0 && anchor.idx < blocks.length &&
        normalizeAnchorText(blocks[anchor.idx].textContent) === anchor.text) {
      return anchor.idx;
    }
    // 1) Texto exato do bloco-âncora (escolhe o índice mais próximo do antigo)
    if (anchor.text) {
      let best = -1;
      let bestDist = Infinity;
      blocks.forEach((b, i) => {
        if (normalizeAnchorText(b.textContent) === anchor.text) {
          const d = Math.abs(i - anchor.idx);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
      });
      if (best >= 0) return best;
    }
    // 2) Se a própria linha foi editada, ancora pelo bloco anterior + 1
    if (anchor.prevText) {
      let best = -1;
      let bestDist = Infinity;
      blocks.forEach((b, i) => {
        if (normalizeAnchorText(b.textContent) === anchor.prevText) {
          const d = Math.abs(i - (anchor.idx - 1));
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
      });
      if (best >= 0) return Math.min(best + 1, blocks.length - 1);
    }
    // 3) Se o bloco anterior também sumiu, tenta pelo bloco seguinte - 1
    if (anchor.nextText) {
      let best = -1;
      let bestDist = Infinity;
      blocks.forEach((b, i) => {
        if (normalizeAnchorText(b.textContent) === anchor.nextText) {
          const d = Math.abs(i - (anchor.idx + 1));
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
      });
      if (best >= 0) return Math.max(0, best - 1);
    }

    // 4) Fallback robusto: mantém a mesma PROPORÇÃO na linha do tempo.
    const oldTotal = Number.isFinite(anchor.totalBlocks) ? anchor.totalBlocks : 0;
    if (oldTotal > 1) {
      const ratio = Math.max(0, Math.min(1, anchor.idx / (oldTotal - 1)));
      const proportionalIdx = Math.round(ratio * (blocks.length - 1));
      return Math.max(0, Math.min(proportionalIdx, blocks.length - 1));
    }

    // 5) Último fallback: mesmo índice
    return Math.max(0, Math.min(anchor.idx, blocks.length - 1));
  }

  /**
   * Reposiciona a rolagem para que o parágrafo-âncora volte para EXATAMENTE sob
   * a seta verde no novo conteúdo. Usa a posição real (getBoundingClientRect) do
   * bloco e um deslocamento por delta até a seta — robusto a margens/padding e a
   * inserções/remoções acima. Deve ser chamada DEPOIS de trocar o conteúdo.
   */
  function restoreCueAnchor(anchor) {
    if (!anchor) return false;
    const control = document.getElementById("prompterText-control");
    const container = document.querySelector(".prompter-in-control");
    if (!control || !container) return false;
    // Sem layout (aba oculta) o cálculo daria delta 0 e zeraria a posição.
    if (container.clientHeight === 0) return false;

    const blocks = getBlockElements(control);
    if (!blocks.length) return false;

    const targetIdx = findAnchorBlockIndex(blocks, anchor);
    const cueY = getCueViewportY();

    // Posição atual (viewport) do ponto-âncora dentro do bloco correspondente.
    const r = blocks[targetIdx].getBoundingClientRect();
    const anchorViewportY = r.top + anchor.fraction * (r.height || 0);

    // Quanto precisamos rolar para levar esse ponto de volta à seta.
    const delta = anchorViewportY - cueY;

    const running = ScrollEngine.isRunning;
    const curScroll = running
      ? ScrollEngine.decimalScroll || 0
      : container.scrollTop || 0;

    const containerHeight = container.clientHeight || 0;
    const contentHeight = control.offsetHeight || control.scrollHeight || 0;
    const maxScroll = Math.max(0, contentHeight - containerHeight + containerHeight / 2);
    const newScroll = Math.max(0, Math.min(curScroll + delta, maxScroll));

    ScrollEngine.decimalScroll = newScroll;
    if (running) {
      control.style.willChange = "transform";
      control.style.transform = `translate3d(0, -${newScroll}px, 0)`;
    } else {
      control.style.transform = "none";
      container.style.overflowY = "auto";
      container.scrollTop = newScroll;
    }

    const now = Date.now();
    if (now - _lastAnchorLogTime > 1500) {
      _lastAnchorLogTime = now;
      console.log("[CueAnchor] mantido:", {
        idxAntigo: anchor.idx,
        idxNovo: targetIdx,
        totalBlocos: blocks.length,
        delta: Math.round(delta),
        novoScroll: Math.round(newScroll),
      });
    }
    return true;
  }

  function stabilizeCueAnchorAfterRemoteEdit(anchor, passes = 2) {
    if (!anchor || passes <= 0) return;

    let remaining = passes;
    const step = () => {
      const anchored = restoreCueAnchor(anchor);
      if (anchored) {
        const control = document.getElementById("prompterText-control");
        if (control) {
          const contentH = control.offsetHeight || control.scrollHeight || 1;
          const stableScroll = ScrollEngine.decimalScroll || 0;
          const textPercent = Math.min(1, Math.max(0, stableScroll / contentH));
          ipcRenderer.send("sync-scroll-position", { textPercent });
        }
      }

      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  }

  /**
   * Blocos de parágrafo de primeiro nível (evita contar divs aninhados em dobro).
   * Se um DIV contém parágrafos internos, usa os filhos internos.
   */
  function getBlockElements(container) {
    if (!container) return [];
    const blocks = [];
    const STRUCTURAL = /^(P|DIV|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE)$/i;

    Array.from(container.children).forEach((child) => {
      if (!child || child.nodeType !== 1) return;

      if (/^DIV$/i.test(child.tagName)) {
        const inner = Array.from(child.children).filter(
          (el) => el.nodeType === 1 && STRUCTURAL.test(el.tagName)
        );
        if (inner.length > 0) {
          inner.forEach((el) => blocks.push(el));
          return;
        }
      }

      if (hasBlockText(child)) blocks.push(child);
    });

    if (blocks.length > 0) return blocks;
    if (container.children.length > 0) return Array.from(container.children);
    return [container];
  }

  function hasBlockText(el) {
    if (!el || el.nodeType !== 1) return false;
    // Caminho rápido (maioria dos parágrafos): primeiro filho é texto com conteúdo,
    // sem montar a string textContent inteira de cada bloco.
    const first = el.firstChild;
    if (first && first.nodeType === 3 && first.data.trim()) return true;
    return !!(el.textContent || "").replace(/\u00a0/g, " ").trim() || el.querySelector("br,img,hr");
  }

  function clearParaIndexing(container) {
    if (!container) return;
    container.querySelectorAll("[data-para-idx]").forEach((el) => {
      el.removeAttribute("data-para-idx");
    });
  }

  /**
   * Indexa parágrafos no prompter e no editor (mesma ordem para o roteirista).
   */
  function ensureParaIndexing() {
    const textEl = document.getElementById("prompterText-control");
    const editor = getActiveTextEditorArea();

    [textEl, editor].forEach((container) => {
      if (!container) return;

      // Só escreve no DOM o que mudou (evita invalidar estilo de milhares de nós a cada tecla).
      const blocks = getBlockElements(container);
      const keep = new Set(blocks);
      container.querySelectorAll("[data-para-idx]").forEach((el) => {
        if (!keep.has(el)) el.removeAttribute("data-para-idx");
      });
      blocks.forEach((block, i) => {
        const value = String(i);
        if (block.getAttribute("data-para-idx") !== value) block.setAttribute("data-para-idx", value);
      });
    });
  }

  let _lastReadMaxIdx = -1;
  let _lastReadCount = 0;
  let _lastReadTotalBlocks = 0;
  let _lastReadPercent = -1;
  let _lastReadLinePx = 0;
  let _lastContentHeightPx = 0;

  function getReadProgressSnapshot() {
    if (
      _lastReadMaxIdx < 0 &&
      _lastReadCount <= 0 &&
      _lastReadPercent <= 0 &&
      _lastReadLinePx <= 0
    ) {
      return null;
    }
    return {
      maxReadIndex: _lastReadMaxIdx,
      readCount: _lastReadCount,
      totalBlocks: _lastReadTotalBlocks,
      readPercent: _lastReadPercent,
      scrollRatio: _lastReadPercent,
      readLinePx: _lastReadLinePx,
      contentHeightPx: _lastContentHeightPx,
    };
  }

  let _cachedContentHeightPx = 0;
  let _cachedTotalBlocks = 0;

  /**
   * Calcula payload de progresso de leitura a partir do scroll atual do Operator.
   */
  function computeReadProgressPayload() {
    const textEl = document.getElementById("prompterText-control");
    const container = document.querySelector(".prompter-in-control");
    if (!textEl) return null;

    // Se a aba Operator está oculta (display:none), os offsetHeight retornam 0.
    // Nesse caso NÃO recalcular — retorna null para manter o último estado válido.
    if (container && container.offsetHeight === 0) return null;

    const prompterBlocks = getBlockElements(textEl);
    if (prompterBlocks.length === 0) return null;

    const blockHeightSum = prompterBlocks.reduce((sum, block) => sum + block.offsetHeight, 0);
    const rawContentH = Math.max(textEl.scrollHeight || 0, blockHeightSum);
    if (rawContentH <= 10) return null;
    const contentHeightPx = rawContentH;
    _cachedContentHeightPx = rawContentH;

    const total = prompterBlocks.length;
    if (total > 0) _cachedTotalBlocks = total;

    const readLinePx = computeReadLinePx(textEl);

    let scrollPos = ScrollEngine.decimalScroll || 0;
    if (!ScrollEngine.isRunning && container) {
      scrollPos = container.scrollTop || scrollPos;
    }

    let readCount = 0;
    let maxReadIdx = -1;

    // Pixels de conteúdo ACIMA da seta = scrollPos + offset da seta no container.
    // É a medida mais precisa: independe da quantidade/tamanho dos blocos.
    const cueOffset = getCueOffsetInContainer();
    const readLinePxReal = scrollPos > 1 ? (scrollPos + cueOffset) : 0;

    if (readLinePxReal > 1) {
      let accumulated = 0;
      prompterBlocks.forEach((block, i) => {
        accumulated += block.offsetHeight;
        if (accumulated <= readLinePxReal + 1) {
          maxReadIdx = i;
          readCount = i + 1;
        }
      });
    }

    const scrollRatio = contentHeightPx > 0 && readLinePxReal > 0
      ? Math.min(1, readLinePxReal / contentHeightPx)
      : 0;

    return {
      maxReadIndex: maxReadIdx,
      readCount,
      totalBlocks: total,
      readPercent: scrollRatio,
      scrollRatio,
      readLinePx: readLinePxReal,
      contentHeightPx,
      scrollPos,
      isScrolling: ScrollEngine.isRunning || scrollPos > 1,
    };
  }

  /**
   * Calcula parágrafos já lidos (passaram pelo cue marker) e envia ao roteirista.
   * @param {boolean} fromEngine - chamado pelo loop do scroll (sem layout forçado)
   * @param {boolean} forceBroadcast - reenvia mesmo se valores não mudaram
   */
  function updateReadProgress(fromEngine, forceBroadcast) {
    if (!fromEngine && !forceBroadcast) {
      const now = performance.now();
      if (now - _lastReadUpdateTime < READ_UPDATE_INTERVAL) return;
      _lastReadUpdateTime = now;
    }

    const payload = computeReadProgressPayload();
    if (!payload) return;

    const changed =
      payload.maxReadIndex !== _lastReadMaxIdx ||
      payload.readCount !== _lastReadCount ||
      Math.abs(payload.readPercent - _lastReadPercent) > 0.001 ||
      Math.abs((_lastReadLinePx || 0) - payload.readLinePx) > 0.5 ||
      Math.abs((_lastContentHeightPx || 0) - payload.contentHeightPx) > 0.5;

    if (changed || forceBroadcast) {
      _lastReadMaxIdx = payload.maxReadIndex;
      _lastReadCount = payload.readCount;
      _lastReadTotalBlocks = payload.totalBlocks || 0;
      _lastReadPercent = payload.readPercent;
      _lastReadLinePx = payload.readLinePx;
      _lastContentHeightPx = payload.contentHeightPx;
      broadcastReadProgressUpdate(payload);
    }

    return payload;
  }

  /**
   * Aplica marcação visual .script-read nos blocos do editor local (aba Edit).
   * Usa o mesmo readCount já calculado pelo Operator — sem recalcular.
   * @param {number} readCount - quantidade de blocos já lidos (passaram pela seta)
   */
  let _lastLocalReadCount = -1;
  function applyReadProgressToLocalEditor(readCount) {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    if (readCount === _lastLocalReadCount) return;
    _lastLocalReadCount = readCount;

    const blocks = getBlockElements(editor);
    if (blocks.length === 0) return;

    const count = Math.min(readCount || 0, blocks.length);
    blocks.forEach((block, idx) => {
      const shouldBeRead = idx < count;
      const isRead = block.classList.contains("script-read");
      if (shouldBeRead && !isRead) {
        block.classList.add("script-read");
        block.setAttribute("data-read", "1");
      } else if (!shouldBeRead && isRead) {
        block.classList.remove("script-read");
        block.removeAttribute("data-read");
      }
    });
  }

  /**
   * Reseta o progresso de leitura (envia lista vazia para roteiristas).
   */
  function clearReadProgress() {
    _lastReadMaxIdx = -1;
    _lastReadCount = 0;
    _lastReadTotalBlocks = 0;
    _lastReadPercent = 0;
    _lastReadLinePx = 0;
    _lastContentHeightPx = 0;
    _lastLocalReadCount = -1;
    _readProgressBaseline = -1;
    broadcastReadProgressUpdate({
      maxReadIndex: -1,
      readCount: 0,
      totalBlocks: 0,
      readPercent: 0,
      scrollRatio: 0,
      readLinePx: 0,
      contentHeightPx: 0,
    });
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

    // Ações de formatação/estilo não podem mover o ponto do texto.
    if (/^(set-|align-)/.test(action)) holdReadPosition();

    switch (action) {
      case "new-script":
        createNewDocument();
        ensureOperatorEditPanelVisible();
        bootstrap.Tab.getOrCreateInstance(
          document.getElementById("operator-tab")
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
        applyOperatorFontFamily(value);
        // Sincroniza a barra visualmente
        updateFontUIState(value, document.getElementById('font-size-select')?.value);
        // Sincroniza o select da toolbar
        const fontSelectMenu = document.getElementById('font-family-select');
        if (fontSelectMenu) fontSelectMenu.value = value;
        // Envia para os roteiristas Wi-Fi local
        ipcRenderer.send('send-style-to-remote', {
          type: 'fontFamily',
          value: value,
          name: 'Host'
        });
        // Envia para os roteiristas via internet (WebRTC)
        if (typeof broadcastStylesUpdate === 'function') broadcastStylesUpdate();
        break;
      case "set-size": {
        // Usa a função parcial-aware: se houver seleção, aplica só nela.
        const sizeVal = parseInt(value);
        if (sizeVal > 0) {
          const partial = applyExactFontSizeToEditor(sizeVal);
          if (!partial) {
            applyExactFontSizeToOperator(sizeVal);
            updateFontUIState(null, sizeVal);
          }
        }
        break;
      }
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

      // === MENU EDIT (Undo / Redo / Cut / Copy / Paste / Delete / Select All) ===
      case "edit-undo":
        if (editor) editor.focus();
        document.execCommand("undo");
        break;
      case "edit-redo":
        if (editor) editor.focus();
        document.execCommand("redo");
        break;
      case "edit-cut":
        if (editor) editor.focus();
        document.execCommand("cut");
        break;
      case "edit-copy":
        if (editor) editor.focus();
        document.execCommand("copy");
        break;
      case "edit-paste":
        if (editor) editor.focus();
        // Tenta usar a Clipboard API (mais robusta no Electron moderno) e cai no execCommand
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then((text) => {
              document.execCommand("insertText", false, text);
            }).catch(() => document.execCommand("paste"));
          } else {
            document.execCommand("paste");
          }
        } catch (_) {
          document.execCommand("paste");
        }
        break;
      case "edit-delete":
        if (editor) editor.focus();
        document.execCommand("delete");
        break;
      case "edit-select-all":
        if (editor) editor.focus();
        document.execCommand("selectAll");
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
      ensureOperatorEditPanelVisible();
      bootstrap.Tab.getOrCreateInstance(
        document.getElementById("operator-tab")
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
      // Aplica a fonte em todo o roteiro (container-level) e fixa nas prefs
      applyOperatorFontFamily(val);

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
    // A aplicação da fonte (container-level) já é feita pelo listener acima
    // (toolbarFontSelect). Evita reintroduzir tags <font face> inline com execCommand.
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

    // Muda para a aba "Operator"
    const operatorTab = document.getElementById("operator-tab");
    if (operatorTab) {
      ensureOperatorEditPanelVisible();
      const tabInstance = bootstrap.Tab.getOrCreateInstance(operatorTab);
      tabInstance.show();
    }

    window.getSelection().removeAllRanges();

    // Aplica formatação padrão apenas para formatos que NÃO trazem
    // estilo próprio (txt, importações). Arquivos .ptq/.html já têm
    // spans com font-size inline e NÃO devem ser sobrescritos.
    const ext = doc.path ? doc.path.split('.').pop().toLowerCase() : '';
    const preserveFormatting = ['ptq', 'html', 'htm'].includes(ext);

    setTimeout(() => {
      const editor = getActiveTextEditorArea();
      if (editor) {
        editor.focus();

        if (!preserveFormatting) {
          document.execCommand("selectAll", false, null);
          applyDefaultFormatting(editor);
          document.getSelection().removeAllRanges();
        } else {
          // Apenas aplica o tamanho base no container (sem tocar nos spans internos)
          if (typeof currentFontSizePT !== 'undefined' && currentFontSizePT > 0) {
            editor.style.fontSize = `${currentFontSizePT}pt`;
          }
          if (globalPrefs && globalPrefs.defaultFont) {
            editor.style.fontFamily = globalPrefs.defaultFont;
          }
        }
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
  // HANDLER: Abrir arquivo .ptq via duplo clique ou linha de comando
  // ============================================================
  /**
   * Recebe um arquivo .ptq para abrir (vindo do sistema operacional)
   * - Duplo clique no arquivo no Explorer
   * - Arrastar arquivo para o ícone do app
   * - Linha de comando
   */
  ipcRenderer.on("open-file-from-system", (event, filePath) => {
    console.log("📂 [Sistema] Solicitação para abrir arquivo:", filePath);

    if (!filePath) {
      console.warn("⚠️ Caminho do arquivo vazio");
      return;
    }

    // Verifica se é um arquivo .ptq
    if (!filePath.toLowerCase().endsWith('.ptq')) {
      console.warn("⚠️ Arquivo não é .ptq:", filePath);
      return;
    }

    // Envia para o main process ler o conteúdo do arquivo
    ipcRenderer.send("read-and-open-file", filePath);
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

    // 3. Muda para a aba "Operator"
    const operatorTab = document.getElementById("operator-tab");
    if (operatorTab) {
      ensureOperatorEditPanelVisible();
      const tabInstance = bootstrap.Tab.getOrCreateInstance(operatorTab);
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
    // Nota: globalPrefs e applySettingsToVisuals já são tratados pelo
    // listener principal (Seção 11). Aqui só tratamos o que é exclusivo
    // desta seção: sincronizar o nome da fonte na toolbar e aplicar o
    // tamanho padrão somente em editores VAZIOS (novo documento).
    // NÃO chamamos updateFontUIState com o tamanho, pois isso sobrescreveria
    // currentFontSizePT e resetaria a fonte ativa do usuário para 12pt.

    // Sincroniza apenas o nome da fonte na toolbar (sem tocar no tamanho)
    if (settings.defaultFont) {
      updateFontUIState(settings.defaultFont, null);
    }

    // Aplica o tamanho padrão somente em editores que estão completamente vazios
    const editor = document.querySelector('.text-editor-area');
    if (editor && editor.innerText.trim() === "" && settings.defaultFont) {
      editor.style.fontFamily = settings.defaultFont;
      // Tamanho só se currentFontSizePT não foi definido pelo usuário ainda
      if (typeof currentFontSizePT === 'undefined' || currentFontSizePT <= 0) {
        editor.style.fontSize = `${settings.defaultFontSize}pt`;
      }
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
  let _progressBarUi = null;

  function updateProgressBar(ratio) {
    // 1. Verifica preferência
    if (!globalPrefs || !globalPrefs.showProgressIndicator) {
      if (_progressBarUi && _progressBarUi.container) {
        _progressBarUi.container.style.display = 'none';
      } else {
        const existing = document.getElementById('prompter-custom-scrollbar');
        if (existing) existing.style.display = 'none';
      }
      return;
    }

    const scrollableBox = document.querySelector('.prompter-in-control');
    if (!scrollableBox) return;

    const containerParent = scrollableBox.parentElement;
    if (!_progressBarUi || !_progressBarUi.container || !_progressBarUi.container.isConnected) {
      if (getComputedStyle(containerParent).position === 'static') {
        containerParent.style.position = 'relative';
      }

      let barContainer = document.getElementById('prompter-custom-scrollbar');
      let barThumb = document.getElementById('prompter-scrollbar-thumb');

      if (!barContainer) {
        barContainer = document.createElement('div');
        barContainer.id = 'prompter-custom-scrollbar';
        barContainer.style.position = 'absolute';
        barContainer.style.top = '0';
        barContainer.style.bottom = '0';
        barContainer.style.left = '0';
        barContainer.style.right = 'auto';
        barContainer.style.width = '10px';
        const isInverted = operatorState && operatorState.isInverted;
        barContainer.style.backgroundColor = isInverted ? '#FFFFFF' : '#000000';
        barContainer.style.zIndex = '9999';
        barContainer.style.pointerEvents = 'none';

        barThumb = document.createElement('div');
        barThumb.id = 'prompter-scrollbar-thumb';
        barThumb.style.position = 'absolute';
        barThumb.style.width = '100%';
        barThumb.style.height = '30px';
        const thumbColor = globalPrefs && globalPrefs.progressThumbColor
          ? globalPrefs.progressThumbColor
          : (isInverted ? '#000000' : '#FFFFFF');
        barThumb.style.backgroundColor = thumbColor;
        barThumb.style.top = '0px';
        barThumb.style.willChange = 'transform';
        barThumb.style.boxShadow = '2px 2px 5px rgba(0,0,0,0.5)';

        barContainer.appendChild(barThumb);
        containerParent.appendChild(barContainer);
      }

      _progressBarUi = {
        container: barContainer,
        thumb: barThumb,
        parent: containerParent,
      };
    }

    const { container, thumb, parent } = _progressBarUi;
    container.style.display = 'block';

    const trackHeight = parent.clientHeight;
    const thumbHeight = 40;
    const availableHeight = Math.max(0, trackHeight - thumbHeight);
    const safeRatio = Math.min(1, Math.max(0, ratio));
    const topPos = safeRatio * availableHeight;

    if (thumb) thumb.style.transform = `translate3d(0, ${topPos}px, 0)`;
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
  const btnRestoreLeft = document.getElementById("btn-restore-left");
  const btnRestoreRight = document.getElementById("btn-restore-right");
  const btnApplyChanges = document.getElementById("btn-apply-changes");
  const btnLeftLabel = document.getElementById("btn-left-label");
  const btnRightLabel = document.getElementById("btn-right-label");
  const btnApplyLabel = document.getElementById("btn-apply-label");

  // DEBUG: Verifica se elementos foram encontrados
  console.log('[Timeline] Elementos carregados:', {
    diffLeftPanel: !!diffLeftPanel,
    diffRightPanel: !!diffRightPanel,
    btnRestoreLeft: !!btnRestoreLeft,
    btnRestoreRight: !!btnRestoreRight,
    btnApplyChanges: !!btnApplyChanges
  });

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
  // Retorna {html, text} para preservar formatação
  function getTabContentFromDOM(id) {
    // 1. Tenta achar o container
    // Se seu app usa IDs como 'doc-1', 'document-content-1', ajuste aqui:
    let container = document.getElementById(`doc-${id}`);
    if (!container)
      container = document.getElementById(`document-content-${id}`);

    if (!container) return { html: "", text: "" };

    // 2. Tenta achar o editor dentro do container
    const editor = container.querySelector(
      '.text-editor-area, .editor-content, textarea, [contenteditable="true"]'
    );

    if (editor) {
      return {
        html: editor.innerHTML,  // Preserva formatação
        text: editor.innerText   // Para comparação diff
      };
    }
    return { html: "", text: "" };
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

  // --- DOCUMENTOS IMPORTADOS PARA COMPARAÇÃO ---
  let importedDiffDocuments = [];

  // --- BOTÃO IMPORTAR DOCUMENTO ---
  const btnImportDiffDoc = document.getElementById('btn-import-diff-doc');
  if (btnImportDiffDoc) {
    btnImportDiffDoc.addEventListener('click', async () => {
      try {
        // Chama o IPC para abrir diálogo e ler o arquivo
        const result = await ipcRenderer.invoke('import-diff-document');

        if (result.canceled) return;

        if (!result.success) {
          alert('Error importing document: ' + (result.error || 'Unknown error'));
          return;
        }

        // Adiciona o documento à lista de importados
        const importedDoc = {
          id: `imported-${Date.now()}`,
          displayName: result.fileName,
          subInfo: 'Imported Document',
          content: result.content,
          textContent: result.textContent,
          type: 'imported',
          timestamp: Date.now() - 50,
          filePath: result.filePath
        };

        importedDiffDocuments.push(importedDoc);

        // Re-renderiza a lista com o novo documento
        const doc = getActiveDocument();
        if (doc) {
          renderTimelineList(doc);
        }

        console.log('[Timeline] Documento importado:', result.fileName);

      } catch (err) {
        console.error('Erro ao importar documento:', err);
        alert('Error importing document: ' + err.message);
      }
    });
  }

  // --- FUNÇÃO PARA DESTACAR TEXTO EM ELEMENTO HTML ---
  // Encontra e marca texto com uma classe CSS, preservando estrutura HTML
  function highlightTextInElement(element, textToFind, className) {
    if (!textToFind || textToFind.trim().length < 2) return;

    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    // Escapa caracteres especiais para regex
    const escaped = textToFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');

    textNodes.forEach(textNode => {
      const text = textNode.textContent;
      if (regex.test(text)) {
        // Reset regex lastIndex
        regex.lastIndex = 0;

        const span = document.createElement('span');
        span.innerHTML = text.replace(regex, `<mark class="${className}">$1</mark>`);

        // Substitui o nó de texto pelo span com highlights
        if (textNode.parentNode) {
          textNode.parentNode.replaceChild(span, textNode);
        }
      }
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
    if (btnRestoreLeft) btnRestoreLeft.classList.add("d-none");
    if (btnRestoreRight) btnRestoreRight.classList.add("d-none");
    if (btnApplyChanges) btnApplyChanges.classList.add("d-none");
  }

  // --- RENDERIZAR LISTA LATERAL ---
  function renderTimelineList(activeDoc) {
    timelineList.innerHTML = "";

    // 1. O Documento Atual (Topo da lista)
    const editorArea = getActiveTextEditorArea(); // Sua função existente
    const currentHtml = editorArea ? editorArea.innerHTML : "";
    const currentText = editorArea ? editorArea.innerText : "";
    const currentName = activeDoc.name || activeDoc.filename || "Current File";

    const currentItem = {
      id: "current",
      displayName: currentName,
      subInfo: "Editing now (Active Tab)",
      content: currentHtml,     // HTML para restauração
      textContent: currentText, // Texto para comparação diff
      type: "current",
      timestamp: Date.now(), // Mais recente possível
    };

    // 2. Outros Documentos Abertos (Abas)
    const otherTabs = documents
      .filter((d) => d.id !== activeDoc.id)
      .map((d) => {
        const tabContent = getTabContentFromDOM(d.id);
        return {
          id: `tab-${d.id}`,
          displayName: d.name || d.filename || `Doc ${d.id}`,
          subInfo: "Other Open Tab",
          content: tabContent.html || d.content,   // HTML para restauração
          textContent: tabContent.text || d.content, // Texto para diff
          type: "tab",
          timestamp: Date.now() - 100, // Um pouco mais antigo que o atual
        };
      });

    // 3. Histórico (Versões Salvas)
    const history = (activeDoc.history || [])
      .slice()
      .reverse()
      .map((h) => ({
        id: `hist-${h.id}`, // Prefixo para ID único
        displayName: h.date, // Data/Hora como título
        subInfo: "Versão Salva",
        content: h.content,      // Isso já deveria ser HTML preservado
        textContent: h.content,  // Para diff (remove tags se necessário)
        type: "history",
        timestamp: h.id, // Assumindo que o ID do histórico é Date.now()
      }));

    // 4. Documentos Importados (PDF, DOC, DOCX)
    const imported = importedDiffDocuments.map(doc => ({
      ...doc,
      subInfo: `📄 ${doc.subInfo}`
    }));

    // Junta tudo
    const allItems = [currentItem, ...otherTabs, ...imported, ...history];

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
      else if (item.type === "imported")
        badgeHtml =
          '<span class="badge bg-warning text-dark rounded-pill ms-auto">Importado</span>';
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
        diffLeftPanel.innerText = items[0].textContent || items[0].content;
        diffTitleRight.innerText = "-";
        diffRightPanel.innerHTML =
          '<p class="text-muted text-center mt-5">Select one more item to compare</p>';
      } else {
        resetDiffView();
      }
      return;
    }

    // Caso 2: Dois itens selecionados -> COMPARAÇÃO
    // Ordena para que o "current" fique sempre na esquerda como ORIGINAL
    items.sort((a, b) => {
      if (a.type === "current") return -1;
      if (b.type === "current") return 1;
      return a.timestamp - b.timestamp;
    });

    const oldVer = items[0]; // REFERÊNCIA - documento da esquerda
    const newVer = items[1]; // COMPARADO - documento da direita

    // Atualiza Títulos
    diffTitleLeft.innerText = oldVer.displayName + " (Referência)";
    diffTitleRight.innerText = newVer.displayName + " (Diferenças)";
    diffStatusText.innerText = `Comparando: ${oldVer.displayName} -> ${newVer.displayName}`;

    // Roda a biblioteca Diff usando textContent (texto puro para comparação)
    const oldText = oldVer.textContent || oldVer.content;
    const newText = newVer.textContent || newVer.content;
    const diff = Diff.diffWords(oldText, newText);

    // Limpa Painéis
    diffLeftPanel.innerHTML = "";
    diffRightPanel.innerHTML = "";

    // Estatísticas
    let addedCount = 0;
    let removedCount = 0;

    // ========================================
    // PAINEL ESQUERDO: TEXTO REFERÊNCIA LIMPO
    // Mostra APENAS o texto original, sem NENHUMA marcação
    // ========================================
    const leftContainer = document.createElement('div');
    leftContainer.style.cssText = 'white-space: pre-wrap; padding: 12px; line-height: 1.6;';
    leftContainer.textContent = oldText;  // Texto puro, sem marcações
    diffLeftPanel.appendChild(leftContainer);

    // ========================================
    // PAINEL DIREITO: TEXTO COM DIFERENÇAS INLINE
    // - VERMELHO TACHADO = texto que foi REMOVIDO (estava em v1, não está em v2)
    // - VERDE = texto que foi ADICIONADO (não estava em v1, está em v2)
    // ========================================
    const rightContainer = document.createElement('div');
    rightContainer.style.cssText = 'white-space: pre-wrap; padding: 12px; line-height: 1.6;';

    diff.forEach((part) => {
      const span = document.createElement("span");

      if (part.removed) {
        // Texto que existia em v1 mas NÃO existe em v2 = REMOVIDO
        span.className = "diff-inline-removed";
        span.innerText = part.value;
        removedCount++;
      } else if (part.added) {
        // Texto que NÃO existia em v1 mas existe em v2 = ADICIONADO
        span.className = "diff-inline-added";
        span.innerText = part.value;
        addedCount++;
      } else {
        // Texto igual em ambos
        span.innerText = part.value;
      }

      rightContainer.appendChild(span);
    });

    diffRightPanel.appendChild(rightContainer);

    // ========================================
    // BOTÕES DE AÇÃO - COM NOMES DINÂMICOS
    // ========================================

    // Trunca nome para caber no botão
    const truncateName = (name, max = 15) =>
      name.length > max ? name.substring(0, max) + "..." : name;

    // Detecta qual documento é o "atual" (onde o usuário está editando)
    const currentDoc = getActiveDocument();
    const currentDocName = currentDoc?.name || currentDoc?.filename || "Current";

    // Identifica qual versão é a do documento ATUAL (formatado) vs documento EXTERNO (Word)
    const isOldVerCurrent = oldVer.type === "current";
    const isNewVerCurrent = newVer.type === "current";

    // Labels descritivos
    const oldLabel = truncateName(oldVer.displayName);
    const newLabel = truncateName(newVer.displayName);

    // ========================================
    // BOTÃO "APPLY CHANGES" - MERGE INTELIGENTE
    // ========================================
    // Transfere apenas as mudanças de TEXTO para o documento atual, preservando formatação
    console.log('[Timeline] btnApplyChanges encontrado:', !!btnApplyChanges);

    if (btnApplyChanges) {
      btnApplyChanges.classList.remove("d-none");
      console.log('[Timeline] Botão Apply Changes tornou visível');

      // Label dinâmico explicando a ação
      if (btnApplyLabel) {
        btnApplyLabel.innerText = "Apply Text Changes";
      }

      btnApplyChanges.onclick = () => {
        try {
          console.log('[Timeline] Botão Apply Changes clicado!');

          const editor = getActiveTextEditorArea();
          if (!editor) {
            alert("No active editor found.");
            return;
          }

          // ========================================
          // DETECTA QUAL É O DOCUMENTO COM FORMATAÇÃO
          // ========================================
          // O documento ATUAL (type="current") tem a formatação que queremos manter
          // O outro documento (type="tab") tem as mudanças de texto que queremos aplicar

          let formattedDoc, sourceDoc;

          if (isNewVerCurrent) {
            // 3 v2.ptq (direita/current) tem formatação, MC.docx (esquerda/tab) tem mudanças
            formattedDoc = newVer;
            sourceDoc = oldVer;
          } else if (isOldVerCurrent) {
            // oldVer (esquerda/current) tem formatação, newVer (direita/tab) tem mudanças
            formattedDoc = oldVer;
            sourceDoc = newVer;
          } else {
            // Nenhum é current - pergunta ao usuário
            const choice = confirm(
              `Which document has the FORMATTING ([MC] yellow, colors)?\n\n` +
              `[OK] = ${newVer.displayName} (right)\n` +
              `[Cancel] = ${oldVer.displayName} (left)`
            );
            formattedDoc = choice ? newVer : oldVer;
            sourceDoc = choice ? oldVer : newVer;
          }

          console.log('[Timeline] Documento formatado:', formattedDoc.displayName);
          console.log('[Timeline] Documento fonte:', sourceDoc.displayName);

          // Textos para comparação
          const formattedText = formattedDoc.textContent || formattedDoc.content;
          const sourceText = sourceDoc.textContent || sourceDoc.content;

          // Calcula o diff
          const changes = Diff.diffWords(formattedText, sourceText);

          // Separa adições e remoções
          const additions = changes.filter(p => p.added);
          const removals = changes.filter(p => p.removed);

          if (additions.length === 0 && removals.length === 0) {
            alert("The texts are identical. No changes to apply.");
            return;
          }

          // Mostra preview
          let preview = `Apply changes from "${sourceDoc.displayName}" to "${formattedDoc.displayName}"?\n\n`;

          if (additions.length > 0) {
            preview += `ADD (${additions.length} segments):\n`;
            additions.slice(0, 3).forEach(p => {
              preview += `  ✅ "${p.value.substring(0, 40)}${p.value.length > 40 ? '...' : ''}"\n`;
            });
          }

          if (removals.length > 0) {
            preview += `\nREMOVE (${removals.length} segments):\n`;
            removals.slice(0, 3).forEach(p => {
              preview += `  ❌ "${p.value.substring(0, 40)}${p.value.length > 40 ? '...' : ''}"\n`;
            });
          }

          preview += `\nYour formatting ([MC], colors) will be PRESERVED.`;

          if (!confirm(preview)) return;

          // ========================================
          // MERGE INTELIGENTE - NOVA ABORDAGEM
          // ========================================
          // Estratégia: reconstrói o texto final baseado no diff,
          // depois tenta aplicar a formatação do documento original

          let mergedHtml = formattedDoc.content;

          // 1. PROCESSA ADIÇÕES
          // Para cada adição, encontra onde inserir baseado no contexto
          changes.forEach((part, idx) => {
            if (part.added) {
              const textToAdd = part.value;

              // Encontra o contexto ANTES (última parte não-adicionada/removida)
              let contextBefore = "";
              for (let i = idx - 1; i >= 0; i--) {
                if (!changes[i].added && !changes[i].removed) {
                  contextBefore = changes[i].value;
                  break;
                }
              }

              // Encontra o contexto DEPOIS (próxima parte não-adicionada/removida)
              let contextAfter = "";
              for (let i = idx + 1; i < changes.length; i++) {
                if (!changes[i].added && !changes[i].removed) {
                  contextAfter = changes[i].value;
                  break;
                }
              }

              console.log('[Merge] Adicionando:', textToAdd.substring(0, 50));
              console.log('[Merge] Contexto antes:', contextBefore.substring(Math.max(0, contextBefore.length - 30)));
              console.log('[Merge] Contexto depois:', contextAfter.substring(0, 30));

              // Tenta encontrar o ponto de inserção
              if (contextBefore) {
                // Pega os últimos N caracteres do contexto para localização mais precisa
                const searchContext = contextBefore.slice(-30);

                // Encontra a posição no HTML (ignora tags)
                // Cria regex que ignora tags HTML entre os caracteres
                const flexibleSearch = searchContext
                  .split('')
                  .map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                  .join('(?:<[^>]*>)*\\s*');

                try {
                  const regex = new RegExp(flexibleSearch, 'i');
                  const match = regex.exec(mergedHtml);

                  if (match) {
                    let insertPos = match.index + match[0].length;

                    // CORREÇÃO: Avança até sair de qualquer tag span aberta
                    // Procura a próxima tag de fechamento </span> ou </div> ou quebra de linha
                    const afterMatch = mergedHtml.slice(insertPos);
                    const closeTagMatch = afterMatch.match(/^[^<]*(<\/span>|<\/div>|<br\s*\/?>|<\/p>)/i);

                    if (closeTagMatch) {
                      // Insere DEPOIS da tag de fechamento para não herdar estilo
                      insertPos += closeTagMatch.index + closeTagMatch[0].length;
                    }

                    // Insere o texto - agora fora de tags de formatação
                    mergedHtml = mergedHtml.slice(0, insertPos) + textToAdd + mergedHtml.slice(insertPos);
                    console.log('[Merge] Texto inserido na posição:', insertPos);
                  } else {
                    console.log('[Merge] Contexto não encontrado, tentando inserção simples');
                    // Fallback: insere após encontrar texto similar
                    const simpleSearch = contextBefore.slice(-15);
                    const simplePos = mergedHtml.indexOf(simpleSearch);
                    if (simplePos !== -1) {
                      const insertAt = simplePos + simpleSearch.length;
                      mergedHtml = mergedHtml.slice(0, insertAt) + textToAdd + mergedHtml.slice(insertAt);
                    }
                  }
                } catch (e) {
                  console.error('[Merge] Erro no regex:', e);
                }
              } else if (contextAfter) {
                // Não há contexto antes - insere no início antes do contexto depois
                const searchContext = contextAfter.substring(0, 30);
                const pos = mergedHtml.indexOf(searchContext);
                if (pos !== -1) {
                  mergedHtml = mergedHtml.slice(0, pos) + textToAdd + mergedHtml.slice(pos);
                }
              }
            }
          });

          // 2. PROCESSA REMOÇÕES (remove texto do HTML)
          removals.forEach(part => {
            const textToRemove = part.value;

            // Escapa caracteres especiais
            const escaped = textToRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Remove preservando tags ao redor
            // Regex que captura o texto mesmo com tags no meio
            const flexibleRemove = escaped
              .split(/\s+/)
              .filter(w => w.length > 0)
              .join('(?:<[^>]*>)*\\s*(?:<[^>]*>)*');

            try {
              const regex = new RegExp(flexibleRemove, 'gi');
              mergedHtml = mergedHtml.replace(regex, '');
            } catch (e) {
              // Fallback: remoção direta
              mergedHtml = mergedHtml.replace(textToRemove, '');
            }
          });

          // 3. Limpa espaços extras
          mergedHtml = mergedHtml
            .replace(/(<[^>]*>)\s+(<)/g, '$1$2')
            .replace(/\s{2,}/g, ' ')
            .replace(/>\s+</g, '><')
            .trim();

          // 4. Aplica ao editor
          editor.innerHTML = mergedHtml;
          editor.dispatchEvent(new Event('input', { bubbles: true }));

          console.log('[Timeline] Merge aplicado com sucesso');
          alert('Changes applied! Check the result.');
          timelineModal.hide();

        } catch (error) {
          console.error('[Timeline] Erro no Apply Changes:', error);
          alert('Error applying changes: ' + error.message);
        }
      };
    }

    // ========================================
    // BOTÕES "USE LEFT/RIGHT" - SUBSTITUIÇÃO COMPLETA
    // ========================================

    // Botão Usar Versão Esquerda (versão antiga) - substitui TUDO
    if (btnRestoreLeft) {
      btnRestoreLeft.classList.remove("d-none");
      if (btnLeftLabel) btnLeftLabel.innerText = `Use: ${oldLabel}`;

      btnRestoreLeft.onclick = () => {
        if (confirm(`Replace ALL content with document "${oldVer.displayName}"?\n\n⚠️ This will completely replace both text AND formatting.`)) {
          const editor = getActiveTextEditorArea();
          if (editor) {
            editor.innerHTML = oldVer.content;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            timelineModal.hide();
          }
        }
      };
    }

    // Botão Usar Versão Direita (versão nova/atual) - substitui TUDO
    if (btnRestoreRight) {
      btnRestoreRight.classList.remove("d-none");
      if (btnRightLabel) btnRightLabel.innerText = `Use: ${newLabel}`;

      btnRestoreRight.onclick = () => {
        if (confirm(`Replace ALL content with document "${newVer.displayName}"?\n\n⚠️ This will completely replace both text AND formatting.`)) {
          const editor = getActiveTextEditorArea();
          if (editor) {
            editor.innerHTML = newVer.content;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            timelineModal.hide();
          }
        }
      };
    }
  }

  // ============================================================
  // SEÇÃO 44: CONTROLE REMOTO (MODAL WI-FI / INTERNET)
  // ============================================================
  // Inicializa servidores remotos separados para Local e Internet

  const btnOpenRemoteModal = document.getElementById("btn-open-remote-modal");
  const statusIndicator = document.getElementById("status-indicator");
  const statusAlert = document.getElementById("server-status-alert");

  // Novos elementos - Modo Local
  const btnToggleLocal = document.getElementById("btn-toggle-local");
  const localStatusBadge = document.getElementById("local-status-badge");
  const localConnectionPanel = document.getElementById("local-connection-panel");
  const localUrlDisplay = document.getElementById("local-url-display");
  const btnCopyLocal = document.getElementById("btn-copy-local");

  // Novos elementos - Modo Internet
  const btnToggleInternet = document.getElementById("btn-toggle-internet");
  const internetStatusBadge = document.getElementById("internet-status-badge");
  const internetConnectionPanel = document.getElementById("internet-connection-panel");
  const internetUrlDisplay = document.getElementById("internet-url-display");
  const btnCopyInternet = document.getElementById("btn-copy-internet");

  // Estado dos servidores
  let isLocalServerActive = false;
  let isInternetServerActive = false;

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
  // SEÇÃO 45: TOGGLE DOS SERVIDORES REMOTOS (SEPARADOS)
  // ============================================================
  // Lógica para iniciar/parar servidor Wi-Fi e WebRTC separadamente

  // === FUNÇÕES DE ATUALIZAÇÃO DE UI ===
  function updateSidebarIcon() {
    if (sidebarIcon) {
      if (isLocalServerActive || isInternetServerActive) {
        sidebarIcon.classList.remove('broadcast-offline');
        sidebarIcon.classList.add('broadcast-live');
      } else {
        sidebarIcon.classList.remove('broadcast-live');
        sidebarIcon.classList.add('broadcast-offline');
      }
    }

    // Atualiza status alert geral
    if (statusAlert && statusIndicator) {
      if (isLocalServerActive || isInternetServerActive) {
        statusAlert.classList.remove("alert-secondary");
        statusAlert.classList.add("alert-success", "text-success");
        statusAlert.querySelector("span").innerHTML = "Status: <strong>CONNECTED</strong>";
        statusIndicator.classList.replace("text-danger", "text-success");
        statusIndicator.classList.add("blink-animation");
      } else {
        statusAlert.classList.remove("alert-success", "text-success");
        statusAlert.classList.add("alert-secondary");
        statusAlert.querySelector("span").innerHTML = "Status: <strong>OFF</strong>";
        statusIndicator.classList.replace("text-success", "text-danger");
        statusIndicator.classList.remove("blink-animation");
      }
    }
  }

  function updateLocalUI(active, url = "") {
    if (active) {
      if (localStatusBadge) {
        localStatusBadge.textContent = "ONLINE";
        localStatusBadge.classList.remove("bg-secondary");
        localStatusBadge.classList.add("bg-success");
      }
      if (btnToggleLocal) {
        btnToggleLocal.classList.remove("btn-outline-primary");
        btnToggleLocal.classList.add("btn-danger");
      }
      if (localConnectionPanel) localConnectionPanel.classList.remove("d-none");
      if (localUrlDisplay) localUrlDisplay.value = url;
    } else {
      if (localStatusBadge) {
        localStatusBadge.textContent = "OFF";
        localStatusBadge.classList.remove("bg-success");
        localStatusBadge.classList.add("bg-secondary");
      }
      if (btnToggleLocal) {
        btnToggleLocal.classList.remove("btn-danger");
        btnToggleLocal.classList.add("btn-outline-primary");
      }
      if (localConnectionPanel) localConnectionPanel.classList.add("d-none");
      if (localUrlDisplay) localUrlDisplay.value = "";
    }
  }

  function updateInternetUI(active, url = "") {
    if (active) {
      if (internetStatusBadge) {
        internetStatusBadge.textContent = "ONLINE";
        internetStatusBadge.classList.remove("bg-secondary");
        internetStatusBadge.classList.add("bg-success");
      }
      if (btnToggleInternet) {
        btnToggleInternet.classList.remove("btn-outline-primary");
        btnToggleInternet.classList.add("btn-danger");
      }
      if (internetConnectionPanel) internetConnectionPanel.classList.remove("d-none");
      if (internetUrlDisplay) internetUrlDisplay.value = url;
    } else {
      if (internetStatusBadge) {
        internetStatusBadge.textContent = "OFF";
        internetStatusBadge.classList.remove("bg-success");
        internetStatusBadge.classList.add("bg-secondary");
      }
      if (btnToggleInternet) {
        btnToggleInternet.classList.remove("btn-danger");
        btnToggleInternet.classList.add("btn-outline-primary");
      }
      if (internetConnectionPanel) internetConnectionPanel.classList.add("d-none");
      if (internetUrlDisplay) internetUrlDisplay.value = "";
    }
  }

  // === BOTÃO TOGGLE LOCAL (WI-FI) ===
  if (btnToggleLocal) {
    btnToggleLocal.addEventListener('click', async () => {
      btnToggleLocal.disabled = true;

      if (isLocalServerActive) {
        // Desligar servidor local
        try {
          await ipcRenderer.invoke('toggle-server', 'local');
          isLocalServerActive = false;
          updateLocalUI(false);
          updateSidebarIcon();
          addLogEntry({
            msg: 'Local server stopped',
            type: 'logout',
            source: 'Local Network',
            user: 'System'
          });
        } catch (err) {
          console.error("Erro ao parar servidor local:", err);
        }
      } else {
        // Ligar servidor local
        try {
          const result = await ipcRenderer.invoke('toggle-server', 'local');

          if (result && result.active) {
            isLocalServerActive = true;
            const textoParaMostrar = `${result.url} | ID: ${result.pin}`;
            updateLocalUI(true, textoParaMostrar);
            updateSidebarIcon();
            addLogEntry({
              msg: 'Local server started',
              type: 'login',
              source: 'Local Network',
              user: 'System'
            });
          }
        } catch (err) {
          let mensagemExibicao = err.message
            .replace("Error invoking remote method 'toggle-server':", "")
            .replace("Error:", "")
            .trim();

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-danger alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3 shadow-lg';
          alertDiv.style.zIndex = '10001';
          alertDiv.innerHTML = `
            <div class="d-flex align-items-center">
                <i class="bi bi-wifi-off fs-4 me-3"></i> 
                <div>${mensagemExibicao}</div>
                <button type="button" class="btn-close ms-auto" data-bs-dismiss="alert"></button>
            </div>
          `;
          document.body.appendChild(alertDiv);
          setTimeout(() => alertDiv.remove(), 5000);

          isLocalServerActive = false;
          updateLocalUI(false);
          updateSidebarIcon();
        }
      }

      btnToggleLocal.disabled = false;
    });
  }

  // === BOTÃO TOGGLE INTERNET (WEBRTC) ===
  if (btnToggleInternet) {
    btnToggleInternet.addEventListener('click', async () => {
      btnToggleInternet.disabled = true;

      if (isInternetServerActive) {
        // Desligar servidor internet
        addLogEntry({
          msg: 'You left the room.',
          type: 'logout',
          source: 'Internet',
          user: 'You'
        });

        ipcRenderer.send('user-disconnected-remote', {
          name: 'You',
          source: 'Internet'
        });

        stopWebRTCConnection();
        isInternetServerActive = false;
        updateInternetUI(false);
        updateSidebarIcon();
      } else {
        // Ligar servidor internet
        try {
          await startWebRTCConnection();
          // startWebRTCConnection já atualiza isInternetServerActive e a UI
        } catch (err) {
          console.error("Erro ao conectar WebRTC:", err);
          isInternetServerActive = false;
          updateInternetUI(false);
          updateSidebarIcon();
        }
      }

      btnToggleInternet.disabled = false;
    });
  }

  // === BOTÕES DE COPIAR ===
  if (btnCopyLocal) {
    btnCopyLocal.addEventListener("click", () => {
      if (localUrlDisplay) {
        localUrlDisplay.select();
        document.execCommand("copy");
        const icon = btnCopyLocal.querySelector("i");
        if (icon) {
          const oldClass = icon.className;
          icon.className = "bi bi-check-lg";
          setTimeout(() => icon.className = oldClass, 2000);
        }
      }
    });
  }

  if (btnCopyInternet) {
    btnCopyInternet.addEventListener("click", () => {
      if (internetUrlDisplay) {
        internetUrlDisplay.select();
        document.execCommand("copy");
        const icon = btnCopyInternet.querySelector("i");
        if (icon) {
          const oldClass = icon.className;
          icon.className = "bi bi-check-lg";
          setTimeout(() => icon.className = oldClass, 2000);
        }
      }
    });
  }

  // === FUNÇÃO AUXILIAR PARA PARAR WEBRTC E LIMPAR TUDO ===
  function stopWebRTCConnection() {
    if (signalingSocket) {
      signalingSocket.emit('user-leaving', myRoomId);
      signalingSocket.disconnect();
      signalingSocket = null;
    }

    // Fecha todas as conexões abertas
    Object.keys(peers).forEach(id => {
      if (peers[id]) peers[id].close();
    });

    peers = {};
    myRoomId = null;
    isInternetServerActive = false;

    console.log("Servidor de Internet Parado.");
  }

  // ============================================================
  // SEÇÃO 46: RECEBIMENTO DE TEXTO REMOTO
  // ============================================================
  // Atualiza editor quando recebe texto de dispositivo remoto

  ipcRenderer.on("update-text-from-remote", (event, newText) => {
    const editor = getActiveTextEditorArea();
    if (!editor || typeof newText !== "string") return;
    if (applyRemoteEditorUpdate(newText)) {
      afterRemoteEditorApplied(editor);
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
  // MONITORAR DIGITAÇÃO LOCAL (PC -> SITE) — debounced para não travar o Operator
  document.addEventListener("input", (e) => {
    if (_bulkEditDepth > 0) return;
    const editor = getActiveTextEditorArea();
    if (!editor || !editor.contains(e.target)) return;
    if (e.target.getAttribute("contenteditable") !== "true") return;

    scheduleRemoteTextBroadcast(editor.innerHTML);
  });

  // 2. SERVIDOR PEDE O TEXTO (Quando o roteirista conecta)
  // Agora envia Full-Sync para sincronização pixel-perfect
  ipcRenderer.on("request-text-for-remote", () => {
    const text = getRemoteSyncContent();
    ipcRenderer.send("send-text-to-remote", text);

    if (typeof updateReadProgress === "function") {
      updateReadProgress(true, true);
    } else {
      const readSnapshot = getReadProgressSnapshot();
      if (readSnapshot) broadcastReadProgressUpdate(readSnapshot);
    }

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
    const computedStyle = window.getComputedStyle(editor);

    const prompterEl = document.getElementById("prompterText-control");
    const resolvedFont =
      editor.style.fontFamily ||
      (prompterEl && prompterEl.style.fontFamily) ||
      (typeof globalPrefs !== "undefined" && globalPrefs && globalPrefs.defaultFont) ||
      "Arial";

    // Coleta o estado atual do editor
    const fullState = {
      htmlContent: getRemoteSyncContent(),
      fontSize: parseInt(editor.style.fontSize) || currentFontSizePT || 24,
      fontFamily: resolvedFont,
      textAlign: editor.style.textAlign || "left",
      fontWeight: computedStyle.fontWeight || editor.style.fontWeight || "normal",
      fontStyle: computedStyle.fontStyle || editor.style.fontStyle || "normal",
      textDecoration: computedStyle.textDecoration || editor.style.textDecoration || "none",
      readProgress:
        typeof computeReadProgressPayload === "function"
          ? computeReadProgressPayload()
          : getReadProgressSnapshot(),
    };

    console.log('📤 Enviando estado completo para remoto:', fullState.fontSize + 'pt');
    ipcRenderer.send("send-full-state-to-remote", fullState);
  });

  // ✅ SOLUÇÃO 1: Quando recebe atualização do roteirista (Local Wi-Fi)
  ipcRenderer.on("update-from-remote", (event, newText) => {
    const editor = getActiveTextEditorArea();
    if (!editor) return;

    clearTimeout(_remoteUpdateTimer);
    // Aumentado de 80ms para 120ms para sincronização melhor do scroll
    // Especialmente importante durante playback ativo
    _remoteUpdateTimer = setTimeout(() => {
      if (!applyRemoteEditorUpdate(newText)) return;
      afterRemoteEditorApplied(editor);
    }, 120);
  });

  // ✅ SOLUÇÃO 2: Quando recebe atualização de ESTILO do roteirista (fonte, tamanho)
  ipcRenderer.on("style-from-remote", (event, styleData) => {
    if (!styleData) return;

    const editor = getActiveTextEditorArea();
    if (!editor) return;

    // ===================================================================
    // CORREÇÃO CRÍTICA: O operador NUNCA deve receber fontSize do roteirista
    // O roteirista tem seu próprio fontSize, o operador mantém o dele
    // Isso evita que o font size do operador (ex: 48pt) caia para o do
    // roteirista (ex: 30pt) quando o roteirista edita o texto
    // ===================================================================
    if (styleData.type === 'fontSize') {
      // NÃO APLICAR fontSize recebido do remoto - manter fontSize do operador
      console.log('🔒 BLOQUEADO: fontSize do roteirista não é aplicado ao operador');
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

  // Progresso de leitura vai SOMENTE para roteiristas via Socket.io (browser :3001).
  // Não aplicar cinza no editor local — só no remote.html.


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
      fontFamily: currentFontFamily || editor.style.fontFamily || globalPrefs.defaultFont || 'Arial',
      fontSize: currentFontSizePT || parseInt(editor.style.fontSize) || 24,
      lineSpacing: globalPrefs.lineSpacing || 1.6,
      textAlign: editor.style.textAlign || 'left',
      scale: 100
    };

    // Envia para todos os peers WebRTC
    if (typeof RemoteConnectionModule !== 'undefined' && RemoteConnectionModule.broadcastStylesUpdate) {
      RemoteConnectionModule.broadcastStylesUpdate(styles);
    }

    // Envia pela INTERNET (WebRTC dataChannel) para cada roteirista conectado
    if (typeof peers === 'object' && peers) {
      Object.keys(peers).forEach((id) => {
        const peer = peers[id];
        if (peer && peer.dataChannel && peer.dataChannel.readyState === 'open') {
          peer.dataChannel.send(JSON.stringify({ type: 'style-update', styles }));
        }
      });
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

    // Coleta HTML com estilos inline preservados (estrutura "curada" para o roteirista)
    const healedTmp = document.createElement("div");
    healedTmp.innerHTML = getCleanContent(editor);
    healBlockWrappers(healedTmp);
    const htmlContent = healedTmp.innerHTML;
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
    // Verifica internet ANTES de tentar conectar
    const hasInternet = await checkInternetConnection();

    if (!hasInternet) {
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
      setTimeout(() => alertDiv.remove(), 5000);

      isInternetServerActive = false;
      updateInternetUI(false);
      updateSidebarIcon();
      return;
    }

    console.log("✅ Internet OK - Connecting...");

    // 1. Conecta ao servidor de sinalização
    signalingSocket = ioClient(SIGNALING_URL, {
      timeout: 10000,
      reconnection: false
    });

    // Tratamento de erro de conexão
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

      stopWebRTCConnection();
      isInternetServerActive = false;
      updateInternetUI(false);
      updateSidebarIcon();
    });

    // 2. Gera ID
    myRoomId = Math.floor(100000 + Math.random() * 900000).toString();

    // 3. Cria sala
    signalingSocket.emit('create-room', myRoomId);

    // 4. Atualiza UI
    isInternetServerActive = true;
    updateInternetUI(true, `roteiro.promptiq.com.br | ID: ${myRoomId}`);
    updateSidebarIcon();

    addLogEntry({
      msg: 'Internet server started',
      type: 'login',
      source: 'Internet',
      user: 'System'
    });

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

    // ⭐ NOVO: Ouve progresso de leitura do prompter para marcar texto como lido
    signalingSocket.on('read-progress', (payload) => {
      // Internet: progresso vai ao roteirista web via signaling — não marcar editor local
      void payload;
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

      const editor =
        getActiveTextEditorArea() ||
        document.querySelector('.editor-container.active .text-editor-area');
      if (editor) {
        // Mesmo HTML "curado" do prompter: o site do roteirista reescreve documentos de
        // 1 bloco só (span envolvendo parágrafos) e destruiria a formatação do operador.
        const initialHtml = getRemoteSyncContent() || editor.innerHTML;
        channel.send(JSON.stringify({ type: 'update', content: initialHtml }));
      }

      // Envia a fonte/estilo atual para o roteirista que acabou de conectar,
      // garantindo que ele veja a mesma fonte do operador desde o início.
      try {
        const styleEditor = editor || getActiveTextEditorArea();
        channel.send(JSON.stringify({
          type: 'style-update',
          styles: {
            fontFamily:
              currentFontFamily ||
              (styleEditor && styleEditor.style.fontFamily) ||
              (globalPrefs && globalPrefs.defaultFont) ||
              'Arial',
            fontSize: currentFontSizePT || (styleEditor && parseInt(styleEditor.style.fontSize)) || 24,
            textAlign: (styleEditor && styleEditor.style.textAlign) || 'left',
          }
        }));
      } catch (_) { }

      const readSnapshot = getReadProgressSnapshot();
      if (readSnapshot) {
        const payload = normalizeReadProgressPayload(readSnapshot);
        channel.send(JSON.stringify({ type: "read-progress", ...payload }));
        if (signalingSocket && signalingSocket.connected) {
          signalingSocket.emit("read-progress", payload);
        }
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
        const editor = getActiveTextEditorArea();

        if (!editor || !applyRemoteEditorUpdate(data.content)) return;

        afterRemoteEditorApplied(editor);

        broadcastTextUpdate(getRemoteSyncContent(), userId);

        if (isLocalServerActive && shouldBroadcastToRemotes()) {
          ipcRenderer.send('send-text-to-remote', getRemoteSyncContent());
        }

        const remoteName = (peers[userId] && peers[userId].userName) ? peers[userId].userName : "Roteirista (Web)";

        addLogEntry({
          msg: `${remoteName} is typing...`,
          type: 'edit',
          source: 'Internet',
          user: remoteName
        });
      } else if (data.type === 'read-progress') {
        // Progresso enviado pelo host ao roteirista web — não aplicar no editor local
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

  /**
   * Normaliza payload de leitura (inclui readIndices para servidor/script legado).
   */
  function normalizeReadProgressPayload(payload) {
    const data =
      typeof payload === "number"
        ? { maxReadIndex: payload, readPercent: payload < 0 ? 0 : undefined }
        : { ...(payload || {}) };

    if (typeof data.maxReadIndex === "number") {
      data.readIndices =
        data.maxReadIndex >= 0
          ? Array.from({ length: data.maxReadIndex + 1 }, (_, i) => i)
          : [];
    } else if (!Array.isArray(data.readIndices)) {
      data.readIndices = [];
    }

    if (typeof data.readCount !== "number" && typeof data.maxReadIndex === "number" && data.maxReadIndex >= 0) {
      data.readCount = data.maxReadIndex + 1;
    }

    return data;
  }

  let _lastReadProgressLogTime = 0;

  /**
   * Envia progresso de leitura para roteiristas (Local + Internet).
   * Payload: { maxReadIndex, readPercent, readIndices } ou número legado.
   */
  function broadcastReadProgressUpdate(payload) {
    const data = normalizeReadProgressPayload(payload);

    const now = Date.now();
    if (now - _lastReadProgressLogTime > 2000) {
      _lastReadProgressLogTime = now;
      console.log("[ReadProgress] →", {
        readCount: data.readCount, scrollRatio: data.scrollRatio?.toFixed(3),
        readLinePx: Math.round(data.readLinePx || 0), contentH: Math.round(data.contentHeightPx || 0),
        scrollPos: Math.round(data.scrollPos || 0), isScrolling: data.isScrolling
      });
    }

    ipcRenderer.send("send-read-progress-to-remote", data);

    if (signalingSocket && signalingSocket.connected) {
      signalingSocket.emit("read-progress", data);
    }

    Object.keys(peers).forEach((id) => {
      const peer = peers[id];
      if (peer.dataChannel && peer.dataChannel.readyState === "open") {
        peer.dataChannel.send(JSON.stringify({ type: "read-progress", ...data }));
      }
    });
  }

  // ============================================================
  // SEÇÃO 52: VOICE TRACKING (RASTREAMENTO POR VOZ)
  // ============================================================
  // Sincroniza scroll do prompter com a fala do apresentador

  const btnVoiceTrack = document.getElementById("btn-voice-tracking");
  const labelVoiceTrack = document.getElementById("voice-status-label");

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
        return alert("Error: Voice Manager did not load.");

      voiceModeActive = !voiceModeActive;
      const sucesso = await window.VoiceManager.toggle(voiceModeActive);

      if (voiceModeActive && sucesso) {
        btnVoiceTrack.classList.add("btn-danger", "text-white");
        btnVoiceTrack.classList.remove("btn-light");
        if (labelVoiceTrack) labelVoiceTrack.innerText = "ON";

        prepararRoteiroParaLeitura();

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

  // 4. O log fica visível na Home e no modo EDIÇÃO (onde o roteirista remoto edita o texto);
  //    só some enquanto o prompter está sendo operado (Operator sem edição / tela cheia).
  const syncLogVisibilityByTab = () => {
    const operatorPane = document.getElementById('operator-tab-pane');
    if (!operatorPane || !logContainer) return;
    const isOperatorActive =
      operatorPane.classList.contains('active') || operatorPane.classList.contains('show');
    const isEditing = document.body.classList.contains('operator-edit-mode');
    const isFullscreen = document.body.classList.contains('operator-fullscreen-mode');
    logContainer.classList.toggle('log-hidden', isOperatorActive && (!isEditing || isFullscreen));
  };

  document.querySelectorAll('[data-bs-toggle="tab"]').forEach((tabButton) => {
    tabButton.addEventListener('shown.bs.tab', syncLogVisibilityByTab);
  });
  window.addEventListener('operator-edit-mode-changed', syncLogVisibilityByTab);
  syncLogVisibilityByTab();







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

    if (lineSpacingToolbar && globalPrefs.lineSpacing) {
      setSelectValueSafe(lineSpacingToolbar, parseFloat(globalPrefs.lineSpacing), `Line ${parseFloat(globalPrefs.lineSpacing)}x`);
    }

    if (prompterMarginSelect && globalPrefs.prompterMargin !== undefined) {
      const parsedMargin = Number.parseInt(globalPrefs.prompterMargin, 10);
      const safeMargin = Number.isFinite(parsedMargin) ? parsedMargin : 40;
      setSelectValueSafe(prompterMarginSelect, safeMargin, `Margin ${safeMargin}`);
    }



    // 4. Sincroniza Menu Superior e Cores
    if (typeof updateFontUIState === 'function') {
      updateFontUIState(
        globalPrefs.defaultFont,
        currentFontSizePT > 0 ? currentFontSizePT : globalPrefs.defaultFontSize
      );
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

      // 2. APLICA NO EDITOR (ABA EDIT). Retorna true se foi só na SELEÇÃO.
      const partial = applyExactFontSizeToEditor(val);

      // 3. Só força o tamanho GLOBAL no prompter/UI quando NÃO há seleção.
      if (!partial) {
        applyExactFontSizeToOperator(val);
        updateFontUIState(null, val);
      }

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
      applyPrompterFontScale(prompterText, sizeInPt);
      // Respeita o espaçamento de linha escolhido (Preferences), em vez de forçar 1.2
      prompterText.style.lineHeight =
        currentLineSpacing || (globalPrefs && globalPrefs.lineSpacing) || 1.4;
    }

    // 4. Sincroniza o número exibido na caixinha da barra e no menu Format
    updateFontUIState(null, sizeInPt);
  }

  /**
   * Altera o tamanho da fonte diretamente na aba Operator (Ctrl +/−/0).
   * Não usa execCommand — apenas CSS direto para evitar interferir no
   * conteúdo do editor ou alterar espaçamento de linhas.
   * @param {number} sizeInPt
   */
  function applyOperatorFontSize(sizeInPt) {
    if (!sizeInPt || sizeInPt <= 0) return;
    currentFontSizePT = sizeInPt;

    const prompterText = document.getElementById('prompterText-control');
    if (prompterText) {
      applyPrompterFontScale(prompterText, sizeInPt);
      refreshEditPanelLookIfOpen();
    }

    // Sincroniza com janela de projeção externa
    ipcRenderer.send('sync-projection-font-size', sizeInPt);

    // Atualiza o número na barra de ferramentas
    updateFontUIState(null, sizeInPt);

    // Marca o documento como modificado e agenda autosave
    if (typeof markDocumentAsUnsaved === "function" && typeof activeDocumentId !== "undefined") {
      markDocumentAsUnsaved(activeDocumentId);
    }
    if (typeof scheduleAutoSave === "function") scheduleAutoSave();
  }

  // ============================================================
  // TRACKING DE SELEÇÃO DO EDITOR (para aplicação de fonte parcial)
  // ============================================================
  // Salva a última seleção não-vazia feita dentro do editor.
  // Crucial porque ao clicar na toolbar o browser descarta a seleção.
  let lastEditorRange = null;

  // 1) selectionchange: salva o range e atualiza o tamanho na toolbar
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const editorEl = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
    if (!editorEl) return;

    // Se a seleção está dentro do editor, detecta o tamanho do texto
    if (editorEl.contains(range.commonAncestorContainer)) {
      // Salva o range se não for colapsado (para aplicação de fonte parcial)
      if (!range.collapsed) {
        lastEditorRange = range.cloneRange();
      }

      // Detecta o tamanho da fonte no ponto da seleção/cursor (agrupado por frame:
      // getComputedStyle força recálculo de estilo e selectionchange dispara a cada tecla).
      scheduleToolbarSizeSync(range.startContainer);
    }
  });

  let _toolbarSizeSyncRaf = 0;
  function scheduleToolbarSizeSync(startContainer) {
    if (_toolbarSizeSyncRaf) cancelAnimationFrame(_toolbarSizeSyncRaf);
    _toolbarSizeSyncRaf = requestAnimationFrame(() => {
      _toolbarSizeSyncRaf = 0;
      let node = startContainer;
      if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      if (!node || !node.isConnected) return;

      const px = parseFloat(window.getComputedStyle(node).fontSize);
      if (px > 0) {
        const pt = Math.round((px / 96) * 72);
        // Atualiza a toolbar sem disparar eventos de change
        const sizeSelect = document.getElementById('font-size-toolbar-fix');
        const sizeCustom = document.getElementById('font-size-custom');
        if (sizeSelect && sizeSelect.value !== String(pt)) {
          setSelectValueSafe(sizeSelect, pt);
        }
        if (sizeCustom) sizeCustom.value = pt;
      }
    });
  }

  // 2) mousedown em QUALQUER elemento FORA do editor: salva o range
  //    uma última vez. Isso cobre selects, inputs, botões da toolbar.
  document.addEventListener('mousedown', (e) => {
    const editorEl = getActiveTextEditorArea ? getActiveTextEditorArea() : null;
    if (!editorEl) return;
    // Se o clique é DENTRO do editor, não faz nada (seleção natural)
    if (editorEl.contains(e.target)) return;
    // Clique FORA do editor: salva a seleção ANTES de ela ser descartada
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed
      && editorEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      lastEditorRange = sel.getRangeAt(0).cloneRange();
    }
  }, true); // ← useCapture=true para pegar ANTES de o foco mudar

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

      // 1. APLICA NO EDITOR (ABA EDIT). Retorna true se foi só na SELEÇÃO.
      const partial = applyExactFontSizeToEditor(valor);

      // 2. Se foi parcial (só a seleção), NÃO mexe no tamanho global do
      //    prompter, nem nas preferências, nem envia fontSize global ao
      //    remoto — a seleção já vai no conteúdo (span inline) sincronizado.
      if (!partial) {
        currentFontSizePT = valor;
        applyExactFontSizeToOperator(valor);
        updateFontUIState(null, valor);
        ipcRenderer.send('save-settings', { defaultFontSize: valor });
        ipcRenderer.send('send-style-to-remote', {
          type: 'fontSize',
          value: valor,
          name: 'Host'
        });
      }

      // 3. Marca como não salvo e agenda autosave
      if (typeof markDocumentAsUnsaved === "function" && typeof activeDocumentId !== "undefined") {
        markDocumentAsUnsaved(activeDocumentId);
      }
      if (typeof scheduleAutoSave === "function") scheduleAutoSave();
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

    const liveSel = window.getSelection();
    const liveRange = (liveSel && liveSel.rangeCount > 0) ? liveSel.getRangeAt(0) : null;

    const hasLive = liveRange && !liveRange.collapsed
      && editor.contains(liveRange.commonAncestorContainer);

    let workingRange = null;
    if (hasLive) {
      workingRange = liveRange;
    } else if (lastEditorRange && !lastEditorRange.collapsed) {
      try {
        if (editor.contains(lastEditorRange.commonAncestorContainer)) {
          workingRange = lastEditorRange;
        }
      } catch (e) { /* range inválido */ }
    }

    let appliedPartial = false;

    if (workingRange) {
      // ── MODO PARCIAL: aplica APENAS no texto selecionado ─────────────
      try {
        // 1. Extrai o conteúdo selecionado para um DocumentFragment
        const fragment = workingRange.extractContents();

        // 2. Limpa font-size de TODOS os descendentes do fragment
        //    (assim spans internos não sobrescrevem o tamanho novo)
        const stripFontSize = (root) => {
          if (!root || !root.querySelectorAll) return;
          root.querySelectorAll('[style]').forEach(el => {
            el.style.removeProperty('font-size');
            if (!el.getAttribute('style') || el.getAttribute('style').trim() === '') {
              el.removeAttribute('style');
            }
          });
          root.querySelectorAll('font[size]').forEach(f => f.removeAttribute('size'));
        };
        stripFontSize(fragment);

        // 3. Cria o span wrapper com o novo tamanho e insere o fragment
        const wrapper = document.createElement('span');
        wrapper.style.fontSize = `${sizeInPt}pt`;
        wrapper.appendChild(fragment);

        // 4. Insere o wrapper de volta no documento
        workingRange.insertNode(wrapper);

        // Seleção com vários parágrafos: o span não pode conter blocos (o roteirista
        // quebrava esse documento). O estilo passa para cada bloco.
        const wrapped = inlineHasBlockChild(wrapper) ? unwrapInlineWithBlocks(wrapper) : null;

        // 5. Re-seleciona o conteúdo do wrapper (preserva seleção visual)
        const newRange = document.createRange();
        if (wrapped && wrapped.length) {
          newRange.setStartBefore(wrapped[0]);
          newRange.setEndAfter(wrapped[wrapped.length - 1]);
        } else {
          newRange.selectNodeContents(wrapper);
        }
        liveSel.removeAllRanges();
        liveSel.addRange(newRange);

        // Atualiza o range salvo para a próxima operação
        lastEditorRange = newRange.cloneRange();

        // IMPORTANTE: NÃO altera currentFontSizePT nem o container do editor.
        // O tamanho base (global) continua o mesmo; apenas a seleção muda.
        appliedPartial = true;

      } catch (err) {
        console.error('Erro ao aplicar font-size na seleção:', err);
        // Fallback: aplica globalmente
        editor.style.fontSize = `${sizeInPt}pt`;
        currentFontSizePT = sizeInPt;
      }

    } else {
      // ── MODO GLOBAL: sem seleção → aplica em todo o documento ────────
      currentFontSizePT = sizeInPt;
      editor.style.fontSize = `${sizeInPt}pt`;

      // Atualiza spans inline existentes
      editor.querySelectorAll('[style*="font-size"]').forEach(el => {
        el.style.fontSize = `${sizeInPt}pt`;
      });
      editor.querySelectorAll('font[size]').forEach(f => {
        f.removeAttribute('size');
        f.style.fontSize = `${sizeInPt}pt`;
      });
    }

    if (typeof syncContentToPrompter === "function") {
      syncContentToPrompter({ preserveVisibleAnchor: !appliedPartial });
    }
    if (activeDocumentId) markDocumentAsUnsaved(activeDocumentId);

    // Retorna true quando aplicou SOMENTE na seleção (parcial), para o chamador
    // NÃO forçar o tamanho global no prompter/preferências.
    return appliedPartial;
  }

  /**
   * Aplica tamanho exato no prompter (aba Operator)
   */
  function applyExactFontSizeToOperator(sizeInPt) {
    const prompterText = document.getElementById('prompterText-control');

    if (prompterText) {
      preserveOperatorReadPosition(() => {
        applyPrompterFontScale(prompterText, sizeInPt);
        prompterText.style.lineHeight =
          currentLineSpacing || (globalPrefs && globalPrefs.lineSpacing) || 1.4;
      }, 1);
      refreshEditPanelLookIfOpen();
    }

    console.log(`✅ Font Size Operator atualizado com escala (base Edit: ${sizeInPt}pt)`);
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
      setSelectValueSafe(toolbarSizeFix, fontSize);
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

        // Aplica no editor; só força o global se NÃO houver seleção.
        const partial = applyExactFontSizeToEditor(val);
        if (!partial) {
          applyExactFontSizeToOperator(val);
          updateFontUIState(null, val);
        }

        // Limpa e sincroniza o input customizado com o mesmo valor
        if (fontSizeCustom) fontSizeCustom.value = val;

        // Marca como não salvo e agenda autosave
        if (typeof markDocumentAsUnsaved === "function" && typeof activeDocumentId !== "undefined") {
          markDocumentAsUnsaved(activeDocumentId);
        }
        if (typeof scheduleAutoSave === "function") scheduleAutoSave();

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
          const partial = applyExactFontSizeToEditor(val);
          if (!partial) {
            applyExactFontSizeToOperator(val);
            updateFontUIState(null, val);
          }
          if (fontSizePreset) fontSizePreset.value = "";
          if (typeof markDocumentAsUnsaved === "function" && typeof activeDocumentId !== "undefined") {
            markDocumentAsUnsaved(activeDocumentId);
          }
          if (typeof scheduleAutoSave === "function") scheduleAutoSave();
          getActiveTextEditorArea()?.focus();
        }
      }
    });

    // Valida e aplica o valor quando sai do input
    fontSizeCustom.addEventListener('blur', (e) => {
      const val = parseInt(e.target.value);

      if (val && val >= 8 && val <= 100) {
        console.log("📐 Tamanho customizado aplicado (blur):", val);
        const partial = applyExactFontSizeToEditor(val);
        if (!partial) {
          applyExactFontSizeToOperator(val);
          updateFontUIState(null, val);
        }
        if (fontSizePreset) fontSizePreset.value = "";
        if (typeof markDocumentAsUnsaved === "function" && typeof activeDocumentId !== "undefined") {
          markDocumentAsUnsaved(activeDocumentId);
        }
        if (typeof scheduleAutoSave === "function") scheduleAutoSave();
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

      // Remove estilos antigos (mantém cores e font-size do usuário)
      if (el.style) {
        const currentStyles = el.style.cssText;

        if (currentStyles) {
          let newStyle = el.style.cssText;
          newStyle = newStyle.replace(/font-family:\s*[^;]+;?/gi, "");

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
            Type a message for the presenter:
            </label>
            
            <div class="input-group mb-3">
                <input type="text" id="custom-msg-input" 
                       class="form-control" 
                       style="background-color: #1e1f22; color: #fff; border: 1px solid #555;"
                    placeholder="Ex: Adjust tie..." autocomplete="off">
                
                <button class="btn btn-primary" id="btn-send-custom">
                    <i class="bi bi-send-fill"></i>
                </button>
            </div>

            <label style="color: #cccccc !important; font-size: 0.8rem; margin-bottom: 5px; display:block;">Quick Shortcuts:</label>
            <div class="d-grid gap-2 mb-3">
                <button id="btn-preset-louder" class="btn btn-outline-warning fw-bold">
                <i class="bi bi-volume-up-fill"></i> SPEAK LOUDER
                </button>
                <button id="btn-preset-smile" class="btn btn-outline-info fw-bold">
                <i class="bi bi-emoji-smile-fill"></i> SMILE
                </button>
            </div>

            <p style="color: #999 !important; font-size: 0.8rem; margin-top: 5px;">
              <i class="bi bi-info-circle"></i> Type and press ENTER to send.
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
          message: 'SPEAK LOUDER',
          bg: '#ffc107', // Amarelo
          color: '#000000', // Texto preto para contraste
          icon: 'bi-volume-up-fill'
        });
      };

      // Botão SORRIA
      document.getElementById('btn-preset-smile').onclick = () => {
        triggerOverlayMessage({
          message: 'SMILE',
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
      const run = (typeof runFullscreenChangePreservingAnchor === "function")
        ? runFullscreenChangePreservingAnchor
        : (fn) => fn();
      run(() => {
        ipcRenderer.send("control-window", "fullscreen"); // Garanta que esse handler existe no main.js
      });
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

      // ── Ctrl + = / Ctrl + +  →  aumenta fonte (Operator) ──────────────
      if (e.key === '=' || e.key === '+') {
        const opTab = document.getElementById('operator-tab-pane');
        if (opTab && opTab.classList.contains('active')) {
          e.preventDefault();
          const newSize = Math.min(120, (currentFontSizePT || 24) + 2);
          applyOperatorFontSize(newSize);
        }
      }

      // ── Ctrl + -  →  diminui fonte (Operator) ──────────────────────────
      if (e.key === '-') {
        const opTab = document.getElementById('operator-tab-pane');
        if (opTab && opTab.classList.contains('active')) {
          e.preventDefault();
          const newSize = Math.max(8, (currentFontSizePT || 24) - 2);
          applyOperatorFontSize(newSize);
        }
      }

      // ── Ctrl + 0  →  volta ao tamanho padrão (Operator) ───────────────
      if (e.key === '0') {
        const opTab = document.getElementById('operator-tab-pane');
        if (opTab && opTab.classList.contains('active')) {
          e.preventDefault();
          const defaultSize = (globalPrefs && globalPrefs.defaultFontSize) || 24;
          applyOperatorFontSize(defaultSize);
        }
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
