import MarkdownIt from 'markdown-it';
// markdown-it-math-loose is a CommonJS plugin without bundled types.
// @ts-expect-error - no types published
import MarkdownItMath from 'markdown-it-math-loose';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

const md = new MarkdownIt({ linkify: true });

// --- Spoiler plugin: ||text|| → <tg-spoiler>text</tg-spoiler> ---
// The built-in `text` rule doesn't treat `|` as a terminator, so it swallows
// pipe characters before any custom inline rule gets a chance to run.
// We replace the `text` rule to also stop at 0x7C (|).

function spoilerPlugin(md: MarkdownIt) {
  // 1. Replace the built-in `text` rule so `|` is treated as a terminator.
  md.inline.ruler.at('text', (state: StateInline, silent: boolean) => {
    let pos = state.pos;
    while (pos < state.posMax
      && state.src.charCodeAt(pos) !== 0x7C /* | */
      && isTerminatorChar(state.src.charCodeAt(pos)) === false) {
      pos++;
    }
    if (pos === state.pos) return false;
    if (!silent) state.pending += state.src.slice(state.pos, pos);
    state.pos = pos;
    return true;
  });

  // 2. Add the spoiler inline rule.
  md.inline.ruler.before('strikethrough', 'spoiler', (state: StateInline, silent: boolean) => {
    const src = state.src;
    if (src.charCodeAt(state.pos) !== 0x7C || src.charCodeAt(state.pos + 1) !== 0x7C)
      return false;

    // Find closing ||
    const start = state.pos + 2;
    const closingIdx = src.indexOf('||', start);
    if (closingIdx === -1 || closingIdx > state.posMax - 2)
      return false;

    if (silent) return true;

    const tokenOpen = state.push('spoiler_open', 'tg-spoiler', 1);
    tokenOpen.markup = '||';

    // Recursively tokenize the inner content
    const prevPosMax = state.posMax;
    state.pos = start;
    state.posMax = closingIdx;
    state.md.inline.tokenize(state);
    state.posMax = prevPosMax;

    const tokenClose = state.push('spoiler_close', 'tg-spoiler', -1);
    tokenClose.markup = '||';

    state.pos = closingIdx + 2;
    return true;
  });
}

// Mirrors markdown-it's built-in isTerminatorChar, excluding 0x7C which we
// handle via the spoiler rule instead.
function isTerminatorChar(ch: number): boolean {
  switch (ch) {
  case 0x0A/* \n */:
  case 0x21/* ! */:
  case 0x23/* # */:
  case 0x24/* $ */:
  case 0x25/* % */:
  case 0x26/* & */:
  case 0x2A/* * */:
  case 0x2B/* + */:
  case 0x2D/* - */:
  case 0x3A/* : */:
  case 0x3C/* < */:
  case 0x3D/* = */:
  case 0x3E/* > */:
  case 0x40/* @ */:
  case 0x5B/* [ */:
  case 0x5C/* \ */:
  case 0x5D/* ] */:
  case 0x5E/* ^ */:
  case 0x5F/* _ */:
  case 0x60/* ` */:
  case 0x7B/* { */:
  case 0x7D/* } */:
  case 0x7E/* ~ */:
    return true;
  default:
    return false;
  }
}

md.use(spoilerPlugin);

// --- Math plugin: `$inline$` and `$$block$$` → <tg-math> / <tg-math-block> ---
// Output tags are Telegram Rich Message tags (only valid in richMessageSourceHtml).
// When the rendered HTML contains them, the caller must route the message through
// inputMessageRichMessage instead of inputMessageText. The detection is a simple
// substring scan on the output — see hasRichOnlyMarkup().

md.use(MarkdownItMath, {
  inlineOpen: '$',
  inlineClose: '$',
  blockOpen: '$$',
  blockClose: '$$',
  inlineRenderer: (code: string) => `<tg-math>${md.utils.escapeHtml(code)}</tg-math>`,
  blockRenderer: (code: string) => `<tg-math-block>${md.utils.escapeHtml(code)}</tg-math-block>`,
});

// --- Mutable state for list nesting (safe: render() is synchronous) ---

let listDepth = 0;

// --- Inline: remap to Telegram-supported tags ---

md.renderer.rules.strong_open = () => '<b>';
md.renderer.rules.strong_close = () => '</b>';
md.renderer.rules.em_open = () => '<i>';
md.renderer.rules.em_close = () => '</i>';
md.renderer.rules.hardbreak = () => '\n';

