import { type Sharp } from 'sharp';

import type { ChatCompletionsContentPart } from './chat-types';
import type { ResponsesInputContent } from './chat-types';
import type { Extra, ExtraSource, ImagePart, InputPart } from './types';

/** Capture `obj` keys outside `coreKeys` into `Extra.fields` so unknown
 *  provider extensions round-trip without being mistaken for modeled fields. */
export const pickExtra = <S extends ExtraSource>(
  source: S,
  obj: object,
  coreKeys: ReadonlySet<string>,
): Extra<S> | undefined => {
  const fields = Object.fromEntries(
    Object.entries(obj).filter(([k]) => !coreKeys.has(k)),
  );
  return Object.keys(fields).length > 0 ? { source, fields } : undefined;
};

/**
 * Build a plain object by writing `lower` first, then same-source
 * `extra.fields`, then `higher` on top. Precedence: higher > extra > lower.
 * Core emit keys go in `higher` so they can never be shadowed; safe defaults
 * (that callers want only when nothing else provides them) go in `lower`.
 */
export const applyExtra = <T extends Record<string, unknown>>(
  extra: Extra | undefined,
  source: ExtraSource,
  parts: { lower?: Record<string, unknown>; higher: T },
): T & Record<string, unknown> => {
  const extraFields = extra?.source === source ? extra.fields : {};
  return { ...parts.lower, ...extraFields, ...parts.higher };
};

export const requireImageFormat = (format: string | undefined): string => {
  if (format === undefined) throw new Error('Image has no recognizable format');
  return format;
};

export const assertSystemTextOnly = (msg: { role: string; parts: { kind: string }[] }): void => {
  if (msg.role === 'system' && msg.parts.some(p => p.kind !== 'text')) {
    throw new Error('System message parts must be text');
  }
};

interface EncodedImage {
  buf: Buffer;
  format: string;
}

const MAX_EDGE: Record<'low' | 'high', number> = { low: 512, high: 1024 };

const encodeCache = new WeakMap<Sharp, Map<'low' | 'high', Promise<EncodedImage>>>();

export const sharpToEncoded = (part: ImagePart): Promise<EncodedImage> => {
  const detail = part.detail ?? 'high';
  let perImage = encodeCache.get(part.image);
  if (perImage === undefined) {
    perImage = new Map();
    encodeCache.set(part.image, perImage);
  }
  const cached = perImage.get(detail);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<EncodedImage> => {
    const resized = part.image.clone().resize({
      width: MAX_EDGE[detail],
      height: MAX_EDGE[detail],
      fit: 'inside',
      withoutEnlargement: true,
    });
    const [buf, meta] = await Promise.all([resized.toBuffer(), resized.metadata()]);
    return { buf, format: requireImageFormat(meta.format) };
  })();
  perImage.set(detail, promise);
  return promise;
};

export const sharpToDataUrl = async (part: ImagePart): Promise<string> => {
  const { buf, format } = await sharpToEncoded(part);
  return `data:image/${format};base64,${buf.toString('base64')}`;
};

/**
 * Convert an InputPart to a Responses content block.
 */
export const inputPartToResponsesContent = async (part: InputPart): Promise<ResponsesInputContent> => {
  if (part.kind === 'text') {
    return { type: 'input_text', text: part.text };
  }
  return {
    type: 'input_image',
    image_url: await sharpToDataUrl(part),
    detail: part.detail ?? 'auto',
  };
};

/**
 * Convert an InputPart to a Chat Completions content part.
 * Chat Completions uses `{type:'text'}` and `{type:'image_url', image_url:{url,detail}}`.
 */
export const inputPartToChatContent = async (part: InputPart): Promise<ChatCompletionsContentPart> => {
  if (part.kind === 'text') {
    return { type: 'text', text: part.text };
  }
  return {
    type: 'image_url',
    image_url: { url: await sharpToDataUrl(part), detail: part.detail ?? 'auto' },
  };
};
