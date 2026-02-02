// ============================================================
// voice-module.js
// ============================================================
// DESCRIÇÃO: Módulo de reconhecimento de voz com VOSK Browser
// FUNÇÃO: Usa vosk-browser (WebAssembly) para reconhecimento offline
//         e rola o teleprompter usando busca progressiva (lookahead)
//         COMPATÍVEL com rolagem manual (mouse/teclado)
// ============================================================

console.log('🎤 voice-module.js carregando...');

const VoiceModule = (function () {
  // ============================================================
  // ESTADO INTERNO
  // ============================================================
  let isActive = false;
  let isReady = false;
  let currentIndex = 0;  // Posição atual no texto do roteiro
  const LOOKAHEAD_CHARS = 300;  // Janela de busca (reduzida para precisão)

  // Cache do roteiro indexado
  let roteiroTexto = '';  // Texto completo limpo do roteiro
  let roteiroElementos = [];  // Mapeamento de posições para elementos DOM

  // VOSK Browser
  let voskModel = null;
  let voskRecognizer = null;
  let audioContext = null;
  let mediaStream = null;
  let mediaStreamSource = null;
  let recognizerProcessor = null;

  // Caminho do modelo - servido via HTTP local na porta 8321 (arquivo .tar.gz)
  const MODEL_PATH = 'http://127.0.0.1:8321/model/vosk-model-small-pt-0.3.tar.gz';

  // Controle de interação manual vs voz
  let ultimaRolagemManual = 0;  // Timestamp da última rolagem manual
  const PAUSA_APOS_MANUAL = 800;  // Reduzido para 0.8s - retoma mais rápido

  // ============================================================
  // FUNÇÕES DE NOTIFICAÇÃO
  // ============================================================

  /**
   * Notifica o renderer sobre eventos de voz
   * @param {string} tipo - Tipo do evento (status, ready, text, partial, error)
   * @param {any} dados - Dados do evento
   */
  function notificarRenderer(tipo, dados) {
    const event = new CustomEvent('voice-tracking-event', {
      detail: { type: tipo, data: dados }
    });
    window.dispatchEvent(event);
  }

  // ============================================================
  // INDEXAÇÃO DO ROTEIRO
  // ============================================================

  /**
   * Limpa e normaliza texto para busca
   * @param {string} texto - Texto original
   * @returns {string} Texto normalizado
   */
  function normalizarTexto(texto) {
    return texto
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // Remove acentos
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'?¿¡!]/g, '')  // Remove pontuação
      .replace(/\s+/g, ' ')  // Normaliza espaços
      .trim();
  }

  /**
   * Prepara o roteiro para busca por voz
   * Cria um cache com texto limpo e mapeamento para elementos DOM
   */
  function prepararRoteiro() {
    const container = document.getElementById('prompterText-control');
    if (!container) {
      console.warn('🎤 Container do prompter não encontrado');
      return;
    }

    roteiroTexto = '';
    roteiroElementos = [];
    currentIndex = 0;
    ultimaPosicaoEncontrada = -1;
    ultimoTextoProcessado = '';

    // Percorre todos os nós de texto do container
    const treeWalker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT
    );

    let node;
    while ((node = treeWalker.nextNode())) {
      const textoOriginal = node.nodeValue;
      if (textoOriginal && textoOriginal.trim().length > 0) {
        const textoLimpo = normalizarTexto(textoOriginal);
        const posInicio = roteiroTexto.length;

        roteiroTexto += textoLimpo + ' ';

        // Guarda mapeamento: posição no texto -> elemento DOM
        roteiroElementos.push({
          inicio: posInicio,
          fim: roteiroTexto.length - 1,
          elemento: node.parentElement,
          textoOriginal: textoOriginal.trim()
        });
      }
    }

    console.log(`🎤 Roteiro indexado: ${roteiroTexto.length} caracteres, ${roteiroElementos.length} segmentos`);
  }

  // ============================================================
  // BUSCA PROGRESSIVA COM LOOKAHEAD (PRECISA E SEM PULOS)
  // ============================================================

  // Última posição encontrada para evitar buscas repetidas
  let ultimaPosicaoEncontrada = -1;
  let ultimoTextoProcessado = '';
  let ultimoSegmentoIndex = -1;  // Índice do último segmento/parágrafo encontrado

  // Configurações de precisão - CONSERVADORAS para evitar pulos prematuros
  const MAX_PULO = 150;  // Janela de busca reduzida
  const MIN_PALAVRAS_PARA_PULAR_SEGMENTO = 2;  // Precisa de 2+ palavras para pular parágrafo
  const MIN_CHARS_BUSCA = 3;  // Mínimo de caracteres para buscar

  /**
   * Calcula similaridade entre duas strings (0 a 1)
   * Usa algoritmo de subsequência comum mais longa (LCS)
   */
  function calcularSimilaridade(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;

    const len1 = str1.length;
    const len2 = str2.length;

    // LCS simplificado para performance
    let matches = 0;
    let j = 0;
    for (let i = 0; i < len1 && j < len2; i++) {
      if (str1[i] === str2[j]) {
        matches++;
        j++;
      }
    }

    return matches / Math.max(len1, len2);
  }

  /**
   * Busca uma frase dentro da janela de lookahead
   * OTIMIZADO: Usa matching fuzzy para maior tolerância a erros do VOSK
   * @param {string} fraseFalada - Texto reconhecido pela voz
   * @returns {Object|null} Elemento encontrado ou null
   */
  function buscarNaJanela(fraseFalada) {
    if (!fraseFalada || roteiroTexto.length === 0) return null;

    const fraseLimpa = normalizarTexto(fraseFalada);

    // Precisa de pelo menos 3 caracteres
    if (fraseLimpa.length < MIN_CHARS_BUSCA) return null;

    // Define a janela de busca: um pouco antes e à frente
    const inicioJanela = Math.max(0, currentIndex - 20);  // Pequeno lookbehind
    const fimJanela = Math.min(currentIndex + MAX_PULO, roteiroTexto.length);
    const janelaTexto = roteiroTexto.substring(inicioJanela, fimJanela);

    // Pega as palavras da frase reconhecida
    const palavras = fraseLimpa.split(/\s+/).filter(p => p.length >= 2);

    if (palavras.length === 0) return null;

    let melhorMatch = null;
    let melhorScore = 0;
    let melhorPosicao = -1;

    // Estratégia 1: Busca exata com as últimas 2-3 palavras
    for (let numPalavras = Math.min(3, palavras.length); numPalavras >= 1; numPalavras--) {
      const termoBusca = palavras.slice(-numPalavras).join(' ');
      const posicaoRelativa = janelaTexto.indexOf(termoBusca);

      if (posicaoRelativa !== -1) {
        const posicaoAbsoluta = inicioJanela + posicaoRelativa;
        const score = numPalavras * 10;  // Mais palavras = maior score

        if (score > melhorScore) {
          melhorScore = score;
          melhorPosicao = posicaoAbsoluta;
          melhorMatch = termoBusca;
        }
      }
    }

    // Estratégia 2: Busca fuzzy se exata falhou
    if (!melhorMatch && palavras.length >= 1) {
      const ultimaPalavra = palavras[palavras.length - 1];

      // Procura palavras similares na janela
      const palavrasJanela = janelaTexto.split(/\s+/);
      let posicaoAcumulada = 0;

      for (const palavraJanela of palavrasJanela) {
        const similaridade = calcularSimilaridade(ultimaPalavra, palavraJanela);

        if (similaridade >= 0.7) {  // 70% de similaridade
          const posicaoAbsoluta = inicioJanela + janelaTexto.indexOf(palavraJanela, posicaoAcumulada);
          const score = similaridade * 5;

          if (score > melhorScore && posicaoAbsoluta > ultimaPosicaoEncontrada) {
            melhorScore = score;
            melhorPosicao = posicaoAbsoluta;
            melhorMatch = palavraJanela;
          }
        }
        posicaoAcumulada += palavraJanela.length + 1;
      }
    }

    if (melhorMatch && melhorPosicao !== -1) {
      // VALIDAÇÃO: Verifica se é um avanço válido
      const avanco = melhorPosicao - ultimaPosicaoEncontrada;

      // Aceita pequenas voltas (até 20 chars) para correções
      if (avanco < -20) {
        return null;  // Volta muito grande, ignora
      }

      // Encontra o elemento DOM correspondente
      for (let segIndex = 0; segIndex < roteiroElementos.length; segIndex++) {
        const segmento = roteiroElementos[segIndex];
        if (melhorPosicao >= segmento.inicio && melhorPosicao <= segmento.fim) {

          // PROTEÇÃO CONTRA PULOS PREMATUROS:
          // Se está tentando pular para outro segmento/parágrafo,
          // exige mais palavras para confirmar
          if (ultimoSegmentoIndex !== -1 && segIndex > ultimoSegmentoIndex) {
            // Está tentando pular para o próximo parágrafo
            if (palavras.length < MIN_PALAVRAS_PARA_PULAR_SEGMENTO) {
              // Poucas palavras - não pula ainda, fica no parágrafo atual
              return null;
            }

            // Verifica se as palavras realmente pertencem ao novo parágrafo
            const textoNovoSegmento = roteiroTexto.substring(segmento.inicio, segmento.fim);
            const palavrasEncontradas = palavras.filter(p => textoNovoSegmento.includes(p));

            if (palavrasEncontradas.length < MIN_PALAVRAS_PARA_PULAR_SEGMENTO) {
              // As palavras não estão claramente no novo parágrafo
              return null;
            }
          }

          // Atualiza o índice para a posição encontrada
          currentIndex = melhorPosicao + melhorMatch.length;
          ultimaPosicaoEncontrada = melhorPosicao;
          ultimoTextoProcessado = fraseLimpa;
          ultimoSegmentoIndex = segIndex;

          return {
            elemento: segmento.elemento,
            posicao: melhorPosicao,
            termo: melhorMatch
          };
        }
      }
    }

    return null;
  }

  /**
   * Processa o texto reconhecido e rola o prompter se necessário
   * @param {string} textoReconhecido - Texto reconhecido
   * @param {boolean} isFinal - Se é resultado final ou parcial
   */
  function processarTextoReconhecido(textoReconhecido, isFinal) {
    if (!isActive || !textoReconhecido) return;

    // Verifica se houve rolagem manual recente - se sim, não interfere
    const agora = Date.now();
    if (agora - ultimaRolagemManual < PAUSA_APOS_MANUAL) {
      return; // Usuário está rolando manualmente, não interfere
    }

    const resultado = buscarNaJanela(textoReconhecido);

    if (resultado) {
      // Encontrou! Rola o prompter para o elemento
      rolarParaElemento(resultado.elemento, resultado.posicao);
      notificarRenderer('match', {
        texto: textoReconhecido,
        posicao: resultado.posicao
      });
    } else if (isFinal) {
      // Improviso - apenas loga
      notificarRenderer('improviso', textoReconhecido);
    }
  }

  // Variáveis para controle de scroll suave do VOSK
  let scrollAtualVosk = 0;
  let scrollAlvoVosk = 0;
  let animacaoScrollVosk = null;

  /**
   * Rola o prompter suavemente até um elemento específico
   * SEMPRE PARA FRENTE - nunca volta
   * @param {HTMLElement} elemento - Elemento alvo
   * @param {number} posicaoTexto - Posição no texto (para cálculo de progresso)
   */
  function rolarParaElemento(elemento, posicaoTexto) {
    if (!elemento) return;

    const container = document.querySelector('.prompter-in-control');
    if (!container) return;

    // Remove destaque anterior
    document.querySelectorAll('.lendo-agora').forEach(el => {
      el.classList.remove('lendo-agora');
    });

    // Adiciona destaque ao elemento atual (sempre mostra onde está lendo)
    elemento.classList.add('lendo-agora');

    // Calcula posição alvo para scroll
    const containerRect = container.getBoundingClientRect();
    const elementoRect = elemento.getBoundingClientRect();

    // Posiciona o elemento a 30% do topo do container (na altura do cue marker)
    const novoAlvo =
      elementoRect.top - containerRect.top +
      scrollAtualVosk -
      containerRect.height * 0.3;

    // SÓ ATUALIZA SE FOR PARA FRENTE (nunca volta)
    if (novoAlvo > scrollAlvoVosk) {
      scrollAlvoVosk = novoAlvo;
    }

    // Inicia animação suave se não estiver rodando
    if (!animacaoScrollVosk) {
      animarScrollVosk(container);
    }
  }

  /**
   * Anima o scroll de forma CONTÍNUA E SUAVE
   * Movimento sempre para frente, sem pulos ou trepidações
   * @param {HTMLElement} container - Container do scroll
   */
  function animarScrollVosk(container) {
    // Verifica se houve rolagem manual - se sim, para a animação do VOSK
    const agora = Date.now();
    if (agora - ultimaRolagemManual < PAUSA_APOS_MANUAL) {
      animacaoScrollVosk = null;
      return;
    }

    // Calcula a diferença para o alvo
    const diferenca = scrollAlvoVosk - scrollAtualVosk;

    // Se já chegou perto o suficiente, para a animação
    if (Math.abs(diferenca) < 0.5) {
      animacaoScrollVosk = null;
      return;
    }

    // SÓ MOVE PARA FRENTE (diferença positiva)
    if (diferenca > 0) {
      // Velocidade ADAPTATIVA: mais rápido se estiver longe, mais lento se perto
      // Isso cria um efeito de "ease-out" natural
      const velocidadeBase = Math.min(diferenca * 0.12, 4);  // Aumentado para resposta mais rápida
      const velocidadeMinima = 1;  // Garante movimento mínimo
      const velocidadePixels = Math.max(velocidadeBase, velocidadeMinima);

      scrollAtualVosk += velocidadePixels;
    }

    // Aplica o scroll via ScrollEngine
    if (typeof ScrollEngine !== 'undefined' && ScrollEngine.getTextElement) {
      ScrollEngine.decimalScroll = scrollAtualVosk;
      const textEl = ScrollEngine.getTextElement();
      if (textEl) {
        textEl.style.transform = `translate3d(0, -${scrollAtualVosk}px, 0)`;
      }
    } else {
      container.scrollTop = scrollAtualVosk;
    }

    // Continua a animação
    animacaoScrollVosk = requestAnimationFrame(() => animarScrollVosk(container));
  }

  /**
   * Sincroniza a posição do VOSK com a posição atual do scroll
   * Chamado quando o usuário rola manualmente
   */
  function sincronizarPosicaoComScroll() {
    ultimaRolagemManual = Date.now();

    // Para a animação do VOSK
    if (animacaoScrollVosk) {
      cancelAnimationFrame(animacaoScrollVosk);
      animacaoScrollVosk = null;
    }

    // Atualiza a posição do VOSK para a posição atual do scroll
    if (typeof ScrollEngine !== 'undefined') {
      scrollAtualVosk = ScrollEngine.decimalScroll || 0;
      scrollAlvoVosk = scrollAtualVosk;
    }

    // Tenta encontrar qual elemento está visível e atualiza o currentIndex
    atualizarIndexPelaVisibilidade();
  }

  /**
   * Atualiza o currentIndex baseado no elemento visível na tela
   */
  function atualizarIndexPelaVisibilidade() {
    const container = document.querySelector('.prompter-in-control');
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const pontoReferencia = containerRect.top + containerRect.height * 0.3;

    // Encontra o elemento mais próximo do ponto de referência
    for (const segmento of roteiroElementos) {
      const rect = segmento.elemento.getBoundingClientRect();
      if (rect.top <= pontoReferencia && rect.bottom >= pontoReferencia) {
        // Este elemento está na posição do cue marker
        currentIndex = segmento.inicio;
        ultimaPosicaoEncontrada = segmento.inicio - 1;
        ultimoTextoProcessado = '';
        break;
      }
    }
  }

  // ============================================================
  // CONTROLE DE ATIVAÇÃO (via VOSK Browser)
  // ============================================================

  /**
   * Carrega o modelo VOSK (uma única vez)
   */
  async function carregarModelo() {
    if (voskModel) return true;  // Já carregado

    try {
      console.log('🎤 Carregando modelo VOSK de:', MODEL_PATH);
      notificarRenderer('status', '🎤 Carregando modelo de voz...');

      // Importa vosk-browser
      const { createModel } = require('vosk-browser');

      // Carrega o modelo via HTTP
      voskModel = await createModel(MODEL_PATH);

      console.log('🎤 Modelo VOSK carregado com sucesso!');
      return true;
    } catch (error) {
      console.error('🎤 Erro ao carregar modelo VOSK:', error);
      notificarRenderer('error', 'Erro ao carregar modelo: ' + error.message);
      return false;
    }
  }

  /**
   * Inicia o reconhecimento de voz com VOSK Browser
   */
  async function iniciarReconhecimento() {
    try {
      // 1. Carrega o modelo se necessário
      const modeloOk = await carregarModelo();
      if (!modeloOk) return false;

      // 2. Solicita acesso ao microfone - OTIMIZADO para menor latência
      console.log('🎤 Solicitando acesso ao microfone...');
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,  // Desabilita para menor latência
          noiseSuppression: false,  // Desabilita para menor latência
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000  // Força 16kHz para VOSK
        },
        video: false
      });

      // 3. Cria o AudioContext com LATÊNCIA MÍNIMA
      audioContext = new AudioContext({
        latencyHint: 'interactive',  // Mudado de 'playback' para 'interactive'
        sampleRate: 16000  // VOSK prefere 16kHz
      });
      const sampleRate = audioContext.sampleRate;
      console.log('🎤 AudioContext sample rate:', sampleRate, 'latency:', audioContext.baseLatency);

      // 4. Cria o recognizer a partir do modelo
      voskRecognizer = new voskModel.KaldiRecognizer(sampleRate);
      voskRecognizer.setWords(false);  // Desabilita words para maior velocidade

      // 5. Configura callbacks do recognizer - RESPOSTA IMEDIATA
      voskRecognizer.on('result', (message) => {
        const resultado = message.result;
        if (resultado && resultado.text && resultado.text.trim().length > 0) {
          processarTextoReconhecido(resultado.text, true);
        }
      });

      voskRecognizer.on('partialresult', (message) => {
        const parcial = message.result;
        if (parcial && parcial.partial && parcial.partial.trim().length > 0) {
          // PRIORIDADE MÁXIMA - processa parciais imediatamente
          processarTextoReconhecido(parcial.partial, false);
        }
      });

      // 6. Conecta o microfone ao recognizer
      mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);

      // Buffer de 256 samples é o mínimo permitido pelo ScriptProcessorNode
      // Valores válidos: 256, 512, 1024, 2048, 4096, 8192, 16384
      const bufferSize = 256;
      recognizerProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);

      recognizerProcessor.onaudioprocess = (event) => {
        if (!isActive || !voskRecognizer) return;

        try {
          const audioBuffer = event.inputBuffer;
          voskRecognizer.acceptWaveform(audioBuffer);
        } catch (e) {
          console.warn('🎤 Erro no processamento de áudio:', e);
        }
      };

      // Conecta os nós de áudio
      mediaStreamSource.connect(recognizerProcessor);
      recognizerProcessor.connect(audioContext.destination);

      console.log('🎤 Reconhecimento VOSK iniciado com latência mínima!');
      notificarRenderer('status', '🎤 Microfone ATIVO');
      return true;

    } catch (error) {
      console.error('🎤 Erro ao iniciar reconhecimento:', error);
      notificarRenderer('error', 'Erro: ' + error.message);
      pararReconhecimento();
      return false;
    }
  }

  /**
   * Para o reconhecimento de voz
   */
  function pararReconhecimento() {
    console.log('🎤 Parando reconhecimento...');

    // Desconecta os nós de áudio
    if (recognizerProcessor) {
      try {
        recognizerProcessor.disconnect();
      } catch (e) { }
      recognizerProcessor = null;
    }

    if (mediaStreamSource) {
      try {
        mediaStreamSource.disconnect();
      } catch (e) { }
      mediaStreamSource = null;
    }

    // Para o stream do microfone
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }

    // Fecha o AudioContext
    if (audioContext && audioContext.state !== 'closed') {
      try {
        audioContext.close();
      } catch (e) { }
      audioContext = null;
    }

    // Libera o recognizer (mas mantém o modelo em cache)
    if (voskRecognizer) {
      try {
        voskRecognizer.remove();
      } catch (e) { }
      voskRecognizer = null;
    }

    console.log('🎤 Reconhecimento parado');
  }

  /**
   * Liga ou desliga o reconhecimento de voz
   * @param {boolean} ativar - true para ligar, false para desligar
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async function toggle(ativar) {
    if (ativar) {
      try {
        // Prepara o roteiro antes de iniciar
        prepararRoteiro();

        // Inicia o reconhecimento VOSK
        const sucesso = await iniciarReconhecimento();
        if (sucesso) {
          isActive = true;
          console.log('🎤 Voice Tracking INICIADO (VOSK Browser)');
          return true;
        }

        return false;

      } catch (err) {
        console.error('🎤 Erro ao ativar voz:', err);
        notificarRenderer('error', err.message);
        return false;
      }
    } else {
      // Desativa
      pararReconhecimento();

      isActive = false;
      currentIndex = 0;

      // Remove destaques
      document.querySelectorAll('.lendo-agora').forEach(el => {
        el.classList.remove('lendo-agora');
      });

      notificarRenderer('status', '🎤 Microfone DESATIVADO');
      console.log('🎤 Voice Tracking PARADO');

      return false;
    }
  }

  /**
   * Reseta a posição de leitura para o início
   */
  function resetarPosicao() {
    currentIndex = 0;
    ultimaPosicaoEncontrada = -1;
    ultimoTextoProcessado = '';
    ultimoSegmentoIndex = -1;
    scrollAtualVosk = 0;
    scrollAlvoVosk = 0;
    prepararRoteiro();
    console.log('🎤 Posição resetada para o início');
  }

  /**
   * Configura listeners para detectar rolagem manual
   */
  function configurarListenersRolagemManual() {
    // Detecta rolagem por teclado
    document.addEventListener('keydown', (e) => {
      const teclasRolagem = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space'];
      if (teclasRolagem.includes(e.key) && isActive) {
        sincronizarPosicaoComScroll();
      }
    });

    // Detecta rolagem por mouse (wheel)
    document.addEventListener('wheel', () => {
      if (isActive) {
        sincronizarPosicaoComScroll();
      }
    }, { passive: true });

    // Detecta clique em controles de scroll (se existirem)
    document.addEventListener('mousedown', (e) => {
      if (isActive && e.target.closest('.scroll-controls, .prompter-controls')) {
        sincronizarPosicaoComScroll();
      }
    });
  }

  // ============================================================
  // INICIALIZAÇÃO
  // ============================================================

  function init() {
    console.log('🎤 Inicializando VoiceModule (VOSK Browser)...');

    // Verifica se o navegador suporta getUserMedia
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('🎤 Microfone não suportado neste navegador');
      notificarRenderer('error', 'Microfone não suportado');
      return;
    }

    // Configura listeners para rolagem manual
    configurarListenersRolagemManual();

    isReady = true;
    notificarRenderer('ready', 'Reconhecimento de voz pronto');
    console.log('🎤 VoiceModule pronto');
  }

  // Auto-inicializa quando o DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Pequeno delay para garantir que cognito está disponível
    setTimeout(init, 100);
  }

  // ============================================================
  // API PÚBLICA
  // ============================================================
  return {
    toggle,
    resetarPosicao,
    prepararRoteiro,
    sincronizarPosicaoComScroll,  // Expõe para uso externo se necessário
    isActive: () => isActive,
    isReady: () => isReady,
    getCurrentIndex: () => currentIndex,
    getDiagnostics: () => ({
      isActive,
      isReady,
      currentIndex,
      roteiroLength: roteiroTexto.length,
      segmentos: roteiroElementos.length,
      lookahead: LOOKAHEAD_CHARS,
      modelLoaded: !!voskModel
    })
  };
})();

// Expõe globalmente para o botão usar
window.VoiceManager = VoiceModule;

console.log('🎤 voice-module.js carregado (VOSK Browser)');
