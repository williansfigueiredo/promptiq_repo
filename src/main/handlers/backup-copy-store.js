// ============================================================
// backup-copy-store.js
// ============================================================
// DESCRIÇÃO: Cópia em arquivo dos documentos que o computador BACKUP recebe do PRIMARY.
// FUNÇÃO: sem isto o espelho só existia na memória do app: se o backup fechasse ou travasse junto
//         com o principal, o roteiro se perdia. Aqui cada documento vira um .ptq normal:
//   <base>\<Nome>.ptq                       -> versão mais recente espelhada
//   <base>\Versions\<Nome>\<data-hora>.ptq  -> versões anteriores (as últimas N)
//   <base>\Edited on backup\<Nome> (edited <data-hora>).ptq
//                                           -> o que foi editado NO backup (nunca sobrescrito pelo espelho)
// Só usa o sistema de arquivos (sem Electron), então é testável isoladamente.
// ============================================================

const fs = require('fs');
const path = require('path');

const MAX_HTML_LENGTH = 20 * 1024 * 1024;
const MAX_EDITED_FILES = 30;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function safeName(name, fallback = 'Untitled') {
  let n = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.(ptq|txt|html?|docx?|pdf|rtf)$/i, '')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  if (n.length > 80) n = n.slice(0, 80).trim();
  if (!n || RESERVED.test(n)) n = fallback;
  return n;
}

function pad(n) { return String(n).padStart(2, '0'); }

// Data/hora LOCAL (o nome dos backups automáticos usa UTC, o que confunde)
function localStamp(date, withSeconds) {
  const d = date instanceof Date ? date : new Date(date);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return withSeconds ? `${base}-${pad(d.getSeconds())}` : base;
}

// Para na primeira letra encontrada: não percorre o roteiro inteiro só para saber se não está vazio
function hasText(html) {
  const re = /(?:^|>)([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].replace(/&nbsp;/g, '').trim()) return true;
  }
  return false;
}

function serialize(html, name, now) {
  return JSON.stringify({
    content: html,
    metadata: {
      version: '1.0',
      createdAt: new Date(now).toISOString(),
      app: 'PromptIQ',
      format: 'rich-text-html',
      source: 'backup-sync',
      name
    }
  });
}

