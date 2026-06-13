import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve the libtdjson shared-library path.
 *
 * Preference order:
 * 1. `vendor/libtdjson.so` — populated by `scripts/build-tdlib.sh`, used as
 *    an escape hatch when prebuilt-tdlib lags behind TDLib master (e.g. for
 *    day-1 support of brand-new protocol features).
 * 2. `prebuilt-tdlib` — the npm-published TDLib binary for normal operation.
 *
 * The prebuilt-tdlib package is loaded dynamically rather than via a static
 * `import` to keep its bundled tdlib-types declaration (which pins TDLib 1.8.64
 * and may shadow our locally generated types/tdlib-types.d.ts) out of the
 * TypeScript program. Our generated types are the single source of truth.
 */
export const resolveTdjson = (): string => {
  const vendorPath = resolve(process.cwd(), 'vendor', 'libtdjson.so');
  if (existsSync(vendorPath)) return vendorPath;
  const prebuilt = require('prebuilt-tdlib') as { getTdjson: () => string };
  return prebuilt.getTdjson();
};
