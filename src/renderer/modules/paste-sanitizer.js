// ============================================================
// paste-sanitizer.js
// ============================================================
// DESCRIÇÃO: Faz o texto colado no editor herdar o tamanho/fonte do editor.
// PROBLEMA: Ao colar de Word, sites ou outro documento, o HTML da área de transferência traz
//   font-size / font-family / line-height próprios (e <font size>, <h1>, <small>...), que valem
//   mais que o tamanho do editor — o texto colado aparecia com outro tamanho. Digitando, o texto
//   herda o tamanho do editor; aqui a colagem passa a fazer o mesmo.
// COMO: a colagem nativa do Chromium acontece normalmente (sem perda de texto) e, logo depois,
//   cada elemento NOVO criado por ela passa por cleanPastedElement().
// MANTÉM: cor do texto, negrito, itálico, sublinhado/tachado, alinhamento, listas, quebras e links.
// SEGURANÇA: o app roda com nodeIntegration; handlers on*, srcdoc e URLs "javascript:" são
//   removidos dos elementos colados.
// ============================================================

(function (root) {
  const HEADINGS = /^H[1-6]$/;
  const INHERIT_SIZE_TAGS = new Set(['BIG', 'SMALL', 'CODE', 'KBD', 'SAMP', 'TT', 'PRE']);
  const MONO_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'TT', 'PRE']);

  // Lista de permissões: do estilo colado só fica o que não mexe em tamanho/fonte/espaçamento.
  // (Tudo o mais — font-size, font-family, line-height, margens, fundo, largura, mso-* — sai.)
  const KEEP_PROP = /^(color|font-weight|font-style|text-align|text-transform|vertical-align|white-space|list-style-type|text-decoration(-line|-color|-style)?)$/;
  const KEEP_IMG_PROP = /^(width|height|max-width|max-height)$/;

  /**
   * Limpa UM elemento colado, no lugar (sem trocar nós: o desfazer do editor continua válido).
   */
  function cleanPastedElement(el) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    const isImg = tag === 'IMG';

    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'class' || name === 'id' || name.startsWith('data-') ||
        name === 'size' || name === 'face' || name === 'srcdoc' ||
        (!isImg && (name === 'width' || name === 'height'))) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|vbscript):/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    });

    if (el.style && el.style.length) {
      Array.from(el.style).forEach((prop) => {
        if (KEEP_PROP.test(prop) || (isImg && KEEP_IMG_PROP.test(prop))) return;
        el.style.removeProperty(prop);
      });
    }
    // Propriedades que o motor de CSS não reconhece (mso-*) podem sobrar no texto do atributo
    const raw = el.getAttribute('style');
    if (raw && /mso-/i.test(raw)) el.setAttribute('style', raw.replace(/mso-[a-z-]+\s*:[^;]*;?/gi, '').trim());

    // Tags cujo tamanho/fonte padrão do navegador difere do texto normal: herdam do editor
    if (HEADINGS.test(tag)) {
      el.style.fontSize = 'inherit';
      el.style.fontWeight = el.style.fontWeight || 'bold';
    } else if (INHERIT_SIZE_TAGS.has(tag)) {
      el.style.fontSize = 'inherit';
      if (MONO_TAGS.has(tag)) el.style.fontFamily = 'inherit';
    }
    if (!el.getAttribute('style')) el.removeAttribute('style');
  }

  const api = { cleanPastedElement };
  root.PromptiqPaste = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