function parseHtml(raw) {
  try {
    const data = JSON.parse(raw);
    return typeof data.content === 'string' ? data.content : null;
  } catch (_) {
    return null;
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function createCopyStore(options) {
  const baseDir = options.baseDir;
  const maxVersions = options.maxVersions || 10;
  const snapshotMs = options.snapshotMs == null ? 2 * 60 * 1000 : options.snapshotMs;
  const now = options.now || (() => Date.now());

  const assigned = new Map(); // key do PRIMARY -> nome de arquivo (sem extensão) nesta execução
  const written = new Map();  // key -> { file, last, snapshotAt }

  // Dois documentos com o mesmo nome não podem escrever no mesmo arquivo
  function assignName(key, name) {
    const base = safeName(name);
    const taken = new Set();
    assigned.forEach((value, k) => { if (k !== key) taken.add(value.toLowerCase()); });
    let candidate = base;
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base} (${i})`;
    assigned.set(key, candidate);
    return candidate;
  }

  function validDoc(doc) {
    return doc && typeof doc.key === 'string' && typeof doc.html === 'string' &&
      doc.html.length <= MAX_HTML_LENGTH && hasText(doc.html);
  }

  function archive(name, srcFile) {
    const dir = path.join(baseDir, 'Versions', name);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = localStamp(now(), true);
    let file = path.join(dir, `${stamp}.ptq`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${stamp}-${i}.ptq`);
    fs.copyFileSync(srcFile, file);

    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.ptq')).sort();
    all.slice(0, Math.max(0, all.length - maxVersions)).forEach((f) => {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* arquivo em uso: fica para a próxima */ }
    });
  }

  function saveMirrorDoc(doc) {
    const name = assignName(doc.key, doc.name);
    const file = path.join(baseDir, `${name}.ptq`);
    const st = written.get(doc.key);
    if (st && st.file === file && st.last === doc.html) return 'unchanged';

    fs.mkdirSync(baseDir, { recursive: true });
    const firstWrite = !st || st.file !== file;
    let snapshotAt = firstWrite ? now() : st.snapshotAt;

    if (firstWrite) {
      // A 1ª gravação do documento nesta execução guarda o que já existia no arquivo (pode ser um
      // roteiro de outra sessão com o mesmo nome). Só aí o arquivo é lido; depois o app já sabe o conteúdo.
      if (fs.existsSync(file)) {
        if (parseHtml(fs.readFileSync(file, 'utf8')) === doc.html) {
          written.set(doc.key, { file, last: doc.html, snapshotAt });
          return 'unchanged';
        }
        archive(name, file);
      }
    } else if (now() - snapshotAt >= snapshotMs) {
      // Depois disso, no máximo uma versão a cada snapshotMs (digitando não se criam dezenas)
      if (fs.existsSync(file)) archive(name, file);
      snapshotAt = now();
    }

    writeAtomic(file, serialize(doc.html, name, now()));
    written.set(doc.key, { file, last: doc.html, snapshotAt });
    return 'saved';
  }

  function pruneEdited(dir) {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.ptq'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(MAX_EDITED_FILES).forEach(({ f }) => {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignora */ }
    });
  }

  function saveEditedDoc(doc, session) {
    const name = assignName(doc.key, doc.name);
    const dir = path.join(baseDir, 'Edited on backup');
    const file = path.join(dir, `${name} (edited ${localStamp(session || now(), false)}).ptq`);
    const cacheKey = `edited:${doc.key}`;
    const st = written.get(cacheKey);
    if (st && st.file === file && st.last === doc.html) return 'unchanged';

    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, serialize(doc.html, name, now()));
    written.set(cacheKey, { file, last: doc.html, snapshotAt: 0 });
    pruneEdited(dir);
    return 'saved';
  }

  // Cópia de um texto que está prestes a ser substituído pelo do PRIMARY (edição que perdeu uma
  // disputa). Arquivo próprio, nunca sobrescrito por gravações posteriores.
  function saveConflictDoc(doc) {
    const name = assignName(doc.key, doc.name);
    const dir = path.join(baseDir, 'Edited on backup');
    const stamp = localStamp(now(), true);
    let file = path.join(dir, `${name} (conflict ${stamp}).ptq`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${name} (conflict ${stamp}-${i}).ptq`);

    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, serialize(doc.html, name, now()));
    pruneEdited(dir);
    return 'saved';
  }

  /**
   * @param {{kind:'mirror'|'edited', unique?:boolean, session?:string, docs:Array<{key,name,html}>}} payload
   * @returns {{ok:boolean, dir:string, saved:number, unchanged:number, skipped:number, errors:Array<{key,error}>}}
   */
  function save(payload) {
    const startedAt = Date.now();
    const result = { ok: true, dir: baseDir, saved: 0, unchanged: 0, skipped: 0, errors: [], ms: 0 };
    const docs = payload && Array.isArray(payload.docs) ? payload.docs : [];
    const edited = payload && payload.kind === 'edited';
    const unique = edited && payload.unique === true;
    const session = payload && typeof payload.session === 'string' ? payload.session : null;

    docs.forEach((doc) => {
      if (!validDoc(doc)) {
        result.skipped++;
        return;
      }
      try {
        const outcome = unique ? saveConflictDoc(doc) : edited ? saveEditedDoc(doc, session) : saveMirrorDoc(doc);
        if (outcome === 'saved') result.saved++;
        else result.unchanged++;
      } catch (err) {
        result.errors.push({ key: doc.key, error: err.message });
      }
    });
    result.ok = result.errors.length === 0;
    result.ms = Date.now() - startedAt;
    return result;
  }

  return { save, baseDir, assignName };
}

module.exports = { createCopyStore, safeName, localStamp, hasText };
