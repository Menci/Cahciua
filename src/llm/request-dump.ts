import { mkdirSync, writeFileSync } from 'node:fs';

const DUMP_DIR = '/tmp/cahciua';
let initialized = false;

export const dumpLlmPayload = (dumpId: string | undefined, suffix: string, body: unknown): void => {
  if (!dumpId) return;
  if (!initialized) {
    mkdirSync(DUMP_DIR, { recursive: true });
    initialized = true;
  }
  writeFileSync(`${DUMP_DIR}/${dumpId}.${suffix}.json`, JSON.stringify(body, null, 2));
};
