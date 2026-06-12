import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTdjson as getPrebuiltTdjson } from 'prebuilt-tdlib';

/**
 * Resolve the libtdjson shared-library path.
 *
 * Preference order:
 * 1. `vendor/libtdjson.so` — populated by `scripts/build-tdlib.sh`, used as
 *    an escape hatch when prebuilt-tdlib lags behind TDLib master (e.g. for
 *    day-1 support of brand-new protocol features).
 * 2. `prebuilt-tdlib` — the npm-published TDLib binary for normal operation.
 *
 * The platform-specific suffix on Linux (`.so.x.y.z`) is normalized to plain
 * `libtdjson.so` by the build script.
 */
export const resolveTdjson = (): string => {
  const vendorPath = resolve(process.cwd(), 'vendor', 'libtdjson.so');
  if (existsSync(vendorPath)) return vendorPath;
  return getPrebuiltTdjson();
};
