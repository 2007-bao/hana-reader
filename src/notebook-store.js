export const NOTEBOOK_STORE_VERSION = 2;

export function createNotebook(title = '阅读笔记', now = Date.now()) {
  return {
    id: `notebook-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(title || '阅读笔记').slice(0, 80),
    text: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function loadNotebookStore(storage, key, now = Date.now()) {
  const fallback = { version: NOTEBOOK_STORE_VERSION, activeId: null, notebooks: [createNotebook('阅读笔记', now)] };
  try {
    const raw = storage?.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    if (typeof value === 'string') {
      const notebook = createNotebook('阅读笔记', now);
      notebook.text = value;
      return { ...fallback, activeId: notebook.id, notebooks: [notebook] };
    }
    if (Array.isArray(value)) {
      const notebooks = normalizeNotebooks(value, now);
      return { ...fallback, activeId: notebooks[0]?.id || null, notebooks: notebooks.length ? notebooks : fallback.notebooks };
    }
    const notebooks = normalizeNotebooks(value?.notebooks, now);
    if (!notebooks.length && typeof value?.text === 'string') {
      const notebook = createNotebook('阅读笔记', now);
      notebook.text = value.text;
      return { ...fallback, activeId: notebook.id, notebooks: [notebook] };
    }
    const activeId = notebooks.some((item) => item.id === value?.activeId) ? value.activeId : notebooks[0]?.id;
    return { version: NOTEBOOK_STORE_VERSION, activeId, notebooks: notebooks.length ? notebooks : fallback.notebooks };
  } catch {
    return fallback;
  }
}

export function saveNotebookStore(storage, key, store) {
  try {
    storage?.setItem(key, JSON.stringify({
      version: NOTEBOOK_STORE_VERSION,
      activeId: store?.activeId || null,
      notebooks: normalizeNotebooks(store?.notebooks),
    }));
    return true;
  } catch {
    return false;
  }
}

export function normalizeNotebooks(value, now = Date.now()) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `notebook-${now}-${index}`,
      title: String(item.title || `笔记 ${index + 1}`).slice(0, 80),
      text: typeof item.text === 'string' ? item.text : '',
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || now,
    }));
}

export function appendNotebookReference(notebook, { fileName = '当前文件', quote = '', note = '' } = {}, now = Date.now()) {
  if (!notebook) return null;
  const cleanQuote = String(quote || '').replace(/\s+/g, ' ').trim();
  const cleanNote = String(note || '').trim();
  const lines = [`\n\n### ${fileName}`];
  if (cleanQuote) lines.push(`> ${cleanQuote.replace(/\n/g, '\n> ')}`);
  if (cleanNote) lines.push(cleanNote);
  const nextText = `${notebook.text || ''}${lines.join('\n')}\n`;
  return { ...notebook, text: nextText, updatedAt: now };
}
