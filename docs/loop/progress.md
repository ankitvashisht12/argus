# Progress

## Done
- Design spec + contract (docs/superpowers/specs/, docs/loop/)
- Engine: diff parser, claude adapter, gh client, review pipeline, cache — 95/95 tests, adversarial-verified (items 1-9)
- Extension: tree, diff provider, AI comment threads, overview, sidebar chat, GitHub review submit — 39/39 pure tests, adversarial-verified (items 10-20), evaluator findings fixed
- Release: root README, THIRD-PARTY-NOTICES, live smoke test 12/12 (sindresorhus/is#210, real claude call, anchors verified), final release sweep releaseReady=true, low findings fixed (incl. NUL-byte cleanup in sidebar.js)
- argus-review-0.1.0.vsix packaged (13 files, 47.4 KB) and installed locally
- Contract: 24/24 checked

## Doing
- (nothing — v0.1.0 shipped)

## Next
- Screenshots for README (needs a human eye)
- Marketplace publish (needs Ankit's publisher account + intent)
- Fast-follows: local branch mode, GitHub comment-thread sync, web/tui faces
