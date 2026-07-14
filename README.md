# ARGUS

AI-first pull-request review, inside VS Code.

ARGUS fetches a GitHub PR, generates a review through a **reviewer-skeptic lens**,
and renders it entirely on VS Code's native surfaces — the changed-files tree, the
built-in diff viewer, and comment threads. No separate web app or terminal UI to
switch to.

The skeptic lens is the point. For each hunk ARGUS asks two questions a careful
human reviewer would ask:

- **Why this change** — what the diff is actually doing, in plain language.
- **Look out for** — what could go wrong, what to double-check, what the author
  may have missed.

On top of that it produces a PR-level pass: the **intent** of the change, the
**critical things** to verify before approving, and an **understand-the-flow**
narrative that walks the change end to end.

GitHub PRs are the v1 (and only) source. Other forges may come later.

<!-- TODO(screenshots): add screenshots/GIFs here — files tree + per-hunk threads, the Overview tab, and the Submit Review flow. -->

## Requirements

- **VS Code** ≥ 1.90
- **[`gh`](https://cli.github.com) CLI**, installed and authenticated
  (`gh auth login`). Used to fetch PRs and to submit reviews.
- **[`claude`](https://claude.com/claude-code) CLI**, logged in. Used to generate
  the AI review.

The `claude` CLI is optional and **degrades gracefully**: without it, the diff,
files tree, and GitHub submission still work — only the AI notes are skipped, and
they can be regenerated once `claude` is available.

## Install

From the packaged extension (available today):

```sh
code --install-extension vscode/argus-review-0.1.0.vsix
```

VS Code Marketplace: **coming soon.**

## Quickstart

1. `Cmd+Shift+P` → **ARGUS: Review PR…** and paste a PR URL (or `owner/repo#number`).
2. Or, to try it with zero setup, run **ARGUS: Open Demo Review (fixture)** — it
   loads a bundled fixture offline, no `gh` or `claude` required.

## The surfaces

Everything lives in the ARGUS activity-bar container and VS Code's native panels:

- **Changed-files tree** — per-file status, ±line counts, and a reviewed-state
  toggle that persists across window reloads.
- **Native diff** — base vs head, served by a virtual `argus://` document
  provider, so it looks and behaves like any other VS Code diff.
- **AI comment threads** — per-hunk notes rendered as collapsed comment threads:
  the *why this change* and the skeptic *look out for*, tagged by importance.
- **Overview tab** — plain-language summary, explicit **intent**, the critical
  things to verify, and the understand-the-flow narrative.
- **Sidebar chat** — streaming Q&A about the PR, scoped to the file you have open.
- **Submit Review to GitHub** — add your own comments on diff lines, then submit
  them as a single GitHub review: comment, **approve**, or **request changes**.

## Monorepo layout

npm workspaces:

| Path            | What it is                                                              |
| --------------- | ---------------------------------------------------------------------- |
| `engine/`       | Pure TypeScript review core — no `vscode` imports, fully unit-tested.   |
| `vscode/`       | The VS Code extension — the only shipping face today.                   |
| `landing-page/` | Static landing page.                                                    |
| `docs/`         | Design spec and the review-loop contract.                              |

Web and TUI faces are planned; the UI-free engine exists so they can be added
without rewriting the core.

## Development

```sh
npm install        # install all workspaces
npm test           # engine vitest + vscode vitest
npm run typecheck   # workspace tsc, no emit
npm run build       # engine tsc + vscode esbuild bundle
npm run lint        # eslint

# package the extension into a .vsix
npm run package --workspace vscode
```

> Always package via `npm run package` (it passes `--no-dependencies`). A bare
> `vsce package`/`vsce publish` follows the `@argus/engine` workspace symlink
> and would bundle the whole monorepo — git history, node_modules and all —
> into the VSIX.

## Architecture

The **engine is UI-free** — it knows nothing about VS Code. It fetches the PR via
`gh`, drives the `claude` CLI to produce the review, and returns plain data
structures the extension renders.

The load-bearing detail is **hunk-ID anchoring**, which keeps AI notes from ever
mis-anchoring. The LLM never emits line numbers; it emits request-local **hunk
aliases**. A normalizer then resolves those aliases against the parsed diff to
compute the actual line anchors, dropping any it can't resolve. So a note is
either anchored to a real hunk or dropped — it can't land on the wrong line.

## Credits

ARGUS adapts **mechanics only** — the `claude` CLI-adapter pattern, the hunk-ID
anchoring approach, and the `gh api` call shapes — from
[codiff](https://github.com/nkzw-tech/codiff) (MIT). Its prompts, review schema,
reviewer-skeptic framing, and intent pipeline are original. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full attribution.

ARGUS is the spiritual successor to **argus-go**, an earlier TUI-based reviewer;
the skeptic lens and intent pipeline carry over from that lineage.

## License

MIT — see [LICENSE](LICENSE).
