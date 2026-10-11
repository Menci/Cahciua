import { expect, it } from 'vitest';

import { renderSystemPrompt } from './prompt';
import { historyQueryInstructions } from '../history/query/instructions';

it('places history SDK/schema only in an enabled primary prompt', async () => {
  const base = { modelName: 'fixture', chatId: 'chat', systemFiles: [] };
  expect(await renderSystemPrompt({ ...base, mode: 'primary', historyQueryEnabled: true })).toContain(historyQueryInstructions);
  expect(await renderSystemPrompt({ ...base, mode: 'primary', historyQueryEnabled: false })).not.toContain(historyQueryInstructions);
  expect(await renderSystemPrompt({ ...base, mode: 'probe', historyQueryEnabled: true })).not.toContain(historyQueryInstructions);
});
