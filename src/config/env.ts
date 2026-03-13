import * as v from 'valibot';

const EnvSchema = v.object({
  // Telegram Bot API
  TELEGRAM_BOT_TOKEN: v.string(),

  // Telegram User API (MTProto)
  TELEGRAM_API_ID: v.pipe(v.string(), v.transform(Number), v.integer()),
  TELEGRAM_API_HASH: v.string(),
  TELEGRAM_SESSION: v.optional(v.string(), ''),

  // LLM
  LLM_API_BASE_URL: v.string(),
  LLM_API_KEY: v.string(),
  LLM_MODEL: v.string(),
  LLM_MAX_CONTEXT_TOKENS: v.pipe(v.string(), v.transform(Number), v.integer()),

  // Driver
  DRIVER_CHAT_IDS: v.pipe(
    v.string(),
    v.transform(s => s.split(',').map(id => id.trim()).filter(Boolean)),
  ),

  // Database
  DB_PATH: v.optional(v.string(), './data/cahciua.db'),
});

export type Env = v.InferOutput<typeof EnvSchema>;

export const loadEnv = (): Env => v.parse(EnvSchema, process.env);
