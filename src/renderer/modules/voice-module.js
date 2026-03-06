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
  const LOOKAHEAD_CHARS = 500;  // Janela de busca aumentada

  // Cache do roteiro indexado
  let roteiroTexto = '';  // Texto completo limpo do roteiro
  let roteiroElementos = [];  // Mapeamento de posições para elementos DOM
  let roteiroPalavras = [];  // NOVO: Array de palavras com posições
  let palavrasIndex = new Map();  // Índice invertido para busca O(1)

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
  const PAUSA_APOS_MANUAL = 400;  // Reduzido para 0.4s - retoma mais rápido

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
   * Cria um cache com texto limpo, mapeamento para elementos DOM
   * e ÍNDICE DE PALAVRAS para busca rápida
   */
  function prepararRoteiro() {
    const container = document.getElementById('prompterText-control');
    if (!container) {
      console.warn('🎤 Container do prompter não encontrado');
      return;
    }

    roteiroTexto = '';
    roteiroElementos = [];
    roteiroPalavras = [];  // NOVO: índice de palavras
    currentIndex = 0;
    ultimaPosicaoEncontrada = -1;
    ultimoTextoProcessado = '';

    // Percorre todos os nós de texto do container
    const treeWalker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT
    );

    let node;
    let palavraIndex = 0;
    
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
          node: node,  // NOVO: referência ao nó de texto
          textoOriginal: textoOriginal.trim()
        });

        // NOVO: Indexa cada palavra individualmente
        const palavras = textoLimpo.split(/\s+/);
        let posLocal = posInicio;
        
        for (const palavra of palavras) {
          if (palavra.length >= 2) {
            roteiroPalavras.push({
              palavra: palavra,
              posicao: posLocal,
              tamanho: palavra.length,
              elemento: node.parentElement,
              node: node,
              index: palavraIndex++
            });
          }
          posLocal += palavra.length + 1;
        }
      }
    }

    // Cria índice invertido para busca O(1)
    palavrasIndex = new Map();
    roteiroPalavras.forEach((item, idx) => {
      const chave = item.palavra.substring(0, 3);  // Primeiros 3 chars como chave
      if (!palavrasIndex.has(chave)) {
        palavrasIndex.set(chave, []);
      }
      palavrasIndex.get(chave).push(idx);
    });

    console.log(`🎤 Roteiro indexado: ${roteiroTexto.length} chars, ${roteiroPalavras.length} palavras`);
  }

  // ============================================================
  // BUSCA PROGRESSIVA COM LOOKAHEAD (PRECISA E SEM PULOS)
  // ============================================================

  // Última posição encontrada para evitar buscas repetidas
  let ultimaPosicaoEncontrada = -1;
  let ultimoTextoProcessado = '';
  let ultimoSegmentoIndex = -1;  // Índice do último segmento/parágrafo encontrado
  let ultimaPalavraIndex = -1;   // NOVO: índice da última palavra encontrada

  // Configurações de precisão - OTIMIZADAS para resposta rápida
  const MAX_PULO = 300;  // Janela de busca aumentada
  const MIN_PALAVRAS_PARA_PULAR_SEGMENTO = 1;  // Reduzido - mais responsivo
  const MIN_CHARS_BUSCA = 2;  // Reduzido para detectar mais rápido

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
   * Busca a posição do texto falado no roteiro
   * SIMPLIFICADO: busca sequencial na janela atual
   * @param {string} fraseFalada - Texto reconhecido pela voz
   * @returns {Object|null} Elemento encontrado ou null
   */
  function buscarNaJanela(fraseFalada) {
    if (!fraseFalada || roteiroTexto.length === 0) {
      console.log('🎤 buscarNaJanela: roteiro vazio ou frase nula');
      return null;
    }

    const fraseLimpa = normalizarTexto(fraseFalada);
    if (fraseLimpa.length < MIN_CHARS_BUSCA) {
      console.log('🎤 buscarNaJanela: frase muito curta:', fraseLimpa.length);
      return null;
    }

    // Pega as últimas palavras faladas
    const palavras = fraseLimpa.split(/\s+/).filter(p => p.length >= 2);
    if (palavras.length === 0) {
      console.log('🎤 buscarNaJanela: sem palavras válidas');
      return null;
    }

    // Busca a partir da posição atual
    const inicioJanela = Math.max(0, currentIndex - 20);
    const fimJanela = Math.min(roteiroTexto.length, currentIndex + LOOKAHEAD_CHARS);
    const janela = roteiroTexto.substring(inicioJanela, fimJanela);
    
    console.log('🎤 buscarNaJanela: buscando palavras:', palavras.slice(-3).join(', '), 'em janela de', inicioJanela, 'a', fimJanela);

    // Tenta encontrar cada palavra na janela (da mais recente para trás)
    for (let i = palavras.length - 1; i >= 0; i--) {
      const palavra = palavras[i];
      const posNaJanela = janela.indexOf(palavra);
      
      if (posNaJanela !== -1) {
        const posAbsoluta = inicioJanela + posNaJanela;
        
        // Só avança se for para frente
        if (posAbsoluta > ultimaPosicaoEncontrada || ultimaPosicaoEncontrada === -1) {
          // Encontra o elemento DOM correspondente
          const segmento = roteiroElementos.find(s => 
            posAbsoluta >= s.inicio && posAbsoluta <= s.fim
          );
          
          if (segmento) {
            console.log('🎤 buscarNaJanela: encontrou "' + palavra + '" na posição', posAbsoluta);
            ultimaPosicaoEncontrada = posAbsoluta;
            currentIndex = posAbsoluta + palavra.length;
            
            return {
              elemento: segmento.elemento,
              posicao: posAbsoluta,
              termo: palavra
            };
          } else {
            console.log('🎤 buscarNaJanela: palavra encontrada mas sem elemento DOM correspondente');
          }
        } else {
          console.log('🎤 buscarNaJanela: palavra "' + palavra + '" ignorada (posição', posAbsoluta, '<= última', ultimaPosicaoEncontrada, ')');
        }
      }
    }

    return null;
  }

  /**
   * Processa o texto reconhecido e rola o prompter se necessário
   * OTIMIZADO: Processa imediatamente sem esperas
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

    // Mostra feedback visual de que está detectando fala
    notificarRenderer('partial', textoReconhecido);
    
    // DEBUG: Log do texto reconhecido
    console.log('🎤 Texto reconhecido:', textoReconhecido, isFinal ? '(final)' : '(parcial)');

    const resultado = buscarNaJanela(textoReconhecido);

    if (resultado) {
      // Encontrou! Rola o prompter para o elemento
      console.log('🎤 MATCH encontrado:', resultado.termo, 'pos:', resultado.posicao);
      rolarParaElemento(resultado.elemento, resultado.posicao, resultado.termo);
      notificarRenderer('match', {
        texto: textoReconhecido,
        termo: resultado.termo,
        posicao: resultado.posicao
      });
    } else if (isFinal && textoReconhecido.trim().length > 5) {
      // Improviso - apenas loga (ignora frases muito curtas)
      console.log('🎤 Nenhum match encontrado para:', textoReconhecido);
      notificarRenderer('improviso', textoReconhecido);
    }
  }

  // Variáveis para controle de scroll suave do VOSK
  let scrollAtualVosk = 0;
  let scrollAlvoVosk = 0;
  let animacaoScrollVosk = null;
  let ultimaPalavraDestacada = null;  // NOVO: referência à última palavra destacada

  /**
   * Rola o prompter suavemente até um elemento específico
   * SEMPRE PARA FRENTE - nunca volta
   * NOVO: Destaca a palavra específica sendo falada
   * @param {HTMLElement} elemento - Elemento alvo
   * @param {number} posicaoTexto - Posição no texto (para cálculo de progresso)
   * @param {string} palavraFalada - Palavra que está sendo falada (para destaque)
   */
  function rolarParaElemento(elemento, posicaoTexto, palavraFalada) {
    if (!elemento) {
      console.log('🎤 rolarParaElemento: elemento nulo');
      return;
    }

    const container = document.querySelector('.prompter-in-control');
    if (!container) {
      console.log('🎤 rolarParaElemento: container não encontrado');
      return;
    }

    console.log('🎤 rolarParaElemento: rolando para elemento, palavra:', palavraFalada);

    // Remove destaque anterior
    document.querySelectorAll('.lendo-agora').forEach(el => {
      el.classList.remove('lendo-agora');
    });
    
    // Remove destaque de palavra anterior
    if (ultimaPalavraDestacada) {
      ultimaPalavraDestacada.remove();
      ultimaPalavraDestacada = null;
    }

    // Adiciona destaque ao elemento atual
    elemento.classList.add('lendo-agora');
    
    // NOVO: Tenta destacar a palavra específica
    if (palavraFalada && palavraFalada.length >= 2) {
      destacarPalavraNoElemento(elemento, palavraFalada);
    }

    // Calcula posição alvo para scroll
    const containerRect = container.getBoundingClientRect();
    const elementoRect = elemento.getBoundingClientRect();

    // Posiciona o elemento a 30% do topo do container (na altura do cue marker)
    const novoAlvo =
      elementoRect.top - containerRect.top +
      scrollAtualVosk -
      containerRect.height * 0.3;

    console.log('🎤 rolarParaElemento: scrollAtual:', scrollAtualVosk, 'novoAlvo:', novoAlvo, 'scrollAlvo atual:', scrollAlvoVosk);

    // SÓ ATUALIZA SE FOR PARA FRENTE (nunca volta)
    if (novoAlvo > scrollAlvoVosk) {
      scrollAlvoVosk = novoAlvo;
      console.log('🎤 rolarParaElemento: atualizou scrollAlvoVosk para:', scrollAlvoVosk);
    }

    // Inicia animação suave se não estiver rodando
    if (!animacaoScrollVosk) {
      console.log('🎤 rolarParaElemento: iniciando animação de scroll');
      animarScrollVosk(container);
    }
  }

  /**
   * NOVO: Destaca uma palavra específica dentro de um elemento
   */
  function destacarPalavraNoElemento(elemento, palavra) {
    if (!elemento || !palavra) return;

    const textoElemento = elemento.textContent;
    const palavraNormalizada = normalizarTexto(palavra);
    const textoNormalizado = normalizarTexto(textoElemento);

    // Encontra a posição da palavra no texto normalizado
    const posNormalizada = textoNormalizado.indexOf(palavraNormalizada);
    if (posNormalizada === -1) return;

    // Mapeia de volta para o texto original
    // Conta caracteres ignorando acentos/pontuação
    let posOriginal = 0;
    let contadorNormalizado = 0;

    for (let i = 0; i < textoElemento.length && contadorNormalizado < posNormalizada; i++) {
      const charNorm = normalizarTexto(textoElemento[i]);
      if (charNorm) contadorNormalizado += charNorm.length;
      posOriginal = i + 1;
    }

    // Encontra o fim da palavra
    let fimOriginal = posOriginal;
    let tamanhoPalavra = 0;
    while (fimOriginal < textoElemento.length && tamanhoPalavra < palavra.length + 2) {
      const char = textoElemento[fimOriginal];
      if (/\s/.test(char)) break;
      fimOriginal++;
      tamanhoPalavra++;
    }

    // Cria o highlight visual usando um span overlay
    try {
      const range = document.createRange();
      const treeWalker = document.createTreeWalker(elemento, NodeFilter.SHOW_TEXT);
      let node;
      let charCount = 0;

      while ((node = treeWalker.nextNode())) {
        const nodeLen = node.nodeValue.length;
        if (charCount + nodeLen > posOriginal) {
          const offsetInicio = posOriginal - charCount;
          const offsetFim = Math.min(offsetInicio + palavra.length + 2, nodeLen);

          range.setStart(node, offsetInicio);
          range.setEnd(node, offsetFim);

          // Cria span de destaque
          const highlight = document.createElement('span');
          highlight.className = 'palavra-atual-vosk';
          highlight.style.cssText = `
            background: linear-gradient(180deg, transparent 60%, rgba(255, 215, 0, 0.5) 60%);
            border-radius: 2px;
            padding: 0 2px;
            margin: 0 -2px;
          `;

          try {
            range.surroundContents(highlight);
            ultimaPalavraDestacada = highlight;
          } catch (e) {
            // Range cruza nós - ignora destaque
          }
          break;
        }
        charCount += nodeLen;
      }
    } catch (e) {
      // Erro ao criar range - ignora
    }
  }

  /**
   * Anima o scroll de forma CONTÍNUA E SUAVE
   * Movimento sempre para frente, sem pulos ou trepidações
   * OTIMIZADO: Velocidade aumentada para acompanhar fala
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
      // Velocidade ADAPTATIVA RÁPIDA: responde mais rápido à fala
      // Fator aumentado de 0.12 para 0.18 e máximo de 4 para 8
      const velocidadeBase = Math.min(diferenca * 0.18, 8);
      const velocidadeMinima = 1.5;  // Aumentado de 1 para 1.5
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

        // IMPORTANTE: Sincroniza posição do VOSK com scroll atual
        if (typeof ScrollEngine !== 'undefined') {
          scrollAtualVosk = ScrollEngine.decimalScroll || 0;
          scrollAlvoVosk = scrollAtualVosk;
          console.log('🎤 Sincronizado com scroll atual:', scrollAtualVosk);
        }

        // Inicia o reconhecimento VOSK
        const sucesso = await iniciarReconhecimento();
        if (sucesso) {
          isActive = true;
          console.log('🎤 Voice Tracking INICIADO (VOSK Browser)');
          console.log('🎤 Roteiro:', roteiroTexto.length, 'chars,', roteiroElementos.length, 'elementos');
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
      ultimaPalavraIndex = -1;  // NOVO: reseta índice de palavras

      // Remove destaques
      document.querySelectorAll('.lendo-agora').forEach(el => {
        el.classList.remove('lendo-agora');
      });
      
      // Remove destaque de palavra
      document.querySelectorAll('.palavra-atual-vosk').forEach(el => {
        // Restaura o texto original
        const parent = el.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(el.textContent), el);
          parent.normalize();  // Junta nós de texto adjacentes
        }
      });
      ultimaPalavraDestacada = null;

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
    ultimaPalavraIndex = -1;  // NOVO
    scrollAtualVosk = 0;
    scrollAlvoVosk = 0;
    
    // Remove destaque de palavra
    if (ultimaPalavraDestacada) {
      ultimaPalavraDestacada.remove();
      ultimaPalavraDestacada = null;
    }
    
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
