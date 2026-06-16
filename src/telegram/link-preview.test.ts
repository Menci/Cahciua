import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';

import { decideLinkPreviewOptions } from './link-preview';

const url = (offset: number, length: number): Td.textEntity =>
  ({ _: 'textEntity', offset, length, type: { _: 'textEntityTypeUrl' } });

const textUrl = (offset: number, length: number, url: string): Td.textEntity =>
  ({ _: 'textEntity', offset, length, type: { _: 'textEntityTypeTextUrl', url } });

describe('decideLinkPreviewOptions', () => {
  it('disables preview when no URLs', () => {
    const r = decideLinkPreviewOptions('hello world', []);
    expect(r).toEqual({ _: 'linkPreviewOptions', is_disabled: true });
  });

  it('enables preview for bare URL with ≥2 path segments', () => {
    const text = 'see https://twitter.com/lcMenci/status/123';
    const ent = [url(4, text.length - 4)];
    const r = decideLinkPreviewOptions(text, ent);
    expect(r).toEqual({
      _: 'linkPreviewOptions',
      is_disabled: false,
      url: 'https://twitter.com/lcMenci/status/123',
    });
  });

  it('enables preview when URL has a query string even with a single segment', () => {
    const text = 'https://example.com/search?q=foo';
    const ent = [url(0, text.length)];
    expect(decideLinkPreviewOptions(text, ent).is_disabled).toBe(false);
  });

  it('disables preview when URL has only one path segment and no query', () => {
    const text = 'https://claude.ai/justonelevel';
    const ent = [url(0, text.length)];
    expect(decideLinkPreviewOptions(text, ent).is_disabled).toBe(true);
  });

  it('treats trailing slash as still one segment', () => {
    const text = 'https://claude.ai/justonelevel/';
    const ent = [url(0, text.length)];
    expect(decideLinkPreviewOptions(text, ent).is_disabled).toBe(true);
  });

  it('disables preview for Telegram-hosted URLs even when path is deep', () => {
    const text = 'https://t.me/somechannel/123/456';
    const ent = [url(0, text.length)];
    expect(decideLinkPreviewOptions(text, ent).is_disabled).toBe(true);
  });

  it('disables preview for telegram.org subdomain', () => {
    const text = 'https://web.telegram.org/a/b';
    const ent = [url(0, text.length)];
    expect(decideLinkPreviewOptions(text, ent).is_disabled).toBe(true);
  });

  it('disables preview when link text differs from URL', () => {
    // "[link](https://example.com/a/b)" → text "link", entity covers offset 0..4 with url field
    const text = 'link';
    const ent = [textUrl(0, 4, 'https://example.com/a/b/c')];
    expect(decideLinkPreviewOptions(text, ent).is_disabled).toBe(true);
  });

  it('enables preview for text_link when displayed text exactly equals URL', () => {
    const text = 'https://twitter.com/lcMenci/status/123';
    const ent = [textUrl(0, text.length, 'https://twitter.com/lcMenci/status/123')];
    const r = decideLinkPreviewOptions(text, ent);
    expect(r.is_disabled).toBe(false);
    expect(r.url).toBe('https://twitter.com/lcMenci/status/123');
  });

  it('picks the first qualifying URL when several are present', () => {
    const text = 'a https://t.me/x/y b https://example.com/x/y';
    const ent = [
      url(2, 'https://t.me/x/y'.length),
      url(21, 'https://example.com/x/y'.length),
    ];
    expect(decideLinkPreviewOptions(text, ent)).toEqual({
      _: 'linkPreviewOptions',
      is_disabled: false,
      url: 'https://example.com/x/y',
    });
  });

  it('ignores non-http(s) schemes', () => {
    const text = 'tg://resolve?domain=foo';
    const ent = [url(0, text.length)];
    expect(decideLinkPreviewOptions(text, ent).is_disabled).toBe(true);
  });
});
