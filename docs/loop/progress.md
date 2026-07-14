# Progress

## Done
- Design spec + contract (docs/superpowers/specs/, docs/loop/)
- Engine: diff parser, claude adapter, gh client, review pipeline, cache — 95/95 tests, adversarial-verified (items 1-9)
- Extension: tree, diff provider, AI comment threads, overview, sidebar chat, GitHub review submit — 39/39 pure tests, adversarial-verified (items 10-20), evaluator findings fixed
- Release: root README, THIRD-PARTY-NOTICES, live smoke test 12/12 (sindresorhus/is#210, real claude call, anchors verified), final release sweep releaseReady=true, low findings fixed (incl. NUL-byte cleanup in sidebar.js)
- argus-review-0.1.0.vsix packaged (13 files, 47.4 KB) and installed locally
- Contract: 24/24 checked
- v0.1.1 (live-testing fixes): per-hunk coverage (prompt contract + buildReviewSchema(N) minItems + tolerant alias resolution), start-line single-line anchoring (firstChangedLine + aiThreadRange), split File Details webview (argus.details) so activity bar shows Changed Files + File Details accordions, chat relocated to argus-chat panel container with one-time hint, submit-review UX (status-bar count + commentThread/title action) — engine 107 / vscode 51 tests, all gates green; argus-review-0.1.1.vsix installed; tagged v0.1.1

## Doing
- (nothing — v0.1.1 shipped)

## Next
- Screenshots for README (needs a human eye)
- Marketplace publish (needs Ankit's publisher account + intent)
- Fast-follows: local branch mode, GitHub comment-thread sync, web/tui faces
