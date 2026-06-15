import { describe, expect, it } from 'vitest';

import { hasRichOnlyMarkup, renderMarkdownToTelegramHTML } from './markdown';

describe('renderMarkdownToTelegramHTML', () => {
  it('renders inline formatting to plain-mode HTML', () => {
    expect(renderMarkdownToTelegramHTML('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>');
  });

  it('preserves spoilers via custom plugin', () => {
    expect(renderMarkdownToTelegramHTML('hi ||secret|| world')).toBe('hi <tg-spoiler>secret</tg-spoiler> world');
  });

  it('renders headings as plain-mode bold (no rich-only <hN>)', () => {
    expect(renderMarkdownToTelegramHTML('# H1')).toBe('<b>H1</b>');
    expect(renderMarkdownToTelegramHTML('### H3')).toBe('<b>H3</b>');
    expect(hasRichOnlyMarkup(renderMarkdownToTelegramHTML('# H1'))).toBe(false);
  });

  it('renders unordered list as plain-text bullets', () => {
    expect(renderMarkdownToTelegramHTML('- a\n- b')).toBe('• a\n• b');
    expect(hasRichOnlyMarkup(renderMarkdownToTelegramHTML('- a\n- b'))).toBe(false);
  });

  it('renders ordered list as plain-text numbers', () => {
    expect(renderMarkdownToTelegramHTML('1. first\n2. second')).toBe('1. first\n2. second');
    expect(hasRichOnlyMarkup(renderMarkdownToTelegramHTML('1. first\n2. second'))).toBe(false);
  });

  it('honors literal item numbers on ordered lists', () => {
    expect(renderMarkdownToTelegramHTML('5. five\n6. six')).toBe('5. five\n6. six');
  });

  it('renders nested lists with depth-based indentation', () => {
    expect(renderMarkdownToTelegramHTML('- a\n  - b\n- c')).toBe('• a\n  • b\n\n• c');
  });

  it('renders tables as <table> (rich-only — kept for tabular fidelity)', () => {
    const out = renderMarkdownToTelegramHTML('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td>1</td>');
    expect(hasRichOnlyMarkup(out)).toBe(true);
  });

  it('renders hr as a plain em-dash divider', () => {
    expect(renderMarkdownToTelegramHTML('before\n\n---\n\nafter')).toBe('before\n———\nafter');
    expect(hasRichOnlyMarkup(renderMarkdownToTelegramHTML('---'))).toBe(false);
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

  describe('backslash escaping renders the literal character (no markup)', () => {
    it('escapes $ so prices do not trigger inline math', () => {
      const out = renderMarkdownToTelegramHTML('it costs \\$5 to \\$10');
      expect(out).toBe('it costs $5 to $10');
      expect(out).not.toContain('<tg-math');
    });

    it('escapes $$ so it does not trigger block math', () => {
      const out = renderMarkdownToTelegramHTML('use \\$\\$NAME\\$\\$ as a placeholder');
      expect(out).toBe('use $$NAME$$ as a placeholder');
      expect(out).not.toContain('<tg-math');
    });

    it('escapes * and _ so they stay literal', () => {
      expect(renderMarkdownToTelegramHTML('\\*literal\\*')).toBe('*literal*');
      expect(renderMarkdownToTelegramHTML('snake\\_case\\_var')).toBe('snake_case_var');
    });

    it('escapes || so it does not turn into a spoiler', () => {
      const out = renderMarkdownToTelegramHTML('\\|\\|not spoiler\\|\\|');
      expect(out).toBe('||not spoiler||');
      expect(out).not.toContain('<tg-spoiler');
    });

    it('escapes ~~ so it does not turn into strikethrough', () => {
      const out = renderMarkdownToTelegramHTML('\\~\\~not strike\\~\\~');
      expect(out).toBe('~~not strike~~');
      expect(out).not.toContain('<s>');
    });

    it('escapes [ ] so they do not start a link', () => {
      expect(renderMarkdownToTelegramHTML('\\[brackets\\]')).toBe('[brackets]');
    });

    it('escapes backtick so it does not open inline code', () => {
      const out = renderMarkdownToTelegramHTML('\\`raw backtick\\`');
      expect(out).toBe('`raw backtick`');
      expect(out).not.toContain('<code>');
    });

    it('HTML-escapes < > inside the message body', () => {
      // Whether the bot writes literal `<tag>` or `\<tag\>`, the entity grammar
      // (HTML) requires < and > to be escaped — both forms must end up as &lt;/&gt;.
      expect(renderMarkdownToTelegramHTML('\\<tag\\>')).toBe('&lt;tag&gt;');
      expect(renderMarkdownToTelegramHTML('<not a tag>')).toBe('&lt;not a tag&gt;');
    });

    it('a single backslash escapes itself', () => {
      expect(renderMarkdownToTelegramHTML('back\\\\slash')).toBe('back\\slash');
    });

    it('does not break legitimate formatting next to escaped characters', () => {
      const out = renderMarkdownToTelegramHTML('the price is \\$5, and **this** is bold');
      expect(out).toBe('the price is $5, and <b>this</b> is bold');
    });
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
    // Headings, lists, hr now degrade to plain text — never appear as rich tags.
    expect(hasRichOnlyMarkup('• bullet item')).toBe(false);
    expect(hasRichOnlyMarkup('1. numbered')).toBe(false);
    expect(hasRichOnlyMarkup('a ——— b')).toBe(false);
  });

  it('returns true for the remaining rich-only tags (math, tables)', () => {
    expect(hasRichOnlyMarkup('text <tg-math>x</tg-math>')).toBe(true);
    expect(hasRichOnlyMarkup('<tg-math-block>x</tg-math-block>')).toBe(true);
    expect(hasRichOnlyMarkup('<table><tr><td>x</td></tr></table>')).toBe(true);
  });
});
