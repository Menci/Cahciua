import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/history/schema.ts',
  out: './history-drizzle',
  dialect: 'sqlite',
});