// --- Blocks: emit Rich-Message-supported HTML tags. Headings, lists, tables,
// hr and math are rich-only — their presence in the rendered HTML automatically
// promotes the message to inputMessageRichMessage (see hasRichOnlyMarkup).
// Plain-only sinks (inputMessageText) reject these tags, so the send path must
// dispatch based on the rich-only detection.

md.renderer.rules.paragraph_open = () => '';
md.renderer.rules.paragraph_close = (tokens, idx) =>
  tokens[idx]!.hidden ? '' : '\n';

md.renderer.rules.heading_open = (tokens, idx) => `<${tokens[idx]!.tag}>`;
md.renderer.rules.heading_close = (tokens, idx) => `</${tokens[idx]!.tag}>\n`;

md.renderer.rules.blockquote_open = () => '<blockquote>';
md.renderer.rules.blockquote_close = () => '</blockquote>\n';

md.renderer.rules.bullet_list_open = () => { listDepth++; return '<ul>'; };
md.renderer.rules.bullet_list_close = () => { listDepth--; return '</ul>\n'; };
md.renderer.rules.ordered_list_open = (tokens, idx) => {
  listDepth++;
  const start = tokens[idx]!.attrGet('start');
  return start ? `<ol start="${md.utils.escapeHtml(start)}">` : '<ol>';
};
md.renderer.rules.ordered_list_close = () => { listDepth--; return '</ol>\n'; };

md.renderer.rules.list_item_open = (tokens, idx) => {
  const token = tokens[idx]!;
  const value = token.attrGet('value');
  return value ? `<li value="${md.utils.escapeHtml(value)}">` : '<li>';
};
md.renderer.rules.list_item_close = () => '</li>';

md.renderer.rules.hr = () => '<hr/>\n';

// --- Code blocks ---

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = token.info.trim().split(/\s+/)[0];
  const content = md.utils.escapeHtml(token.content.replace(/\n$/, ''));
  return lang
    ? `<pre><code class="language-${md.utils.escapeHtml(lang)}">${content}</code></pre>\n`
    : `<pre>${content}</pre>\n`;
};

md.renderer.rules.code_block = (tokens, idx) =>
  `<pre>${md.utils.escapeHtml(tokens[idx]!.content.replace(/\n$/, ''))}</pre>\n`;

// --- Image: degrade to link ---

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx]!.attrGet('src') ?? '';
  const alt = self.renderInlineAsText(tokens[idx]!.children ?? [], options, env);
  return alt
    ? `<a href="${md.utils.escapeHtml(src)}">${md.utils.escapeHtml(alt)}</a>`
    : md.utils.escapeHtml(src);
};

// --- Tables: emit rich-message HTML <table>/<tr>/<th>/<td>. Rich-only. ---

md.renderer.rules.table_open = () => '<table>';
md.renderer.rules.table_close = () => '</table>\n';
md.renderer.rules.thead_open = () => '';
md.renderer.rules.thead_close = () => '';
md.renderer.rules.tbody_open = () => '';
md.renderer.rules.tbody_close = () => '';
md.renderer.rules.tr_open = () => '<tr>';
md.renderer.rules.tr_close = () => '</tr>';
md.renderer.rules.th_open = (tokens, idx) => {
  const align = tokens[idx]!.attrGet('style')?.match(/text-align:\s*(\w+)/)?.[1];
  return align ? `<th align="${md.utils.escapeHtml(align)}">` : '<th>';
};
md.renderer.rules.th_close = () => '</th>';
md.renderer.rules.td_open = (tokens, idx) => {
  const align = tokens[idx]!.attrGet('style')?.match(/text-align:\s*(\w+)/)?.[1];
  return align ? `<td align="${md.utils.escapeHtml(align)}">` : '<td>';
};
md.renderer.rules.td_close = () => '</td>';

// --- Public API ---

export const renderMarkdownToTelegramHTML = (markdown: string): string => {
  listDepth = 0;
  return md.render(markdown)
    .replace(/\n<\/blockquote>/g, '</blockquote>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');
};

// Tags that exist only in Telegram's Rich Message HTML grammar
// (richMessageSourceHtml) and are rejected by the plain entity grammar
// (parseTextEntities). When the rendered HTML contains any of these, the
// caller must dispatch through inputMessageRichMessage; otherwise the
// rendered HTML is a subset that parseTextEntities accepts.
const RICH_ONLY_TAGS = /<(?:tg-math|tg-math-block|h[1-6]|ul|ol|table|hr|p\b|mark|sub|sup|details|footer|aside|figure|img|video|audio)\b/;

export const hasRichOnlyMarkup = (html: string): boolean =>
  RICH_ONLY_TAGS.test(html);
