import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Pure-logic tests only. The bare `vscode` specifier is aliased to a tiny stub so
// the surface modules (which `import * as vscode` at the top) load without the
// extension host; the tested helpers themselves touch only `vscode.Uri`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)),
    },
  },
});
