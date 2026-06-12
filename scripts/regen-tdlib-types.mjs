#!/usr/bin/env node
// Sync types/tdlib-types.d.ts to whichever libtdjson the runtime would load
// (vendor build if present, else prebuilt-tdlib).
// Invoked by `pnpm tdlib:types` and by the postinstall hook.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

mkdirSync('types', { recursive: true });

const source = existsSync('vendor/libtdjson.so') ? 'vendor/libtdjson.so' : 'prebuilt-tdlib';
execSync(`npx --yes tdl-install-types -o types/tdlib-types.d.ts ${source}`, { stdio: 'inherit' });
