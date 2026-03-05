// ======================================================
// ✅ spellchecker.js — versão bilingue estável (PT-BR + EN)
// Autor: Willian Figueiredo + GPT-5
// ======================================================

const fs = require("fs");
const path = require("path");
let Typo = require("typo-js");

console.log('[Spellcheck] Operando em modo OFFLINE total.');

// Patch para evitar fallback pt-PT
const OriginalTypo = Typo;
Typo = function (langCode, affData, dicData, options) {
  if (langCode === "pt-BR" && options) {
    options.dictionaryPath = null;
  }
  return new OriginalTypo(langCode, affData, dicData, options);
};

// Base de dicionários
const availableDictionaries = [
  {
    code: "pt-BR",
    name: "Português (Brasil)",
    aff: path.join(__dirname, '../../../public/assets/dictionaries/pt-BR/index.aff'),
    dic: path.join(__dirname, '../../../public/assets/dictionaries/pt-BR/index.dic'),
  },
  {
    code: "en",
    name: "Inglês (EUA)",
    aff: path.join(__dirname, '../../../public/assets/dictionaries/en/index.aff'),
    dic: path.join(__dirname, '../../../public/assets/dictionaries/en/index.dic'),
  },
];

const loadedDictionaries = new Map();

/**
 * 🔹 Retorna info do idioma
 */
function getDictionaryInfo(langCode) {
  return availableDictionaries.find((d) => d.code === langCode);
}

/**
 * 🔹 Carrega o dicionário (com cache)
 */
function loadDictionary(langCode = "pt-BR") {
  if (loadedDictionaries.has(langCode)) return loadedDictionaries.get(langCode);

  const info = getDictionaryInfo(langCode);
  if (!info) {
    console.error(`[spellchecker] Idioma ${langCode} não encontrado em availableDictionaries.`);
    return null;
  }

  if (!fs.existsSync(info.aff) || !fs.existsSync(info.dic)) {
    console.error(`[spellchecker] Arquivos do dicionário ausentes para ${langCode}.`);
    return null;
  }


  try {
    const aff = fs.readFileSync(info.aff, "utf8");
    const dic = fs.readFileSync(info.dic, "utf8");
    const dictionary = new Typo(langCode, aff, dic, { platform: "node" });
    loadedDictionaries.set(langCode, dictionary);
    console.log(`[spellchecker] Dicionário carregado: ${langCode}`);
    return dictionary;
  } catch (err) {
    console.error(`[spellchecker] Erro ao carregar ${langCode}:`, err.message);
    return null;
  }
}

/**
 * 🔹 Detecta idioma automaticamente
 */
