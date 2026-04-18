import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { createCodec } from './codec';

const createTestCodec = (): ReturnType<typeof createCodec> => {
  const codec = createCodec();
  codec.register<ReturnType<typeof sharp>, string>({
    tag: 'sharp',
    isApplicable: (v): v is ReturnType<typeof sharp> =>
      typeof v === 'object' && v !== null
      && typeof (v as Record<string, unknown>).toBuffer === 'function'
      && typeof (v as Record<string, unknown>).metadata === 'function',
    serialize: async v => (await v.toBuffer()).toString('base64'),
    deserialize: async v => sharp(Buffer.from(v, 'base64')),
  });
  return codec;
};

describe('codec', () => {
  it('round-trips plain JSON with wrapper', async () => {
    const codec = createTestCodec();
    const data = { a: 1, b: [2, 3], c: { d: 'hello' } };
    const json = await codec.stringify(data);
    const parsed = JSON.parse(json) as { _: unknown; meta: Record<string, string> };
    expect(parsed.meta).toEqual({});
    expect(await codec.parse(json)).toEqual(data);
  });

  it('round-trips Sharp instances via base64', async () => {
    const codec = createTestCodec();
    const img = sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png();
    const originalBuf = await img.toBuffer();

    const data = {
      segments: [
        { kind: 'text', text: 'hello' },
        { kind: 'image', image: img, detail: 'high' },
      ],
    };

    const json = await codec.stringify(data);
    const parsed = JSON.parse(json) as { _: { segments: unknown[] }; meta: Record<string, string> };
    expect(parsed.meta).toEqual({ '/segments/1/image': 'sharp' });
    expect(typeof (parsed._.segments[1] as { image: unknown }).image).toBe('string');

    const restored = await codec.parse(json) as typeof data;
    expect(restored.segments[0]).toEqual({ kind: 'text', text: 'hello' });
    const restoredBuf = await (restored.segments[1] as { image: ReturnType<typeof sharp> }).image.toBuffer();
    expect(restoredBuf).toEqual(originalBuf);
  });

  it('handles JSON Pointer escaping for keys with / and ~', async () => {
    const codec = createTestCodec();
    const img = sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png();

    const data = { 'a/b': { 'c~d': { image: img } } };
    const json = await codec.stringify(data);
    const parsed = JSON.parse(json) as { meta: Record<string, string> };
    expect(parsed.meta).toEqual({ '/a~1b/c~0d/image': 'sharp' });

    const restored = await codec.parse(json) as typeof data;
    const buf = await restored['a/b']['c~d'].image.toBuffer();
    expect(buf.length).toBeGreaterThan(0);
  });

  it('handles multiple Sharp instances', async () => {
    const codec = createTestCodec();
    const img1 = sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png();
    const img2 = sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png();

    const data = [{ image: img1 }, { image: img2 }];
    const json = await codec.stringify(data);
    const parsed = JSON.parse(json) as { meta: Record<string, string> };
    expect(Object.keys(parsed.meta)).toHaveLength(2);
    expect(parsed.meta['/0/image']).toBe('sharp');
    expect(parsed.meta['/1/image']).toBe('sharp');

    const restored = await codec.parse(json) as typeof data;
    const buf1 = await restored[0]!.image.toBuffer();
    const buf2 = await restored[1]!.image.toBuffer();
    expect(buf1).not.toEqual(buf2);
  });

  it('rejects non-codec JSON', async () => {
    const codec = createTestCodec();
    await expect(codec.parse('{"a":1,"b":"hello"}')).rejects.toThrow('Invalid codec format');
  });
});
