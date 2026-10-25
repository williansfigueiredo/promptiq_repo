// ============================================================
// version-diff.js
// ============================================================
// DESCRIÇÃO: Núcleo da comparação do "Version History" (documentos abertos, abas e importados).
// FUNÇÃO:
//   1) htmlToDiffText: converte QUALQUER origem (HTML do editor, HTML do Word, texto puro de
//      PDF/DOC/TXT) em texto normalizado: um parágrafo por linha, espaços colapsados, sem linhas
//      vazias. Antes cada origem tinha um formato (innerText com linhas em branco, HTML cru,
//      texto numa linha só...), então o diff comparava "coisas diferentes" e marcava tudo.
//   2) buildDiffRows: compara por PARÁGRAFO e, dentro dos parágrafos parecidos, por PALAVRA.
//      Resultado: linhas iguais / removidas / adicionadas / alteradas (com trechos de palavras).
// Usa a biblioteca global `Diff` (jsdiff), carregada em index.html.
// ============================================================

(function (root) {
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE',
    'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'DT', 'DD', 'HR'
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'NOSCRIPT']);

  // Marcadores de página que o leitor de PDF insere ("-- 1 of 3 --") não são texto do roteiro
  const PAGE_MARKER = /^--\s*\d+\s+of\s+\d+\s*--$/i;

  function normalizeLine(line) {
    return line.replace(/[\u00a0\u2007\u202f\u200b\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function linesToParagraphs(raw) {
    return raw
      .split('\n')
      .map(normalizeLine)
      .filter((l) => l.length > 0 && !PAGE_MARKER.test(l));
  }

  function htmlToDiffText(input) {
    const source = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
    if (!source.trim()) return '';

    // Texto puro (PDF, DOC, TXT): as quebras de linha já são as do arquivo
    if (!/<\/?[a-z][^>]*>/i.test(source)) {
      return linesToParagraphs(source).join('\n');
    }

    const doc = new DOMParser().parseFromString(source, 'text/html');
    let out = '';
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue.replace(/\n/g, ' ');
        return;
      }
      if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) return;
      if (node.tagName === 'BR') {
        out += '\n';
        return;
      }
      const block = BLOCK_TAGS.has(node.tagName);
      if (block) out += '\n';
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (block) out += '\n';
    };
    walk(doc.body || doc.documentElement);
    return linesToParagraphs(out).join('\n');
  }

  // 0..1: fração do texto que as duas linhas têm em comum (por palavra)
  function similarity(a, b) {
    if (a === b) return 1;
    const total = a.length + b.length;
    if (!total) return 1;
    let common = 0;
    for (const part of root.Diff.diffWords(a, b)) {
      if (!part.added && !part.removed) common += part.value.trim().length;
    }
    return (2 * common) / total;
  }

  const PAIR_THRESHOLD = 0.4;
  const MERGE_THRESHOLD = 0.5;
  const LOOKAHEAD = 30;
  const MAX_JOINED = 200000;

  function wordParts(oldStr, newStr) {
    return root.Diff.diffWords(oldStr, newStr).map((p) => ({
      type: p.added ? 'added' : p.removed ? 'removed' : 'same',
      text: p.value
    }));
  }

  // Um trecho de linhas removidas (R) e adicionadas (A) no mesmo ponto do documento
  function resolveRun(removed, added, rows) {
    if (!removed.length) {
      added.forEach((text) => rows.push({ type: 'added', text }));
      return;
    }
    if (!added.length) {
      removed.forEach((text) => rows.push({ type: 'removed', text }));
      return;
    }

    const pairs = [];
    let pairedCommon = 0;
    let nextAdded = 0;
    removed.forEach((r, ri) => {
      let found = -1;
      let foundSim = 0;
      const limit = Math.min(added.length, nextAdded + LOOKAHEAD);
      for (let ai = nextAdded; ai < limit; ai++) {
        const sim = similarity(r, added[ai]);
        if (sim >= PAIR_THRESHOLD) {
          found = ai;
          foundSim = sim;
          break;
        }
      }
      if (found >= 0) {
        pairs.push({ ri, ai: found });
        pairedCommon += (foundSim * (r.length + added[found].length)) / 2;
        nextAdded = found + 1;
      }
    });

    // O mesmo texto pode estar apenas parágrafado diferente (ex.: linhas quebradas de PDF contra
    // parágrafos do editor). Se os trechos inteiros se parecem BEM mais do que os pares de
    // parágrafos explicam, compara os trechos como um bloco só.
    if (removed.length > 1 || added.length > 1) {
      const joinedOld = removed.join(' ');
      const joinedNew = added.join(' ');
      if (joinedOld.length + joinedNew.length <= MAX_JOINED) {
        const joinedSim = similarity(joinedOld, joinedNew);
        const pairedSim = (2 * pairedCommon) / (joinedOld.length + joinedNew.length);
        if (joinedSim >= MERGE_THRESHOLD && joinedSim - pairedSim >= 0.15) {
          rows.push({ type: 'changed', parts: wordParts(joinedOld, joinedNew) });
          return;
        }
      }
    }

    if (!pairs.length) {
      removed.forEach((text) => rows.push({ type: 'removed', text }));
      added.forEach((text) => rows.push({ type: 'added', text }));
      return;
    }

    let ri = 0;
    let ai = 0;
    pairs.forEach((p) => {
      for (; ri < p.ri; ri++) rows.push({ type: 'removed', text: removed[ri] });
      for (; ai < p.ai; ai++) rows.push({ type: 'added', text: added[ai] });
      rows.push({ type: 'changed', parts: wordParts(removed[p.ri], added[p.ai]) });
      ri = p.ri + 1;
      ai = p.ai + 1;
    });
    for (; ri < removed.length; ri++) rows.push({ type: 'removed', text: removed[ri] });
    for (; ai < added.length; ai++) rows.push({ type: 'added', text: added[ai] });
  }

  /**
   * @param {string} oldText texto normalizado (htmlToDiffText) da 1ª versão
   * @param {string} newText texto normalizado da 2ª versão
   * @returns {{rows: Array, stats: {added:number, removed:number, changed:number, same:number, identical:boolean}}}
   */
  function buildDiffRows(oldText, newText) {
    const oldLines = oldText ? oldText.split('\n') : [];
    const newLines = newText ? newText.split('\n') : [];
    const rows = [];

    let removed = [];
    let added = [];
    const flush = () => {
      resolveRun(removed, added, rows);
      removed = [];
      added = [];
    };

    for (const part of root.Diff.diffArrays(oldLines, newLines)) {
      if (part.removed) {
        removed = removed.concat(part.value);
      } else if (part.added) {
        added = added.concat(part.value);
      } else {
        flush();
        part.value.forEach((text) => rows.push({ type: 'same', text }));
      }
    }
    flush();

    // Trechos que só mudaram de quebra de linha/parágrafo não têm diferença de palavras
    rows.forEach((row, i) => {
      if (row.type === 'changed' && row.parts.every((p) => p.type === 'same')) {
        rows[i] = { type: 'same', text: row.parts.map((p) => p.text).join('') };
      }
    });

    const stats = { added: 0, removed: 0, changed: 0, same: 0 };
    rows.forEach((r) => { stats[r.type]++; });
    stats.identical = !stats.added && !stats.removed && !stats.changed;
    return { rows, stats };
  }

  function renderRows(rows, doc) {
    const frag = doc.createDocumentFragment();
    const add = (cls, text) => {
      const span = doc.createElement('span');
      if (cls) span.className = cls;
      span.textContent = text;
      return span;
    };
    rows.forEach((row) => {
      const line = doc.createElement('div');
      line.className = 'diff-row diff-row-' + row.type;
      line.style.cssText = 'margin-bottom:0.5em;';
      if (row.type === 'same') {
        line.textContent = row.text;
      } else if (row.type === 'added') {
        line.appendChild(add('diff-inline-added', row.text));
      } else if (row.type === 'removed') {
        line.appendChild(add('diff-inline-removed', row.text));
      } else {
        row.parts.forEach((p) => {
          line.appendChild(add(
            p.type === 'added' ? 'diff-inline-added' : p.type === 'removed' ? 'diff-inline-removed' : '',
            p.text
          ));
        });
      }
      frag.appendChild(line);
    });
    return frag;
  }

  const api = { htmlToDiffText, buildDiffRows, renderRows };
  root.PromptiqVersionDiff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
