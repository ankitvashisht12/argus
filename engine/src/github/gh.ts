/**
 * `gh` CLI wrapper (API call shapes adapted from codiff, MIT — see
 * THIRD-PARTY-NOTICES). Reads PR metadata, files, and blobs, and submits PR
 * reviews via the `gh` CLI. Pure Node — no `vscode`.
 *
 * The `gh api` argv shapes (paginated `--slurp` file listing, base64 `contents`
 * fetch, `--method POST … --input -` review submission) and the pending-review
 * 422 diagnosis are adapted from codiff's `electron/git-state/pull-request.cjs`.
 * Product wording, schema, and public types are original to argus.
 *
 * @module
 */

import { spawn } from 'node:child_process';

import type {
  GhClient as IGhClient,
  PrFile,
  PullRequestMeta,
  ReviewComment,
  SubmitReviewInput,
} from '../types.js';

/* -------------------------------------------------------------------------- */
/* Injected process runner                                                     */
/* -------------------------------------------------------------------------- */

/** Result of running the `gh` CLI once. */
export interface GhExecResult {
  /** Captured stdout (utf8). */
  readonly stdout: string;
  /** Captured stderr (utf8). */
  readonly stderr: string;
  /** Process exit code (0 on success). */
  readonly code: number;
}

/** Options for a single `gh` invocation. */
export interface GhExecOptions {
  /** Data to write to the child's stdin, if any. */
  readonly stdin?: string;
}

/**
 * Runs `gh <args…>` and resolves its captured output. Injectable so tests can
 * assert exact argv/stdin without spawning a real process.
 */
export type GhExec = (
  args: readonly string[],
  options?: GhExecOptions,
) => Promise<GhExecResult>;

/** Default {@link GhExec} that spawns the real `gh` binary. */
export const defaultGhExec: GhExec = (args, options) =>
  new Promise<GhExecResult>((resolve, reject) => {
    const child = spawn('gh', [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? 0,
      });
    });
    if (options?.stdin != null) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** A non-zero `gh` exit, carrying its exit code and stderr for diagnosis. */
export class GhError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

/** Thrown by {@link GhClient.fetchBlob} when the file is absent on that side. */
export class BlobNotFoundError extends Error {
  constructor(
    readonly path: string,
    readonly ref: string,
  ) {
    super(`No file at ${path}@${ref} (absent on this side of the diff).`);
    this.name = 'BlobNotFoundError';
  }
}

/**
 * Thrown by {@link GhClient.submitReview} when a 422 is diagnosed as an existing
 * pending review by the current user.
 */
