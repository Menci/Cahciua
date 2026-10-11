import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', 'history-worker': 'src/history/worker.ts', 'history-query-worker': 'src/history/query/worker.ts' },
  format: 'esm',
  dts: true,
  clean: true,
});
