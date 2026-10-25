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

  // Um trecho de linhas removidas (R) e adicionadas (A) no mesmo ponto do documento.
  // Cada linha do resultado informa quantas linhas do texto antigo (oldN) e do novo (newN) cobre,
  // para quem for aplicar as mudanças (applyTextChanges) andar nos dois textos em paralelo.
  function resolveRun(removed, added, rows) {
    const pushRemoved = (text) => rows.push({ type: 'removed', text, oldN: 1, newN: 0 });
    const pushAdded = (text) => rows.push({ type: 'added', text, oldN: 0, newN: 1 });
    const pushChanged = (oldStr, newStr, oldN, newN, merged, newLines) => rows.push({
      type: 'changed', parts: wordParts(oldStr, newStr), oldText: oldStr, newText: newStr, oldN, newN, merged, newLines
    });

    if (!removed.length) {
      added.forEach(pushAdded);
      return;
    }
    if (!added.length) {
      removed.forEach(pushRemoved);
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
          pushChanged(joinedOld, joinedNew, removed.length, added.length, true, added);
          return;
        }
      }
    }

    if (!pairs.length) {
      removed.forEach(pushRemoved);
      added.forEach(pushAdded);
      return;
    }

    let ri = 0;
    let ai = 0;
    pairs.forEach((p) => {
      for (; ri < p.ri; ri++) pushRemoved(removed[ri]);
      for (; ai < p.ai; ai++) pushAdded(added[ai]);
      pushChanged(removed[p.ri], added[p.ai], 1, 1, false);
      ri = p.ri + 1;
      ai = p.ai + 1;
    });
    for (; ri < removed.length; ri++) pushRemoved(removed[ri]);
    for (; ai < added.length; ai++) pushAdded(added[ai]);
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
        part.value.forEach((text) => rows.push({ type: 'same', text, oldN: 1, newN: 1 }));
      }
    }
    flush();

    // Trechos que só mudaram de quebra de linha/parágrafo não têm diferença de palavras
    rows.forEach((row, i) => {
      if (row.type === 'changed' && row.parts.every((p) => p.type === 'same')) {
        rows[i] = { type: 'same', text: row.newText, oldN: row.oldN, newN: row.newN };
      }
    });

    const stats = { added: 0, removed: 0, changed: 0, same: 0 };
    rows.forEach((r) => { stats[r.type]++; });
    stats.identical = !stats.added && !stats.removed && !stats.changed;
    return { rows, stats };
  }

  // ------------------------------------------------------------------------------------------
  // APLICAR MUDANÇAS: leva o TEXTO de outra versão para o documento, mexendo só no que mudou.
  // Parágrafos iguais não são tocados (formatação intacta); removidos saem; novos entram como
  // parágrafo; editados trocam só as palavras alteradas (o texto novo herda a formatação do ponto).
  // ------------------------------------------------------------------------------------------

  const BLANK = /[\s\u200b]/;

  // Linhas de texto de um elemento, com os nós de texto de cada uma (mesma regra de htmlToDiffText)
  function extractLines(rootEl) {
    const lines = [];
    let nodes = [];
    const finish = (br) => {
      const text = normalizeLine(nodes.map((n) => n.nodeValue).join(''));
      if (text && !PAGE_MARKER.test(text)) lines.push({ text, nodes, br: br || null, block: null, idx: lines.length });
      nodes = [];
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        nodes.push(node);
        return;
      }
      if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) return;
      if (node.tagName === 'BR') {
        finish(node);
        return;
      }
      const block = BLOCK_TAGS.has(node.tagName);
      if (block) finish();
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (block) finish();
    };
    walk(rootEl);
    lines.forEach((line) => {
      const first = line.nodes.find((n) => n.nodeValue.trim());
      let el = first ? first.parentNode : rootEl;
      while (el && el !== rootEl && !BLOCK_TAGS.has(el.tagName)) el = el.parentNode;
      line.block = el || rootEl;
    });
    return lines;
  }

  // posição (nó de texto + offset) de cada caractere do texto normalizado da linha
  function charMap(line) {
    const map = [];
    const blank = [];
    let prevBlank = true;
    line.nodes.forEach((node) => {
      const s = node.nodeValue;
      for (let i = 0; i < s.length; i++) {
        const isBlank = BLANK.test(s[i]);
        if (isBlank && prevBlank) continue;
        map.push({ node, off: i });
        blank.push(isBlank);
        prevBlank = isBlank;
      }
    });
    if (blank.length && blank[blank.length - 1]) map.pop();
    return map;
  }

  // Edições por palavra (índices no texto antigo normalizado)
  function wordEdits(oldStr, newStr) {
    const parts = root.Diff.diffArrays(oldStr.split(' '), newStr.split(' '));
    const edits = [];
    let pos = 0;
    for (let k = 0; k < parts.length; k++) {
      let p = parts[k];
      if (!p.added && !p.removed) {
        pos += p.value.join(' ').length + 1;
        continue;
      }
      let rem = null;
      let add = null;
      if (p.removed) rem = p; else add = p;
      const next = parts[k + 1];
      if (next && ((rem && next.added) || (add && next.removed))) {
        if (rem) add = next; else rem = next;
        k++;
      }
      const insert = add ? add.value.join(' ') : '';
      if (rem) {
        const start = pos;
        const end = pos + rem.value.join(' ').length;
        if (add) {
          edits.push({ start, end, insert });
        } else if (end < oldStr.length) {
          edits.push({ start, end: end + 1, insert: '' });
        } else {
          edits.push({ start: Math.max(0, start - 1), end, insert: '' });
        }
        pos = end + 1;
      } else if (pos < oldStr.length) {
        edits.push({ start: pos, end: pos, insert: insert + ' ' });
      } else {
        edits.push({ start: oldStr.length, end: oldStr.length, insert: ' ' + insert });
      }
    }
    return edits;
  }

  function editLine(line, row, doc) {
    const map = charMap(line);
    if (map.length !== line.text.length) return false;
    const edits = wordEdits(row.oldText, row.newText);
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      if (e.end > e.start) {
        const range = doc.createRange();
        range.setStart(map[e.start].node, map[e.start].off);
        range.setEnd(map[e.end - 1].node, map[e.end - 1].off + 1);
        range.deleteContents();
      }
      if (e.insert) {
        if (e.start < map.length) map[e.start].node.insertData(map[e.start].off, e.insert);
        else map[map.length - 1].node.appendData(e.insert);
      }
    }
    // nós que ficaram vazios (ex.: <span> inteiro apagado) não devem sobrar no HTML
    line.nodes.forEach((n) => {
      if (n.nodeValue === '' && n.parentNode) {
        const parent = n.parentNode;
        n.remove();
        removeEmptyAncestors(parent, line.block);
      }
    });
    return true;
  }

  function removeEmptyAncestors(el, container) {
    let parent = el;
    while (parent && parent !== container && !parent.firstChild) {
      const up = parent.parentNode;
      parent.remove();
      parent = up;
    }
  }

  function removeLine(line, lines, container) {
    const blk = line.block;
    if (blk !== container && normalizeLine(blk.textContent) === line.text) {
      const parent = blk.parentNode;
      blk.remove();
      removeEmptyAncestors(parent, container);
      return;
    }
    const parents = line.nodes.map((n) => n.parentNode);
    line.nodes.forEach((n) => n.remove());
    if (line.br) {
      line.br.remove();
    } else {
      const prev = lines[line.idx - 1];
      if (prev && prev.block === blk && prev.br) prev.br.remove();
    }
    parents.forEach((p) => removeEmptyAncestors(p, container));
  }

  // Parágrafo novo entra sem estilos herdados (só o tipo: <li> dentro de lista, senão <p>)
  function newBlockLike(block, container, doc) {
    return doc.createElement(block && block !== container && block.tagName === 'LI' ? 'li' : 'p');
  }

  // Insere uma linha nova logo depois de `anchor`; devolve o novo anchor
  function insertAfter(anchor, text, lines, container, doc) {
    if (!anchor) {
      const el = doc.createElement('p');
      el.textContent = text;
      container.insertBefore(el, container.firstChild);
      return { kind: 'block', el };
    }
    if (anchor.kind === 'block') {
      const el = newBlockLike(anchor.el, container, doc);
      el.textContent = text;
      anchor.el.after(el);
      return { kind: 'block', el };
    }

    const inlineAfter = (ref) => {
      const t = doc.createTextNode(text);
      if (ref.nodeType === 1 && ref.tagName === 'BR') {
        const br = doc.createElement('br');
        ref.after(t);
        t.after(br);
        return { kind: 'inline', ref: br };
      }
      const br = doc.createElement('br');
      ref.after(br);
      br.after(t);
      return { kind: 'inline', ref: t };
    };

    if (anchor.kind === 'inline') return inlineAfter(anchor.ref);

    const L = anchor.line;
    const nextLine = lines[L.idx + 1];
    const lastInBlock = !(nextLine && nextLine.block === L.block);
    if (L.block === container || !lastInBlock) {
      return inlineAfter(L.br || L.nodes[L.nodes.length - 1]);
    }
    const el = newBlockLike(L.block, container, doc);
    el.textContent = text;
    L.block.after(el);
    return { kind: 'block', el };
  }

  /**
   * Leva o texto `sourceText` (htmlToDiffText) para dentro de `container` (elemento com o HTML
   * formatado), alterando só o necessário.
   * @returns {{stats, verified: boolean, html: string}} verified = o texto final bate com sourceText
   */
  function applyTextChanges(container, sourceText) {
    const doc = container.ownerDocument;
    const lines = extractLines(container);
    const { rows, stats } = buildDiffRows(lines.map((l) => l.text).join('\n'), sourceText);
    if (stats.identical) return { rows, stats, verified: true, html: container.innerHTML };

    let fi = 0;
    let anchor = null;
    rows.forEach((row) => {
      if (row.type === 'same') {
        fi += row.oldN;
        if (lines[fi - 1]) anchor = { kind: 'line', line: lines[fi - 1] };
      } else if (row.type === 'removed') {
        removeLine(lines[fi++], lines, container);
      } else if (row.type === 'added') {
        anchor = insertAfter(anchor, row.text, lines, container, doc);
      } else if (row.merged && row.oldN > 1) {
        for (let i = 0; i < row.oldN; i++) removeLine(lines[fi++], lines, container);
        row.newLines.forEach((text) => { anchor = insertAfter(anchor, text, lines, container, doc); });
      } else {
        const line = lines[fi++];
        editLine(line, row, doc);
        anchor = { kind: 'line', line };
      }
    });

    const html = container.innerHTML;
    const finalText = htmlToDiffText(html);
    const verified = buildDiffRows(finalText, sourceText).stats.identical;
    return { rows, stats, verified, html };
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

  const api = { htmlToDiffText, buildDiffRows, renderRows, extractLines, applyTextChanges };
  root.PromptiqVersionDiff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
