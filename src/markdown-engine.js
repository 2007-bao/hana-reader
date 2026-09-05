import createDOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
  highlight(source, language) {
    return highlightSource(source, language);
  },
});

markdown.use(taskLists, { enabled: true, label: true });

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = String(token.info || '').trim().split(/\s+/)[0] || 'text';
  return `<pre class="markdown-code"><code class="language-${escapeHtml(language)}">${highlightSource(token.content, language)}</code></pre>\n`;
};

const allowedUri = /^(?:(?:https?|mailto):|[#/.]|$)/i;
let purifier = null;

function sanitizeMarkup(html, options = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return html;
  purifier ||= createDOMPurify(window);
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: allowedUri,
    ...options,
  });
}

export function sanitizeHtmlPreview(source) {
  return sanitizeMarkup(String(source || ''), {
    // Preview is intentionally document-only: no executable code, navigation,
    // embedded documents, or network-backed resource elements.
    FORBID_TAGS: [
      'script', 'style', 'link', 'meta', 'base', 'iframe', 'object', 'embed',
      'form', 'img', 'audio', 'video', 'source', 'track',
    ],
  });
}

export function renderMarkdown(source) {
  const rendered = markdown.render(String(source || ''));
  const withHeadingNumbers = rendered.replace(
    /(<h[1-6]\b[^>]*>)(\s*(?:\d+\.)*\d+)(?=\s|·|[)）])/g,
    '$1<span class="heading-number">$2</span>',
  );
  return sanitizeMarkup(withHeadingNumbers)
    || '<p class="empty-document">这是一个空文件。</p>';
}

export function highlightCode(source, language) {
  const value = String(source || '');
  if (!value) return '&nbsp;';
  return highlightSource(value, language);
}

function highlightSource(source, language) {
  const rawLanguage = String(language || 'text').trim().toLowerCase();
  const normalized = {
    c: 'cpp',
    'c++': 'cpp',
    h: 'cpp',
    html: 'xml',
    htm: 'xml',
    js: 'javascript',
    md: 'markdown',
    sh: 'bash',
    shell: 'bash',
    ts: 'typescript',
  }[rawLanguage] || rawLanguage;
  if (!normalized || normalized === 'text' || normalized === 'plain' || normalized === 'plaintext') {
    return escapeHtml(source);
  }
  if (hljs.getLanguage(normalized)) {
    return hljs.highlight(source, { language: normalized, ignoreIllegals: true }).value;
  }
  return escapeHtml(source);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}
