import { defaultValueCtx, Editor, rootCtx } from '@milkdown/kit/core';
import { gfm } from '@milkdown/kit/preset/gfm';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { getMarkdown } from '@milkdown/kit/utils';

/**
 * Mount a Markdown-native editor into an empty container.
 * The editor owns only local DOM state in S2; callers decide whether and how
 * the serialized Markdown may be written back in a later stage.
 */
export async function mountMarkdownEditor(container, value, { onMarkdownChange } = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('A Markdown editor container is required.');
  }

  const editor = Editor.make();
  editor.config((ctx) => {
    ctx.set(rootCtx, container);
    ctx.set(defaultValueCtx, String(value || ''));
    ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
      onMarkdownChange?.(markdown);
    });
  });
  editor.use(commonmark);
  editor.use(gfm);
  editor.use(listener);
  await editor.create();
  return editor;
}

export function serializeMarkdown(editor) {
  if (!editor) return '';
  return editor.action(getMarkdown());
}