export class PendingReviewError extends Error {
  constructor(owner: string, repo: string, number: number) {
    super(
      `A pending review already exists on ${owner}/${repo}#${number}. ` +
        `Submit or discard it on GitHub, then retry.`,
    );
    this.name = 'PendingReviewError';
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Encode each path segment for a GitHub `contents/{path}` URL. */
function encodeContentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Decode a GitHub base64 blob payload (which is line-wrapped) to utf8 text. */
function decodeBase64(content: string): string {
  return Buffer.from(content, 'base64').toString('utf8');
}

/** Map a GitHub PR-file `status` string onto our {@link PrFile} status. */
function normalizeFileStatus(status: string): PrFile['status'] {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      // 'modified' | 'changed' | 'copied' | 'unchanged' → modified
      return 'modified';
  }
}

/** True when a {@link GhError} looks like an HTTP 404 / "Not Found". */
function isNotFound(error: unknown): error is GhError {
  return (
    error instanceof GhError &&
    /not found|http 404|\b404\b/i.test(`${error.message}\n${error.stderr}`)
  );
}

/** True when a {@link GhError} looks like an HTTP 422 validation failure. */
function isValidationError(error: unknown): error is GhError {
  return (
    error instanceof GhError &&
    /validation failed|http 422|\b422\b|unprocessable/i.test(
      `${error.message}\n${error.stderr}`,
    )
  );
}

/** Shape of one comment in the GitHub review-submission payload. */
interface GitHubReviewCommentPayload {
  path: string;
  line: number;
  body: string;
  side?: string;
  start_line?: number;
  start_side?: string;
}

/** Map an argus {@link ReviewComment} to GitHub's snake_case review comment. */
function toGitHubReviewComment(
  comment: ReviewComment,
): GitHubReviewCommentPayload {
  const payload: GitHubReviewCommentPayload = {
    path: comment.path,
    line: comment.line,
    body: comment.body,
  };
  if (comment.side) {
    payload.side = comment.side;
  }
  if (
    typeof comment.startLine === 'number' &&
    comment.startLine !== comment.line
  ) {
    payload.start_line = comment.startLine;
    payload.start_side = comment.startSide ?? comment.side ?? 'RIGHT';
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Concrete {@link IGhClient} that shells out to the `gh` CLI.
 *
 * The `exec` runner is injectable for testing; it defaults to spawning the real
 * `gh` binary.
 */
export class GhClient implements IGhClient {
  readonly #exec: GhExec;

  constructor(exec: GhExec = defaultGhExec) {
    this.#exec = exec;
  }

  /** Run `gh <args…>`, throwing {@link GhError} on a non-zero exit. */
  async #run(args: readonly string[], stdin?: string): Promise<string> {
    const result = await this.#exec(
      args,
      stdin != null ? { stdin } : undefined,
    );
    if (result.code !== 0) {
      const message =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `gh exited with code ${result.code}`;
      throw new GhError(message, result.code, result.stderr);
    }
    return result.stdout;
  }

  /**
   * Resolve PR identity + revision metadata via
   * `gh api repos/{owner}/{repo}/pulls/{number}`.
   */
  async prMeta(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestMeta> {
    const raw = await this.#run(['api', `repos/${owner}/${repo}/pulls/${number}`]);
    const data = JSON.parse(raw) as {
      title?: string;
      body?: string | null;
      base?: { ref?: string; sha?: string };
      head?: { ref?: string; sha?: string };
      user?: { login?: string };
    };
    return {
      owner,
      repo,
      number,
      title: data.title ?? '',
      body: data.body ?? '',
      baseSha: data.base?.sha ?? '',
      headSha: data.head?.sha ?? '',
      baseRef: data.base?.ref ?? '',
      headRef: data.head?.ref ?? '',
      author: data.user?.login ?? '',
    };
  }

  /**
   * Fetch the raw unified diff for a PR via `gh pr diff <number> --repo o/r`.
   */
  async prDiff(owner: string, repo: string, number: number): Promise<string> {
    return this.#run([
      'pr',
      'diff',
      String(number),
      '--repo',
      `${owner}/${repo}`,
    ]);
  }

