import MarkdownIt from 'markdown-it';
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

// --- Mutable state for list nesting (safe: render() is synchronous) ---

let listDepth = 0;

// --- Inline: remap to Telegram-supported tags ---

md.renderer.rules.strong_open = () => '<b>';
md.renderer.rules.strong_close = () => '</b>';
md.renderer.rules.em_open = () => '<i>';
md.renderer.rules.em_close = () => '</i>';
md.renderer.rules.hardbreak = () => '\n';

// --- Blocks: strip unsupported tags, degrade gracefully ---

md.renderer.rules.paragraph_open = () => '';
md.renderer.rules.paragraph_close = (tokens, idx) =>
  tokens[idx]!.hidden ? '' : '\n';

md.renderer.rules.heading_open = () => '<b>';
md.renderer.rules.heading_close = () => '</b>\n';

md.renderer.rules.blockquote_open = () => '<blockquote>';
md.renderer.rules.blockquote_close = () => '</blockquote>\n';

md.renderer.rules.bullet_list_open = () => { const nested = listDepth > 0; listDepth++; return nested ? '\n' : ''; };
md.renderer.rules.bullet_list_close = () => { listDepth--; return ''; };
md.renderer.rules.ordered_list_open = () => { const nested = listDepth > 0; listDepth++; return nested ? '\n' : ''; };
md.renderer.rules.ordered_list_close = () => { listDepth--; return ''; };

md.renderer.rules.list_item_open = (tokens, idx) => {
  const indent = '  '.repeat(listDepth - 1);
  const token = tokens[idx]!;
  // ordered list: token.info holds the item number (e.g. "1", "2")
  return token.info
    ? `${indent}${token.info}. `
    : `${indent}• `;
};
md.renderer.rules.list_item_close = () => '\n';

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

// --- Tables: degrade to pipe-separated text ---

md.renderer.rules.table_open = () => '';
md.renderer.rules.table_close = () => '';
md.renderer.rules.thead_open = () => '';
md.renderer.rules.thead_close = () => '';
md.renderer.rules.tbody_open = () => '';
md.renderer.rules.tbody_close = () => '';
md.renderer.rules.tr_open = () => '';
md.renderer.rules.tr_close = () => '\n';
md.renderer.rules.th_open = () => '<b>';
md.renderer.rules.th_close = () => '</b> | ';
md.renderer.rules.td_open = () => '';
md.renderer.rules.td_close = () => ' | ';

// --- Public API ---

export const renderMarkdownToTelegramHTML = (markdown: string): string => {
  listDepth = 0;
  return md.render(markdown)
    .replace(/\n<\/blockquote>/g, '</blockquote>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');
};
