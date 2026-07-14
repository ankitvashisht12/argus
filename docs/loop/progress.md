# Progress

## Done
- Design spec: docs/superpowers/specs/2026-07-14-argus-vscode-design.md
- Contract: docs/loop/contract.md
- Repo renamed (argus-go = old Go repo; this repo = argus monorepo)
- codiff reference clone: /private/tmp/claude-501/-Users-ankitvashisht-Personal-hunker/33624f30-a603-47e2-9336-48dc2a234187/scratchpad/codiff
- Engine: diff parser, claude adapter, gh client, review pipeline, cache — integrated, full public barrel, 95/95 tests green, tsc clean, no vscode imports
- Extension built: extension.ts fully wired (session accessor + all six surfaces); commands reviewPr/demo/regenerate/openOverview/submitReview/toggleReviewed/openDiff live. Cross-surface URI shape unified on contentProvider's `argus://<side>/<owner>/<repo>/<number>/<path>?sha=` (fixed comments/sidebar/tree callers). gh/claude-missing → actionable notifications; diff still opens with claude absent (reviewError, contract 18). Flat eslint (engine+vscode) clean; workspace tsc clean; esbuild bundle clean; 31 vscode pure-logic tests + 95 engine tests green. Packaged argus-review-0.1.0.vsix (47 KB) via vsce --no-dependencies; .vscodeignore ships dist/media/fixtures/README/LICENSE/notices only.

## Doing
- Phase 3: adversarial review + fixes (evaluator contexts)

## Next
- Phase 3: adversarial review + fixes (evaluator contexts)
- Phase 4: live smoke test (real PR read-only), tag v0.1.0
