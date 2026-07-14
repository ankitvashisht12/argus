# Progress

## Done
- Design spec + contract (docs/superpowers/specs/, docs/loop/)
- Engine: diff parser, claude adapter, gh client, review pipeline, cache — 95/95 tests, adversarial-verified (items 1-9)
- Extension: tree, diff provider, AI comment threads, overview, sidebar chat, GitHub review submit — 39/39 pure tests, adversarial-verified (items 10-20), evaluator findings fixed
- Release: root README, THIRD-PARTY-NOTICES, live smoke test 12/12 (sindresorhus/is#210, real claude call, anchors verified), final release sweep releaseReady=true, low findings fixed (incl. NUL-byte cleanup in sidebar.js)
- argus-review-0.1.0.vsix packaged (13 files, 47.4 KB) and installed locally
- Contract: 24/24 checked
- v0.1.1 (live-testing fixes): per-hunk coverage (prompt contract + buildReviewSchema(N) minItems + tolerant alias resolution), start-line single-line anchoring (firstChangedLine + aiThreadRange), split File Details webview (argus.details) so activity bar shows Changed Files + File Details accordions, chat relocated to argus-chat panel container with one-time hint, submit-review UX (status-bar count + commentThread/title action) — engine 107 / vscode 51 tests, all gates green; argus-review-0.1.1.vsix installed; tagged v0.1.1
- v0.1.2 (progressive loading): PrSession.load is now two-stage — resolves as soon as meta+diff+parsed files+persisted UI state are ready (tree/diffs/details usable immediately), then starts the AI review in the background via new startReview() (respects the cache; cache hit still near-instant). New reviewStatus getter ('idle'|'running'|'ready'|'error') + reviewSettled() promise; onDidChangeReview fires on 'running' too. extension.ts: fetch-only progress notification, new "$(sync~spin) ARGUS reviewing…" status-bar item (priority 101, beside submit item at 100) shown while running, errored-review warning now event-driven via onDidChangeReview. Regenerate reuses the background path (non-blocking). Overview/details already key off review-null-no-error → show loading; comments rebuild on review-land (verified). Demo sessions still ready at load. +4 vscode tests (55 total) — engine 107 / vscode 55, all gates green; argus-review-0.1.2.vsix installed; tagged v0.1.2

## Doing
- (nothing — v0.1.2 shipped)

## Next
- Screenshots for README (needs a human eye)
- Marketplace publish (needs Ankit's publisher account + intent)
- Fast-follows: local branch mode, GitHub comment-thread sync, web/tui faces
