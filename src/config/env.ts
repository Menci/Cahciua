import * as v from 'valibot';

const EnvSchema = v.object({
  // Telegram Bot API
  TELEGRAM_BOT_TOKEN: v.optional(v.string(), ''),

  // Telegram User API (MTProto)
  TELEGRAM_API_ID: v.pipe(v.string(), v.transform(Number)),
  TELEGRAM_API_HASH: v.string(),
  TELEGRAM_SESSION: v.optional(v.string(), ''),

  // LLM (optional for now — needed when DCP pipeline is wired)
  LLM_API_BASE_URL: v.optional(v.string(), ''),
  LLM_API_KEY: v.optional(v.string(), ''),
  LLM_MODEL: v.optional(v.string(), ''),

  // Database
  DB_PATH: v.optional(v.string(), './data/cahciua.db'),
});

export type Env = v.InferOutput<typeof EnvSchema>;

export function loadEnv(): Env {
  return v.parse(EnvSchema, process.env);
}
