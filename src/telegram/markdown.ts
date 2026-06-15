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

// --- Blocks: prefer plain-mode HTML (parseTextEntities-acceptable) over
// rich-only tags. Headings, lists, and hr have natural plain renderings —
// emit those so the message dispatches via inputMessageText instead of
// inputMessageRichMessage. Tables and math have no good plain alternative
// and stay as rich-only tags (the send path detects them and routes through
// inputMessageRichMessage). See hasRichOnlyMarkup.

md.renderer.rules.paragraph_open = () => '';
md.renderer.rules.paragraph_close = (tokens, idx) =>
  tokens[idx]!.hidden ? '' : '\n';

// Headings → bold + newline. Telegram entities don't have a hierarchy concept,
// so all levels degrade to bold; the trailing newline gives separation.
md.renderer.rules.heading_open = () => '<b>';
md.renderer.rules.heading_close = () => '</b>\n';

md.renderer.rules.blockquote_open = () => '<blockquote>';
md.renderer.rules.blockquote_close = () => '</blockquote>\n';

// Lists → plain-text bullets / numbers. A leading newline is emitted only when
// nesting (depth > 0) to start the inner list on its own line under the
// parent item. The list-level open/close are otherwise empty — the surrounding
// item's `\n` handles separation.
md.renderer.rules.bullet_list_open = () => { const nested = listDepth > 0; listDepth++; return nested ? '\n' : ''; };
md.renderer.rules.bullet_list_close = () => { listDepth--; return ''; };
md.renderer.rules.ordered_list_open = () => { const nested = listDepth > 0; listDepth++; return nested ? '\n' : ''; };
md.renderer.rules.ordered_list_close = () => { listDepth--; return ''; };

md.renderer.rules.list_item_open = (tokens, idx) => {
  const indent = '  '.repeat(listDepth - 1);
  // For ordered lists, token.info holds the literal item number ("1", "5", etc.).
  // For bullets it's empty.
  const info = tokens[idx]!.info;
  return info ? `${indent}${info}. ` : `${indent}• `;
};
md.renderer.rules.list_item_close = () => '\n';

// HR → plain divider line. Three em-dashes read as a section break in plain
// text and are accepted by the entity grammar as a literal string.
md.renderer.rules.hr = () => '———\n';

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
//
// Headings, lists, and hr are intentionally NOT in this set — they degrade
// to plain-mode renderings (bold, bullet/number prefixes, em-dash divider).
// Tables and math have no good plain-mode equivalent and remain rich-only.
const RICH_ONLY_TAGS = /<(?:tg-math|tg-math-block|table|p\b|mark|sub|sup|details|footer|aside|figure|img|video|audio)\b/;

export const hasRichOnlyMarkup = (html: string): boolean =>
  RICH_ONLY_TAGS.test(html);
