export const ANNOTATION_STORE_VERSION = 1;

export function annotationResourceKey(resource) {
  return stableStringify(resource || {});
}

export function loadAnnotations(storage, storageKey, resourceKey) {
  try {
    const value = JSON.parse(storage?.getItem(storageKey) || '{}');
    const entries = value?.annotations && typeof value.annotations === 'object' ? value.annotations : value;
    const list = entries?.[resourceKey];
    return Array.isArray(list) ? list.map(normalizeAnnotation).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveAnnotations(storage, storageKey, resourceKey, annotations) {
  try {
    const current = JSON.parse(storage?.getItem(storageKey) || '{}');
    const entries = current?.annotations && typeof current.annotations === 'object'
      ? current.annotations
      : {};
    entries[resourceKey] = Array.isArray(annotations) ? annotations.map(normalizeAnnotation).filter(Boolean) : [];
    storage?.setItem(storageKey, JSON.stringify({ version: ANNOTATION_STORE_VERSION, annotations: entries }));
    return true;
  } catch {
    return false;
  }
}

export function normalizeAnnotation(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.quote) return null;
  const kind = ['comment', 'highlight', 'underline'].includes(value.kind) ? value.kind : 'comment';
  return {
    id: value.id,
    kind,
    quote: String(value.quote).slice(0, 12000),
    prefix: String(value.prefix || '').slice(-120),
    suffix: String(value.suffix || '').slice(0, 120),
    note: typeof value.note === 'string' ? value.note.slice(0, 4000) : '',
    replies: Array.isArray(value.replies)
      ? value.replies.filter((reply) => reply && typeof reply.text === 'string').slice(-20).map((reply) => ({
        id: String(reply.id || `${value.id}-reply-${Math.random().toString(36).slice(2, 8)}`),
        text: reply.text.slice(0, 2000),
        createdAt: Number(reply.createdAt) || Date.now(),
      }))
      : [],
    resolved: Boolean(value.resolved),
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
