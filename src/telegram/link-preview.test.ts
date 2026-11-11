import { describe, expect, it } from 'vitest';

import { decideLinkPreviewOptions, qualifiesForPreview } from './link-preview';

describe('link preview policy', () => {
  it('previews the chat own message deep links', () => {
    expect(qualifiesForPreview('https://t.me/c/3767048038/109332', '-1003767048038')).toBe(true);
  });

  it('qualifies an external deep URL but not a bare domain', () => {
    expect(qualifiesForPreview('https://twitter.com/user/status/123')).toBe(true);
    expect(qualifiesForPreview('https://example.com')).toBe(false);
  });

  it('needs an explicit URL entity to enable a preview', () => {
    expect(decideLinkPreviewOptions('see https://example.com/a/b', [])).toEqual({ linkPreview: false });
  });
});
