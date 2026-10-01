import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up to the repository root so paths hold from source or from dist/. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'spec', 'oar'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('spec/oar not found above the test directory');
    dir = parent;
  }
}

export const REPO = repoRoot();
export const SPEC_DIR = join(REPO, 'spec', 'oar', '1.0');
export const CORPUS = join(SPEC_DIR, 'conformance');
export const SCHEMAS = join(SPEC_DIR, 'schemas');
export const EXAMPLES = join(REPO, 'examples', 'portable-pack');
