import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ linkify: true });

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
