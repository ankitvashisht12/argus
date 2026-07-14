# Progress

## Done
- Design spec: docs/superpowers/specs/2026-07-14-argus-vscode-design.md
- Contract: docs/loop/contract.md
- Repo renamed (argus-go = old Go repo; this repo = argus monorepo)
- codiff reference clone: /private/tmp/claude-501/-Users-ankitvashisht-Personal-hunker/33624f30-a603-47e2-9336-48dc2a234187/scratchpad/codiff
- Engine: diff parser, claude adapter, gh client, review pipeline, cache — integrated, full public barrel, 95/95 tests green, tsc clean, no vscode imports
- Extension built: extension.ts fully wired (session accessor + all six surfaces); commands reviewPr/demo/regenerate/openOverview/submitReview/toggleReviewed/openDiff live. Cross-surface URI shape unified on contentProvider's `argus://<side>/<owner>/<repo>/<number>/<path>?sha=` (fixed comments/sidebar/tree callers). gh/claude-missing → actionable notifications; diff still opens with claude absent (reviewError, contract 18). Flat eslint (engine+vscode) clean; workspace tsc clean; esbuild bundle clean; 31 vscode pure-logic tests + 95 engine tests green. Packaged argus-review-0.1.0.vsix (47 KB) via vsce --no-dependencies; .vscodeignore ships dist/media/fixtures/README/LICENSE/notices only.

## Done (adversarial fixes, round 1)
- Fixed 3 confirmed defects at root cause:
  1. comments.ts — session swap now discards user draft threads + clears draftRegistry (via discardDraftsOnSessionSwap in syncSession), with a non-blocking toast when drafts were discarded; prevents stale PR#1 drafts posting against PR#2.
  2. prSession.ts — regenerate() is a no-op that re-emits the fixture review for demo sessions (#agent === null) instead of routing through #runReview and wiping the fixture into a 'claude not found' error; contract 19 preserved for real sessions.
  3. comments.ts + contentProvider.ts — AI note URIs now resolve through a single shared helper (argusUriForSide in contentProvider, consumed by aiThreadUri in comments) so old-side threads on renamed files use oldPath (base doc) instead of the anchor's head path; note is no longer invisible.
- New pure-logic tests: aiThreadUri (4, test/comments.test.ts), argusUriForSide (3, test/uri.test.ts), demo regenerate (1, test/prSession.test.ts). vscode suite now 39 (was 31); engine 95. All gates green (tsc, esbuild build, eslint, both vitest suites, vsce package → argus-review-0.1.0.vsix).

## Doing
- Phase 3: adversarial review + fixes (evaluator contexts)

## Next
- Phase 3: adversarial review + fixes (evaluator contexts)
- Phase 4: live smoke test (real PR read-only), tag v0.1.0
