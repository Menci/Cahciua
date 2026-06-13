import { describe, expect, it } from 'vitest';

import { hasRichOnlyMarkup, renderMarkdownToTelegramHTML } from './markdown';

describe('renderMarkdownToTelegramHTML', () => {
  it('renders inline formatting to plain-mode HTML', () => {
    expect(renderMarkdownToTelegramHTML('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>');
  });

  it('preserves spoilers via custom plugin', () => {
    expect(renderMarkdownToTelegramHTML('hi ||secret|| world')).toBe('hi <tg-spoiler>secret</tg-spoiler> world');
  });

  it('renders headings as <hN> (rich-only)', () => {
    expect(renderMarkdownToTelegramHTML('# H1')).toContain('<h1>H1</h1>');
    expect(renderMarkdownToTelegramHTML('### H3')).toContain('<h3>H3</h3>');
  });

  it('renders unordered list as <ul><li>', () => {
    const out = renderMarkdownToTelegramHTML('- a\n- b');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>a</li>');
    expect(out).toContain('<li>b</li>');
    expect(out).toContain('</ul>');
  });

  it('renders ordered list as <ol><li>', () => {
    const out = renderMarkdownToTelegramHTML('1. first\n2. second');
    expect(out).toContain('<ol>');
    expect(out).toContain('<li>first</li>');
  });

  it('renders tables as <table>', () => {
    const out = renderMarkdownToTelegramHTML('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td>1</td>');
  });

  it('renders hr as <hr/>', () => {
    expect(renderMarkdownToTelegramHTML('---')).toContain('<hr/>');
  });

  it('renders inline math as <tg-math>', () => {
    expect(renderMarkdownToTelegramHTML('text $E = mc^2$ end')).toBe('text <tg-math>E = mc^2</tg-math> end');
  });

  it('renders block math as <tg-math-block>', () => {
    const out = renderMarkdownToTelegramHTML('$$a^2 + b^2 = c^2$$');
    expect(out).toContain('<tg-math-block>a^2 + b^2 = c^2');
    expect(out).toContain('</tg-math-block>');
  });

  it('escapes HTML metacharacters inside math expressions', () => {
    const out = renderMarkdownToTelegramHTML('$a < b & c > d$');
    expect(out).toContain('<tg-math>a &lt; b &amp; c &gt; d</tg-math>');
  });
});

describe('hasRichOnlyMarkup', () => {
  it('returns false for content with only plain-grammar tags', () => {
    expect(hasRichOnlyMarkup('plain')).toBe(false);
    expect(hasRichOnlyMarkup('<b>bold</b>')).toBe(false);
    expect(hasRichOnlyMarkup('<i>i</i> <code>c</code> <pre>p</pre>')).toBe(false);
    expect(hasRichOnlyMarkup('<blockquote>q</blockquote>')).toBe(false);
    expect(hasRichOnlyMarkup('<a href="x">link</a>')).toBe(false);
    expect(hasRichOnlyMarkup('<tg-spoiler>s</tg-spoiler>')).toBe(false);
  });

  it('returns true for any rich-only tag', () => {
    expect(hasRichOnlyMarkup('<h1>H</h1>')).toBe(true);
    expect(hasRichOnlyMarkup('<h6>H</h6>')).toBe(true);
    expect(hasRichOnlyMarkup('<ul><li>a</li></ul>')).toBe(true);
    expect(hasRichOnlyMarkup('<ol><li>a</li></ol>')).toBe(true);
    expect(hasRichOnlyMarkup('<table><tr><td>x</td></tr></table>')).toBe(true);
    expect(hasRichOnlyMarkup('<hr/>')).toBe(true);
    expect(hasRichOnlyMarkup('text <tg-math>x</tg-math>')).toBe(true);
    expect(hasRichOnlyMarkup('<tg-math-block>x</tg-math-block>')).toBe(true);
  });
});