function detectLanguage(text = "") {
  if (!text || text.trim().length === 0) return "pt-BR";

  // Pega mais palavras para uma detecção mais precisa
  const samples = text.split(/\s+/).slice(0, 30);
  const ptDict = loadedDictionaries.get("pt-BR") || loadDictionary("pt-BR");
  const enDict = loadedDictionaries.get("en") || loadDictionary("en");

  let ptHits = 0,
    enHits = 0;
  let totalWords = 0;

  for (const w of samples) {
    const clean = w.replace(/[.,!?;:"'()\[\]{}–—]/g, "").trim().toLowerCase();
    if (!clean || clean.length < 2) continue;
    totalWords++;
    
    const isPt = ptDict.check(clean);
    const isEn = enDict.check(clean);
    
    // Conta apenas se a palavra existe em um dicionário e não no outro
    // Isso evita falsos positivos com palavras comuns
    if (isPt && !isEn) ptHits++;
    if (isEn && !isPt) enHits++;
    
    // Se existe em ambos, não conta (é uma palavra ambígua)
  }

  console.log(`[spellchecker] Análise: ptHits=${ptHits}, enHits=${enHits}, totalWords=${totalWords}`);

  // Se não houver correspondências significativas em nenhum dicionário,
  // o idioma provavelmente não é suportado (ex: Chinês, Japonês, etc.)
  const totalHits = ptHits + enHits;
  
  if (totalWords > 0 && totalHits === 0) {
    console.log(`[spellchecker] Idioma não suportado detectado`);
    return "unsupported";
  }

  const lang = enHits > ptHits ? "en" : "pt-BR";
  console.log(`[spellchecker] Idioma detectado: ${lang}`);
  return lang;
}

/**
 * 🔹 Executa verificação ortográfica
 */
let currentLang = 'pt-BR'; // Mantém o idioma da última verificação

function runSpellCheck(text, autoDetect = true, langCode = null) {
  // Define idioma (detectado, passado manualmente ou padrão)
  const lang = langCode || (autoDetect ? detectLanguage(text) : 'pt-BR');
  currentLang = lang; // Guarda o idioma para ser usado pelas sugestões

  // Recupera ou carrega dicionário
  let dict = loadedDictionaries.get(lang);
  if (!dict) {
    console.warn(`[SpellChecker] Dicionário ${lang} não estava no cache. Recarregando...`);
    dict = loadDictionary(lang);
    if (!dict) {
      console.error(`[SpellChecker] Falha ao carregar dicionário ${lang}.`);
      return [];
    }
  }

  const words = text.split(/\s+/).filter(Boolean);
  const results = [];

  for (const word of words) {
    if (!word.trim()) continue;
    
    // 🔹 Verifica tanto a palavra original quanto em minúsculas
    // Isso permite verificar palavras em CAIXA ALTA
    const wordLower = word.toLowerCase();
    const isCorrectOriginal = dict.check(word);
    const isCorrectLower = dict.check(wordLower);
    
    // Se nenhuma versão está correta, marca como erro
    if (!isCorrectOriginal && !isCorrectLower) {
      results.push(word);
    }
  }

  console.log(`[spellchecker] Idioma detectado: ${lang}`);
  return results;
}

/**
 * 🔹 Sugestões de correção
 */
function getSuggestions(word, langCode = null) {
  const clean = (word || '').replace(/[.,!?;:"'()]/g, '').trim();
  if (!clean) return [];

  // 🔹 Detecta o case da palavra original
  const isAllUpperCase = clean === clean.toUpperCase() && clean.length > 1;
  const isTitleCase = clean[0] === clean[0].toUpperCase() && 
                      clean.slice(1) === clean.slice(1).toLowerCase();

  // 🔹 Usa o idioma recebido do renderer ou o último detectado
  const lang = langCode || currentLang || 'pt-BR';
  console.log(`[spellchecker] → Recebido pedido de sugestões para "${clean}" em ${lang}`);

  // 🔹 Busca o dicionário certo
  let dict = loadedDictionaries.get(lang);

  if (!dict) {
    console.warn(`[spellchecker] Dicionário ${lang} não encontrado no cache, tentando carregar...`);
    dict = loadDictionary(lang);

    if (!dict) {
      console.error(`[spellchecker] ❌ Falha ao carregar dicionário ${lang}.`);
      return [];
    }
  }

  // 🔹 Gera as sugestões (sempre busca em minúsculas para melhor resultado)
  const cleanLower = clean.toLowerCase();
  let suggestions = dict.suggest(cleanLower) || [];
  
  // Se não encontrar sugestões em minúsculas, tenta com a palavra original
  if (suggestions.length === 0) {
    suggestions = dict.suggest(clean) || [];
  }

  // 🔹 Aplica o mesmo case da palavra original às sugestões
  suggestions = suggestions.map(suggestion => {
    if (isAllUpperCase) {
      return suggestion.toUpperCase();
    } else if (isTitleCase) {
      return suggestion.charAt(0).toUpperCase() + suggestion.slice(1).toLowerCase();
    }
    return suggestion;
  });

  console.log(`[spellchecker] ✅ Sugestões (${lang}) para "${clean}":`, suggestions);
  return suggestions;
}


// Carrega ambos na inicialização
loadDictionary("pt-BR");
loadDictionary("en");

module.exports = {
  detectLanguage,
  runSpellCheck,
  loadDictionary,
  getSuggestions,
};


