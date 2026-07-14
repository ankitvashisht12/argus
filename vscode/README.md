# ARGUS — AI PR Review for VS Code

ARGUS fetches a GitHub pull request, reviews it through a **reviewer-skeptic
lens**, and presents it inside VS Code on native surfaces — the changed-files
tree, the built-in diff viewer, and comment threads. No separate web UI or TUI,
and nothing leaves your machine: it drives your own `claude` and `gh` CLIs
locally.

## Install

Install from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ankitvashisht12.argus-review),
or search for *ARGUS — AI PR Review* in the Extensions view.

## Features

- **Changed-files tree** with per-file status, ±line counts, and a reviewed-state
  toggle that persists across window reloads.
- **Native diff** (base vs head) served by a virtual `argus://` document provider.
- **Per-hunk AI notes** as collapsed comment threads: *why this change* and the
  skeptic *look out for*, tagged by importance.
- **Overview panel**: plain-language summary, explicit **intent**, critical things
  to verify, and an understand-the-flow narrative.
- **Sidebar chat**: streaming Q&A about the PR, scoped to the open file.
- **Submit to GitHub**: write review comments on diff lines and submit them as a
  single review — comment, approve, or request changes.

## Requirements

- **VS Code** ≥ 1.90.
- [`gh`](https://cli.github.com) — the GitHub CLI, installed and authenticated
  (`gh auth login`). Required to fetch PRs and submit reviews.
- [Claude Code](https://claude.com/claude-code) (`claude`) — optional. Without it
  the diff and files still open; the AI review is skipped and can be regenerated
  once `claude` is available.

## Usage

1. Run **ARGUS: Review PR…** and paste a PR URL or `owner/repo#number`.
2. Browse the changed files, open diffs, and read the per-hunk notes.
3. Open **ARGUS: Open Overview** for the summary / intent / critical / flow.
4. Add your own comments on diff lines, then **ARGUS: Submit Review to GitHub**.

Try it without a live PR via **ARGUS: Open Demo Review (fixture)** — a bundled
fixture that opens offline with zero setup.

## Roadmap

Local branch diffs, GitHub comment-thread sync, and additional faces of the same
engine — a terminal TUI, web app, and desktop app — are in progress. See the
[project README](https://github.com/ankitvashisht12/argus) for details.

## Commands

| Command | Description |
| --- | --- |
| `ARGUS: Review PR…` | Load a PR by URL or `owner/repo#number`. |
| `ARGUS: Open Overview` | Open the summary / intent / critical / flow panel. |
| `ARGUS: Regenerate Review` | Re-run the AI review, bypassing the cache. |
| `ARGUS: Submit Review to GitHub` | Submit draft comments as a GitHub review. |
| `ARGUS: Open Demo Review (fixture)` | Load the bundled demo fixture offline. |

## Credits

Created by [Ankit Vashisht](https://ankitvashisht.in). Vendored mechanics are
adapted from [codiff](https://github.com/nkzw-tech/codiff) (MIT) and attributed
in `THIRD-PARTY-NOTICES.md`.

## License

MIT. See `LICENSE`.
