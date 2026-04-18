/**
 * JSON codec with registered custom types. Serialization emits a wrapper
 * `{ _: data, meta: { "/json/pointer": "tag" } }` where `meta` records which
 * subtrees were handed off to custom (de)serializers. A registered type's
 * subtree is opaque to the codec: nested values are not walked further.
 */

const escape = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');

const decodePointer = (pointer: string): string[] =>
  pointer === '' ? [] : pointer.slice(1).split('/').map(unescape);

interface CustomType<T = unknown, S = unknown> {
  tag: string;
  isApplicable: (v: unknown) => v is T;
  serialize: (v: T) => Promise<S>;
  deserialize: (v: S) => Promise<T>;
}

export interface Codec {
  register<T, S>(def: CustomType<T, S>): void;
  stringify(value: unknown): Promise<string>;
  parse(json: string): Promise<unknown>;
}

export const createCodec = (): Codec => {
  const types: CustomType[] = [];

  const walk = async (value: unknown, pointer: string, meta: Record<string, string>): Promise<unknown> => {
    const custom = types.find(t => t.isApplicable(value));
    if (custom !== undefined) {
      meta[pointer] = custom.tag;
      return await custom.serialize(value);
    }
    if (Array.isArray(value)) {
      return await Promise.all(value.map((v, i) => walk(v, `${pointer}/${i}`, meta)));
    }
    if (typeof value === 'object' && value !== null) {
      const entries = await Promise.all(
        Object.entries(value).map(async ([k, v]) =>
          [k, await walk(v, `${pointer}/${escape(k)}`, meta)] as const),
      );
      return Object.fromEntries(entries);
    }
    return value;
  };

  const applyDeserializer = async (root: unknown, pointer: string, tag: string): Promise<void> => {
    const custom = types.find(t => t.tag === tag);
    if (custom === undefined) throw new Error(`Unknown codec type tag: ${tag}`);

    const segments = decodePointer(pointer);
    if (segments.length === 0) throw new Error('Cannot deserialize root value');

    let current = root as Record<string, unknown>;
    for (let i = 0; i < segments.length - 1; i++) {
      current = current[segments[i]!] as Record<string, unknown>;
    }
    const last = segments[segments.length - 1]!;
    current[last] = await custom.deserialize(current[last]);
  };

  return {
    register: <T, S>(def: CustomType<T, S>) => {
      types.push(def as CustomType);
    },

    stringify: async value => {
      const meta: Record<string, string> = {};
      const data = await walk(value, '', meta);
      if ('' in meta) throw new Error('Root value cannot be a registered custom type');
      return JSON.stringify({ _: data, meta });
    },

    parse: async json => {
      const parsed: unknown = JSON.parse(json);
      if (
        typeof parsed !== 'object' || parsed === null
        || !('_' in parsed) || !('meta' in parsed)
        || typeof parsed.meta !== 'object' || parsed.meta === null
      ) {
        throw new Error('Invalid codec format: missing _ or meta');
      }
      const data = (parsed as { _: unknown })._;
      const meta = (parsed as { meta: Record<string, string> }).meta;
      for (const [pointer, tag] of Object.entries(meta)) {
        await applyDeserializer(data, pointer, tag);
      }
      return data;
    },
  };
};
