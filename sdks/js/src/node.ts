import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleStorage } from './index.js';

/** Disk cache for Node/Electron on Linux devices (e.g. /var/cache/myapp/nativeloc). */
export function fileStorage(dir: string): BundleStorage {
  mkdirSync(dir, { recursive: true });
  const path = (k: string) => join(dir, `${k.replace(/[^\w.-]/g, '_')}.json`);
  return {
    get(k) {
      try {
        return readFileSync(path(k), 'utf8');
      } catch {
        return null;
      }
    },
    set(k, v) {
      // Write-then-rename so a power cut never leaves a half-written bundle.
      const p = path(k);
      writeFileSync(`${p}.tmp`, v);
      renameSync(`${p}.tmp`, p);
    },
  };
}
