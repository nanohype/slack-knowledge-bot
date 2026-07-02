#!/usr/bin/env node
/**
 * Vendor @nanohype/runtime modules into `src/runtime/`.
 *
 * The nanohype `library/runtime/` directory is the single source of truth
 * for these primitives — the same vendor-and-sync contract the chart uses
 * for `chart/charts/tenant-chart-base/`. There is no shared package
 * registry between the factory and its tenants at runtime, so consumers
 * carry byte-identical copies of the modules they use; fixes land
 * upstream first (with their tests) and propagate outward via this
 * script. A copy that drifts from the source IS the defect.
 *
 * Only the modules this app consumes are vendored (see MODULES below).
 * Their unit tests stay upstream in `library/runtime/src/*.test.ts` —
 * this repo asserts the modules are wired correctly at its own
 * integration points instead of duplicating the unit suites.
 *
 *   node scripts/sync-runtime.mjs            # (re)write the vendored copies
 *   node scripts/sync-runtime.mjs --check    # CI gate: exit 1 if any copy drifted
 *
 * Source resolution: $NANOHYPE_DIR if set, else a sibling `nanohype`
 * checkout (`../nanohype` relative to this repo). CI checks out
 * nanohype/nanohype and points NANOHYPE_DIR at it.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NANOHYPE_DIR = process.env.NANOHYPE_DIR ?? join(ROOT, '..', 'nanohype');
const LIB_SRC = join(NANOHYPE_DIR, 'library', 'runtime', 'src');
const DEST = join(ROOT, 'src', 'runtime');
const CHECK = process.argv.includes('--check');

/** The runtime modules this app consumes. Add here when adopting another. */
const MODULES = ['circuit-breaker.ts', 'pii.ts', 'workos-directory.ts'];

async function main() {
  try {
    await access(LIB_SRC);
  } catch {
    console.error(
      `runtime library source not found at ${LIB_SRC}\n` +
        `set NANOHYPE_DIR to a nanohype/nanohype checkout (or clone it as a sibling of this repo)`,
    );
    process.exit(1);
  }

  let drift = 0;
  if (!CHECK) await mkdir(DEST, { recursive: true });

  for (const file of MODULES) {
    const src = join(LIB_SRC, file);
    const dest = join(DEST, file);
    const rel = relative(ROOT, dest);
    const want = await readFile(src, 'utf8');

    if (CHECK) {
      let have = null;
      try {
        have = await readFile(dest, 'utf8');
      } catch {
        // missing counts as drift
      }
      if (have === want) {
        console.log(`ok  ${rel}`);
      } else {
        console.error(`DRIFT  ${rel} — run \`npm run sync:runtime\``);
        drift++;
      }
    } else {
      await writeFile(dest, want);
      console.log(`vendored ${file} -> ${rel}`);
    }
  }

  if (CHECK && drift > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