  /**
   * List changed files for a PR via a paginated
   * `gh api repos/{owner}/{repo}/pulls/{number}/files`.
   */
  async prFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PrFile[]> {
    const raw = await this.#run([
      'api',
      '--paginate',
      '--slurp',
      `repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    ]);
    const pages = JSON.parse(raw) as Array<
      Array<{
        filename?: string;
        previous_filename?: string;
        status?: string;
        additions?: number;
        deletions?: number;
      }>
    >;
    const files: PrFile[] = [];
    for (const page of pages) {
      for (const file of page) {
        if (!file.filename) {
          continue;
        }
        const entry: PrFile = {
          path: file.filename,
          status: normalizeFileStatus(file.status ?? 'modified'),
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          ...(file.previous_filename
            ? { previousPath: file.previous_filename }
            : {}),
        };
        files.push(entry);
      }
    }
    return files;
  }

  /**
   * Fetch file content by blob SHA or `"<path>@<ref>"` locator.
   *
   * For a `path@ref` locator: `gh api repos/{o}/{r}/contents/{path}?ref={ref}`
   * returns base64 content, decoded here; files too large for the contents API
   * (>1 MB) come back with an empty body plus a `sha`, so we fall back to
   * `gh api repos/{o}/{r}/git/blobs/{sha}`. For a bare blob SHA we hit the
   * blob endpoint directly.
   *
   * @throws {BlobNotFoundError} when the file is absent on that side (HTTP 404).
   */
  async fetchBlob(owner: string, repo: string, ref: string): Promise<string> {
    const at = ref.lastIndexOf('@');
    if (at > 0) {
      const path = ref.slice(0, at);
      const gitRef = ref.slice(at + 1);
      return this.#fetchContents(owner, repo, path, gitRef);
    }
    return this.#fetchBlobBySha(owner, repo, ref);
  }

  async #fetchContents(
    owner: string,
    repo: string,
    path: string,
    gitRef: string,
  ): Promise<string> {
    const url = `repos/${owner}/${repo}/contents/${encodeContentPath(
      path,
    )}?ref=${encodeURIComponent(gitRef)}`;
    let raw: string;
    try {
      raw = await this.#run(['api', url]);
    } catch (error) {
      if (isNotFound(error)) {
        throw new BlobNotFoundError(path, gitRef);
      }
      throw error;
    }
    const data = JSON.parse(raw) as {
      content?: string;
      encoding?: string;
      sha?: string;
    };
    if (Array.isArray(data)) {
      throw new Error(`Path ${path} is a directory, not a file.`);
    }
    if (
      data.encoding === 'base64' &&
      typeof data.content === 'string' &&
      data.content.length > 0
    ) {
      return decodeBase64(data.content);
    }
    // Large file (>1 MB): contents API returns an empty body + a blob SHA.
    if (typeof data.sha === 'string' && data.sha.length > 0) {
      return this.#fetchBlobBySha(owner, repo, data.sha);
    }
    // Genuinely empty file.
    if (data.encoding === 'base64') {
      return decodeBase64(data.content ?? '');
    }
    throw new Error(`Unexpected contents response for ${path}@${gitRef}.`);
  }

  async #fetchBlobBySha(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<string> {
    let raw: string;
    try {
      raw = await this.#run(['api', `repos/${owner}/${repo}/git/blobs/${sha}`]);
    } catch (error) {
      if (isNotFound(error)) {
        throw new BlobNotFoundError(sha, sha);
      }
      throw error;
    }
    const data = JSON.parse(raw) as { content?: string };
    return decodeBase64(data.content ?? '');
  }

  /**
   * Submit a PR review with inline comments and an event via
   * `gh api --method POST repos/{o}/{r}/pulls/{n}/reviews --input -`, with the
   * JSON payload on stdin. Diagnoses the 422 "pending review already exists"
   * case with a clear {@link PendingReviewError}.
   */
  async submitReview(
    owner: string,
    repo: string,
    number: number,
    input: SubmitReviewInput,
  ): Promise<void> {
    const body = input.body?.trim() ?? '';
    if (input.event === 'COMMENT' && input.comments.length === 0 && !body) {
      throw new Error(
        'A COMMENT review requires at least one inline comment or a body.',
      );
    }
    const payload = {
      event: input.event,
      body,
      comments: input.comments.map(toGitHubReviewComment),
    };
    try {
      await this.#run(
        [
          'api',
          '--method',
          'POST',
          `repos/${owner}/${repo}/pulls/${number}/reviews`,
          '--input',
          '-',
        ],
        JSON.stringify(payload),
      );
    } catch (error) {
      if (isValidationError(error)) {
        const pending = await this.#hasPendingReview(
          owner,
          repo,
          number,
        ).catch(() => false);
        if (pending) {
          throw new PendingReviewError(owner, repo, number);
        }
      }
      throw error;
    }
  }

  /** True if the current user already has a PENDING review on the PR. */
  async #hasPendingReview(
    owner: string,
    repo: string,
    number: number,
  ): Promise<boolean> {
    const raw = await this.#run([
      'api',
      '--paginate',
      '--slurp',
      `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
    ]);
    const pages = JSON.parse(raw) as Array<Array<{ state?: string }>>;
    return pages.some((page) =>
      page.some((review) => review?.state === 'PENDING'),
    );
  }

  /** Whether the `gh` binary is installed and runnable (`gh --version`). */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.#exec(['--version']);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /** Whether `gh` is authenticated for API access (`gh auth status`). */
  async isAuthed(): Promise<boolean> {
    try {
      const result = await this.#exec(['auth', 'status']);
      return result.code === 0;
    } catch {
      return false;
    }
  }
}
