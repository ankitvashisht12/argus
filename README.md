# ARGUS

**AI-first GitHub PR review, inside VS Code.**

ARGUS fetches a GitHub pull request, reviews it through a **reviewer-skeptic
lens**, and renders the whole thing on VS Code's native surfaces — the
changed-files tree, the built-in diff viewer, and comment threads. No separate
web app or terminal to switch to, and nothing leaves your machine: it drives
your own `claude` and `gh` CLIs locally.

The skeptic lens is the point. For every hunk, ARGUS answers the two questions a
careful human reviewer would ask — *why this change* (what the diff is actually
doing) and *look out for* (what could go wrong, what to double-check) — anchored
to the first changed line, importance-tagged, with every hunk covered.

<!-- TODO(screenshot): hero screenshot goes here — files tree + per-hunk threads, the Overview tab, and the Submit Review flow. -->

## Features

- **Per-hunk comment threads** — native VS Code threads with *why this change*
  and the skeptic *look out for*, tagged by importance and anchored to the first
  changed line. Every hunk is covered.
- **Overview tab** — plain-language PR summary, the explicit **intent** of the
  change, the **critical things** to verify before approving, and an
  understand-the-flow narrative that walks the change end to end.
- **Changed Files + File Details** — sidebar accordions with per-file status,
  ±line counts, and a reviewed-state toggle that persists across window reloads.
- **Streaming chat** — a panel for Q&A about the PR, scoped to the file you have
  open, streaming in as the model responds.
- **Submit to GitHub** — write your own comments on diff lines and submit them as
  a single review: **comment**, **approve**, or **request changes**.
- **Progressive loading** — files and diffs open instantly; the AI review streams
  in behind them.
- **Local-first** — ARGUS drives your own `claude` and `gh` CLIs. Your code and
  diffs never leave your machine.
- **Zero-setup demo** — a bundled fixture you can open offline, no `gh` or
  `claude` required.

## Install

Install **[ARGUS — AI PR Review](https://marketplace.visualstudio.com/items?itemName=ankitvashisht12.argus-review)**
from the VS Code Marketplace, or search for *ARGUS — AI PR Review* in the
Extensions view.

Prefer to sideload? Grab the `.vsix` from the
[Releases page](https://github.com/ankitvashisht12/argus/releases) and install it:

```sh
code --install-extension argus-review-0.1.5.vsix
```

### Requirements

- **VS Code** ≥ 1.90
- **[`gh`](https://cli.github.com) CLI** — installed and authenticated
  (`gh auth login`). Used to fetch PRs and submit reviews.
- **[`claude`](https://claude.com/claude-code) CLI** — logged in. Used to
  generate the AI review.

The `claude` CLI **degrades gracefully**: without it, the diff, files tree, and
GitHub submission all still work — only the AI notes are skipped, and they can be
regenerated once `claude` is available.

## Quickstart

1. `Cmd/Ctrl+Shift+P` → **ARGUS: Review PR…** and paste a PR URL (or
   `owner/repo#number`). Files open immediately; the review streams in.
2. No PR handy? Run **ARGUS: Open Demo Review (fixture)** to explore the whole
   experience offline with zero setup.

## How it works

**Engine + extension split.** The review engine (`engine/`) is pure TypeScript
with no `vscode` imports. It fetches the PR via `gh`, drives the `claude` CLI to
produce the review, and returns plain data structures. The extension (`vscode/`)
renders those on native surfaces. The engine can therefore grow other faces (see
[Roadmap](#roadmap)) without a rewrite.

**Hunk-alias anchoring — notes can't land on the wrong line.** The LLM never
emits line numbers. It emits request-local **hunk aliases** (`h1`, `h2`, …). A
normalizer then resolves those aliases against the parsed diff to compute the
real line anchors, dropping any it can't resolve. So a note is either anchored to
a real hunk or dropped — it can never mis-anchor.

**Local-first.** ARGUS shells out to the `claude` and `gh` CLIs already
installed on your machine. There is no ARGUS server, and your code, diffs, and
prompts are never sent anywhere except through the tools you already trust.
Results are cached by content hash, so reopening a PR is instant; the
**Regenerate Review** command bypasses the cache.

## Roadmap

- **Local branch diffs** — review uncommitted or unpushed work, not just GitHub PRs.
- **GitHub comment-thread sync** — pull existing review conversations into the UI.
- **More faces of the same engine** — a terminal TUI, a web app, and a desktop
  app, all backed by the UI-free `engine/`.

## Monorepo layout

npm workspaces:

| Path            | What it is                                                            |
| --------------- | -------------------------------------------------------------------- |
| `engine/`       | Pure TypeScript review core — no `vscode` imports, 107 unit tests.   |
| `vscode/`       | The VS Code extension — the only shipping face today, 55 tests.      |
| `landing-page/` | Static landing page.                                                 |
| `docs/`         | Design spec and the review-loop contract.                            |

## Development

```sh
npm install         # install all workspaces
npm test            # engine vitest + vscode vitest
npm run typecheck   # workspace tsc, no emit
npm run build       # engine tsc + vscode esbuild bundle
npm run lint        # eslint

# package the extension into a .vsix
npm run package --workspace vscode
```

> Always package via `npm run package` — it passes `--no-dependencies`. A bare
> `vsce package`/`vsce publish` follows the `@argus/engine` workspace symlink and
> would bundle the whole monorepo — git history, `node_modules` and all — into
> the VSIX.

## Contributing

Contributions are welcome. Open an issue to report a bug or float an idea, or
send a PR. Please run `npm test` and `npm run typecheck` before pushing, and use
[Conventional Commits](https://www.conventionalcommits.org) for commit messages.

## Credits

ARGUS adapts **mechanics only** — the `claude` CLI-adapter pattern, the
hunk-alias anchoring approach, and the `gh api` call shapes — from
[codiff](https://github.com/nkzw-tech/codiff) (MIT). Its prompts, review schema,
reviewer-skeptic framing, and intent pipeline are original. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full attribution.

Created by [Ankit Vashisht](https://ankitvashisht.in).

## License

MIT — see [LICENSE](LICENSE).
