# Log

## [2026-07-14] session start | spec + contract written; toolchain verified (gh authed, claude 2.1.209, node 22.14); usage watcher running
## [2026-07-14] engine integrated | 5 modules unified; full index.ts barrel; retired stale stub-throws smoke assertion; 95/95 vitest green, tsc clean, no vscode imports; root npm install + workspace scripts verified
## [2026-07-14] extension built | extension.ts wired to all six surfaces; unified argus:// URI shape across contentProvider/comments/sidebar/tree; gh/claude-missing actionable notifications, diff opens without claude (contract 18); added flat eslint (engine+vscode, clean), 31 vscode pure-logic vitest + 95 engine green, tsc clean, esbuild bundle clean; packaged argus-review-0.1.0.vsix (47 KB, vsce --no-dependencies)
## [2026-07-14] adversarial fixes r1 | fixed 3 defects: clear stale drafts on session swap (comments.ts), demo regenerate no-op re-emits fixture (prSession.ts), renamed-file old-side AI thread URIs via shared argusUriForSide helper (comments.ts+contentProvider.ts); +8 vscode tests (39 total) + 95 engine green; tsc/build/eslint/package all clean
## [2026-07-14] release | 4 low findings fixed (stale TSDoc x3, vsce footgun README note, renderMarkdown guard + NUL-byte escape cleanup); all gates green; vsix repackaged + reinstalled; contract 24/24; tagged v0.1.0
