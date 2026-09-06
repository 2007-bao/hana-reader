const MAX_ANCHOR_CONTEXT = 120;

/**
 * Return a stable text anchor for a browser selection inside a rendered article.
 * The anchor intentionally stores quoted text instead of DOM paths so it can
 * survive a Markdown re-render and small surrounding edits.
 */
export function selectionAnchor(article, selection) {
  if (!article || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const rawQuote = selection.toString();
  const quote = rawQuote.replace(/\s+/g, ' ').trim();
  if (!quote) return null;

  const range = selection.getRangeAt(0).cloneRange();
  const articleRange = document.createRange();
  articleRange.selectNodeContents(article);
  try {
    articleRange.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  const rawPrefix = articleRange.toString();
  const rawStart = rawPrefix.length;
  const rawEnd = rawStart + rawQuote.length;
  const articleText = article.textContent || '';
  const normalizedText = articleText.replace(/\s+/g, ' ');
  const normalizedStart = Math.min(rawPrefix.replace(/\s+/g, ' ').length, normalizedText.length);
  return {
    quote,
    start: normalizedStart,
    end: normalizedStart + quote.length,
    rawStart,
    rawEnd,
    prefix: normalizedText.slice(Math.max(0, normalizedStart - MAX_ANCHOR_CONTEXT), normalizedStart),
    suffix: normalizedText.slice(normalizedStart + quote.length, normalizedStart + quote.length + MAX_ANCHOR_CONTEXT),
  };
}

/**
 * Find an annotation's quote in the current rendered article. The returned
 * offsets are offsets in article.textContent and are suitable for marking.
 */
export function findAnnotationPosition(article, annotation) {
  if (!article || !annotation?.quote) return null;
  const text = article.textContent || '';
  const quote = String(annotation.quote);
  const candidates = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const index = text.indexOf(quote, cursor);
    if (index < 0) break;
    candidates.push(index);
    cursor = index + Math.max(1, quote.length);
  }

  if (!candidates.length) {
    const normalized = normalizeWithMap(text);
    const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
    if (!normalizedQuote) return null;
    const index = normalized.text.indexOf(normalizedQuote);
    if (index < 0) return null;
    const start = normalized.map[index] ?? 0;
    const end = normalized.map[index + normalizedQuote.length - 1] ?? start;
    return { start, end: Math.max(start + 1, end + 1) };
  }

  const chosen = candidates.find((index) => {
    const prefix = String(annotation.prefix || '');
    const suffix = String(annotation.suffix || '');
    const prefixMatch = !prefix || text.slice(Math.max(0, index - prefix.length), index).endsWith(prefix.slice(-Math.min(prefix.length, index)));
    const suffixMatch = !suffix || text.slice(index + quote.length, index + quote.length + suffix.length).startsWith(suffix.slice(0, Math.min(suffix.length, text.length - index - quote.length)));
    return prefixMatch && suffixMatch;
  }) ?? candidates[0];

  return { start: chosen, end: chosen + quote.length };
}

export function sliceAnnotation(annotation, articleText, start, end, createId = () => annotation?.id) {
  const quote = String(articleText || '').slice(start, end).replace(/\s+/g, ' ').trim();
  if (!annotation || !quote) return null;
  const text = String(articleText || '');
  return {
    ...annotation,
    id: createId(),
    quote,
    prefix: text.slice(Math.max(0, start - MAX_ANCHOR_CONTEXT), start).replace(/\s+/g, ' ').slice(-MAX_ANCHOR_CONTEXT),
    suffix: text.slice(end, end + MAX_ANCHOR_CONTEXT).replace(/\s+/g, ' ').slice(0, MAX_ANCHOR_CONTEXT),
    updatedAt: Date.now(),
  };
}

/**
 * Add visual wrappers around annotation ranges. Ranges are processed from the
 * end of the document so earlier text offsets remain stable. Overlapping
 * annotations are left unwrapped rather than producing invalid nested marks.
 */
export function applyAnnotationMarks(article, annotations = []) {
  if (!article || !Array.isArray(annotations)) return new Set();
  const positioned = annotations
    .map((annotation) => ({ annotation, position: findAnnotationPosition(article, annotation) }))
    .filter(({ position }) => position && position.end > position.start)
    .sort((a, b) => b.position.start - a.position.start);

  const occupied = [];
  const rendered = new Set();
  for (const item of positioned) {
    const { start, end } = item.position;
    if (occupied.some((range) => start < range.end && end > range.start)) continue;
    if (wrapTextRange(article, start, end, item.annotation)) {
      occupied.push({ start, end });
      rendered.add(item.annotation.id);
    }
  }
  return rendered;
}

function wrapTextRange(root, start, end, annotation) {
  const nodes = textNodes(root);
  let cursor = 0;
  let wrapped = false;
  for (const node of nodes) {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.nodeValue.length;
    cursor = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) continue;

    const localStart = Math.max(0, start - nodeStart);
    const localEnd = Math.min(node.nodeValue.length, end - nodeStart);
    if (localEnd <= localStart || !node.parentNode) continue;

    let target = node;
    if (localStart > 0) target = target.splitText(localStart);
    if (localEnd - localStart < target.nodeValue.length) target.splitText(localEnd - localStart);

    const wrapper = document.createElement(annotation.kind === 'highlight' ? 'mark' : 'span');
    wrapper.className = annotation.kind === 'underline'
      ? 'annotation-underline'
      : annotation.kind === 'comment'
        ? 'annotation-comment'
        : 'annotation-highlight';
    wrapper.dataset.annotationId = annotation.id;
    wrapper.dataset.annotationKind = annotation.kind || 'comment';
    wrapper.dataset.annotationNote = annotation.note || '';
    target.parentNode.replaceChild(wrapper, target);
    wrapper.append(target);
    wrapped = true;
  }
  return wrapped;
}

function textNodes(root) {
  const result = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue) result.push(node);
    node = walker.nextNode();
  }
  return result;
}

function normalizeWithMap(value) {
  const text = String(value || '');
  let normalized = '';
  const map = [];
  let pendingSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      map.push(index - 1);
      pendingSpace = false;
    }
    normalized += char;
    map.push(index);
  }
  return { text: normalized, map };
}
