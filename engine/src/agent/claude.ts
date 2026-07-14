/**
 * claude CLI adapter (mechanics adapted from codiff, MIT — see
 * THIRD-PARTY-NOTICES). Spawns the headless `claude` CLI with a forced JSON
 * schema, tools disabled, and no session persistence; feeds the prompt via
 * stdin; parses the `structured_output` envelope; enforces a timeout and falls
 * back to a secondary model on availability errors.
 *
 * The spawn primitive and CLI discovery are injectable so the adapter can be
 * unit-tested without a real `claude` binary (see engine/test/agent.test.ts).
 *
 * Pure Node — no `vscode`.
 *
 * @module
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import type {
  AgentResult,
  AgentRunOptions,
  ChatDelta,
  JsonSchema,
} from '../types.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Default primary model. */
export const DEFAULT_MODEL = 'claude-opus-4-8';
/** Default model to retry with on an availability error. */
export const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-5';
/** Default hard wall-clock timeout for a single CLI invocation. */
export const DEFAULT_TIMEOUT_MS = 90_000;

/* -------------------------------------------------------------------------- */
/* Structured-review timeout scaling                                           */
/* -------------------------------------------------------------------------- */

/**
 * Base wall-clock budget for a structured review, before any per-hunk / per-KB
 * additions. A tiny PR still gets this much headroom.
 */
export const REVIEW_TIMEOUT_BASE_MS = 120_000;
/**
 * Added budget per hunk. The review prompt now requires a note for *every*
 * hunk, so wall-clock cost grows roughly linearly with hunk count.
 */
export const REVIEW_TIMEOUT_PER_HUNK_MS = 15_000;
/** Added budget per kilobyte of digest text handed to the model. */
export const REVIEW_TIMEOUT_PER_KB_MS = 1_000;
/** Hard ceiling on the *computed* timeout, so a huge PR can't wedge forever. */
export const REVIEW_TIMEOUT_CAP_MS = 600_000;

/** Inputs for {@link computeReviewTimeoutMs} — the size levers of a digest. */
export interface ReviewTimeoutInput {
  /** Number of hunks the model must annotate (digest.hunks.length). */
  readonly hunkCount: number;
  /** Total characters of digest excerpt text (digest.totalChars). */
  readonly digestChars: number;
}

/**
 * Scale the structured-review timeout to the size of the work: a base budget
 * plus a per-hunk increment (one required note each) plus a per-KB increment
 * for the raw text volume, clamped to {@link REVIEW_TIMEOUT_CAP_MS}. Pure and
 * deterministic. Negative/NaN inputs are floored to zero so the result is never
 * below the base budget.
 */
export function computeReviewTimeoutMs(input: ReviewTimeoutInput): number {
  const hunks = Number.isFinite(input.hunkCount) ? Math.max(0, input.hunkCount) : 0;
  const chars = Number.isFinite(input.digestChars) ? Math.max(0, input.digestChars) : 0;
  const raw =
    REVIEW_TIMEOUT_BASE_MS +
    hunks * REVIEW_TIMEOUT_PER_HUNK_MS +
    Math.ceil(chars / 1024) * REVIEW_TIMEOUT_PER_KB_MS;
  return Math.min(raw, REVIEW_TIMEOUT_CAP_MS);
}

/**
 * Resolve the effective review timeout in milliseconds. A positive, finite
 * `overrideSeconds` (e.g. from a user setting) wins verbatim — the user's
 * explicit choice is honored and not clamped, so very large PRs can be given
 * more room than the auto cap. Anything else (0, undefined, null, NaN,
 * negative) falls back to the size-scaled {@link computeReviewTimeoutMs}.
 */
export function resolveReviewTimeoutMs(
  overrideSeconds: number | null | undefined,
  input: ReviewTimeoutInput,
): number {
  if (
    typeof overrideSeconds === 'number' &&
    Number.isFinite(overrideSeconds) &&
    overrideSeconds > 0
  ) {
    return Math.round(overrideSeconds * 1000);
  }
  return computeReviewTimeoutMs(input);
}

const NOT_FOUND_CODE = 'CLAUDE_NOT_FOUND';
const NOT_FOUND_MESSAGE =
  'The `claude` CLI was not found. Install Claude Code and confirm `claude --version` runs in your shell. ' +
  'Searched: $PATH, ~/.local/bin/claude, /opt/homebrew/bin/claude, /usr/local/bin/claude. ' +
  'If it lives elsewhere, set ARGUS_CLAUDE_PATH to its absolute path.';

/* -------------------------------------------------------------------------- */
/* Injectable spawn surface                                                    */
/* -------------------------------------------------------------------------- */

/** Minimal readable-stream surface the adapter consumes. */
export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** Minimal writable-stream (stdin) surface the adapter consumes. */
export interface WritableLike {
  on(event: 'error', listener: (err: Error) => void): unknown;
  end(chunk: string, callback?: () => void): unknown;
}

/** Minimal child-process surface the adapter drives. */
export interface ChildProcessLike {
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  readonly stdin: WritableLike | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Options passed to a {@link SpawnLike}. */
export interface SpawnLikeOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: readonly ('pipe' | 'ignore' | 'inherit')[];
}

/** A `child_process.spawn`-shaped function; the injection seam for tests. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnLikeOptions,
) => ChildProcessLike;

/** Construction-time dependencies for {@link ClaudeAgent}. */
export interface ClaudeAgentOptions {
  /** Spawn implementation (defaults to `node:child_process.spawn`). */
  readonly spawn?: SpawnLike;
  /** Explicit path to the `claude` binary; bypasses discovery when set. */
  readonly claudePath?: string;
  /** CLI-discovery function (defaults to PATH + well-known dirs). */
  readonly findCommand?: () => string;
}

const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(
    command,
    args as string[],
    options as SpawnOptions,
  ) as unknown as ChildProcessLike;

/* -------------------------------------------------------------------------- */
/* Pure helpers (mechanics adapted from codiff, MIT)                           */
/* -------------------------------------------------------------------------- */

/** Collapse whitespace, falling back to `fallback` for non-strings/blank. */
function oneLine(value: unknown, fallback = ''): string {
  return (typeof value === 'string' && value.trim() ? value : fallback)
    .replace(/\s+/g, ' ')
    .trim();
}

function notFoundError(detail?: string): Error {
  return Object.assign(
    new Error(detail ? `${NOT_FOUND_MESSAGE} ${detail}` : NOT_FOUND_MESSAGE),
    { code: NOT_FOUND_CODE },
  );
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as { code?: unknown }).code === NOT_FOUND_CODE ||
        (error as { code?: unknown }).code === 'ENOENT'),
  );
}

/** Heuristic: does this CLI error mean the requested model is unavailable? */
export function isModelAvailabilityError(message: string): boolean {
  return /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do(?:es not| not|n't) have access|access to model|403|404)\b/i.test(
    message,
  );
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command: string): string | null {
  const path = process.env.PATH;
  if (!path) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Default CLI discovery: ARGUS_CLAUDE_PATH → PATH → well-known dirs. */
function discoverClaude(): string {
  const explicit = process.env.ARGUS_CLAUDE_PATH?.trim();
  if (explicit) {
    if (isExecutableFile(explicit)) return explicit;
    throw notFoundError(
      `ARGUS_CLAUDE_PATH is set to ${JSON.stringify(explicit)}, but that file is not executable.`,
    );
  }
  const onPath = findOnPath('claude');
  if (onPath) return onPath;
  for (const path of [
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (isExecutableFile(path)) return path;
  }
  throw notFoundError();
}

/** Build argv for a schema-forced structured run. */
export function buildStructuredArgs(
  schema: JsonSchema,
  model: string,
  cwd?: string,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--model',
    model,
  ];
  if (cwd) args.push('--add-dir', cwd);
  args.push(
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--tools',
    '',
  );
  return args;
}

/** Build argv for a streaming chat run (NDJSON, no schema). */
export function buildStreamArgs(model: string, cwd?: string): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    model,
  ];
  if (cwd) args.push('--add-dir', cwd);
  args.push(
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--tools',
    '',
  );
  return args;
}

/* -------------------------------------------------------------------------- */
/* stream-json (NDJSON) parser                                                 */
/* -------------------------------------------------------------------------- */

interface StreamHandlers {
  onText(text: string): void;
  onThinking(text: string): void;
}

interface StreamParser {
  push(text: string): void;
  flush(): Record<string, unknown> | null;
}

/**
 * Line-oriented parser for the `claude --output-format stream-json` NDJSON
 * feed. Text/thinking deltas are surfaced through `handlers`; the terminal
 * `result` envelope is captured for the caller. (Mechanics adapted from codiff.)
 */
function createStreamParser(handlers: StreamHandlers): StreamParser {
  let buffer = '';
  let envelope: Record<string, unknown> | null = null;

  const handle = (input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    const obj = input as Record<string, unknown>;
    if (obj.type === 'result') {
      envelope = obj;
      return;
    }
    if (obj.type !== 'stream_event') return;
    const event = obj.event as Record<string, unknown> | undefined;
    if (!event || event.type !== 'content_block_delta') return;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta) return;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      handlers.onText(delta.text);
    } else if (
      delta.type === 'thinking_delta' &&
      typeof delta.thinking === 'string'
    ) {
      handlers.onThinking(delta.thinking);
    }
  };

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handle(JSON.parse(trimmed));
    } catch {
      // Non-JSON diagnostic lines are ignored; stderr carries real errors.
    }
  };

  return {
    push(text: string): void {
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    },
    flush(): Record<string, unknown> | null {
      const rest = buffer;
      buffer = '';
      consume(rest);
      return envelope;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Adapter over the local `claude` Code CLI.
 */
export class ClaudeAgent {
  private readonly spawnFn: SpawnLike;
  private readonly claudePath?: string;
  private readonly findCommand: () => string;

  constructor(options: ClaudeAgentOptions = {}) {
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.claudePath = options.claudePath;
    this.findCommand = options.findCommand ?? discoverClaude;
  }

  /**
   * Run a single structured (schema-forced) completion.
   *
   * Builds CLI args `-p --output-format json --json-schema <schema>
   * --model <model> [--add-dir <cwd>] --permission-mode dontAsk
   * --no-session-persistence --tools ''`, writes `prompt` to stdin, and
   * resolves the parsed `structured_output` envelope. On a model-availability
   * error it retries once with `opts.fallbackModel` (default
   * {@link DEFAULT_FALLBACK_MODEL}).
   *
   * @param prompt The full prompt text (sent on stdin).
   * @param schema JSON Schema the output must conform to.
   * @param opts   Model, timeout, cwd, and fallback options.
   * @returns The parsed structured output plus the model that produced it.
   */
  async runStructured<T = unknown>(
    prompt: string,
    schema: JsonSchema,
    opts?: AgentRunOptions,
  ): Promise<AgentResult<T>> {
    const model = opts?.model ?? DEFAULT_MODEL;
    const fallbackModel = opts?.fallbackModel ?? DEFAULT_FALLBACK_MODEL;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const invoke = async (activeModel: string): Promise<AgentResult<T>> => {
      const args = buildStructuredArgs(schema, activeModel, opts?.cwd);
      const { stdout } = await this.runProcess(
        args,
        prompt,
        timeoutMs,
        opts?.cwd,
        opts?.signal,
      );
      return parseStructuredEnvelope<T>(stdout, activeModel);
    };

    try {
      return await invoke(model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (model === fallbackModel || !isModelAvailabilityError(message)) {
        throw error;
      }
      const result = await invoke(fallbackModel);
      opts?.onModelFallback?.(fallbackModel, model);
      return result;
    }
  }

  /**
   * Run a streaming chat completion (`--output-format stream-json`), forwarding
   * incremental {@link ChatDelta}s to `onDelta` as NDJSON events arrive.
   *
   * @param prompt  The prompt text (sent on stdin).
   * @param opts    Model, timeout, cwd options.
   * @param onDelta Callback invoked for each streaming delta.
   * @returns The full concatenated assistant text when the stream completes.
   */
  async chatStream(
    prompt: string,
    opts: AgentRunOptions | undefined,
    onDelta: (delta: ChatDelta) => void,
  ): Promise<string> {
    const model = opts?.model ?? DEFAULT_MODEL;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = buildStreamArgs(model, opts?.cwd);

    let fullText = '';
    const parser = createStreamParser({
      onText: (text) => {
        fullText += text;
        onDelta({ type: 'text', text });
      },
      onThinking: (text) => onDelta({ type: 'thinking', text }),
    });

    try {
      await this.runProcess(
        args,
        prompt,
        timeoutMs,
        opts?.cwd,
        opts?.signal,
        (chunk) => parser.push(chunk),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onDelta({ type: 'error', text: oneLine(message, 'Claude Code failed.') });
      throw error;
    }

    const envelope = parser.flush();
    if (envelope?.is_error) {
      const text =
        typeof envelope.result === 'string' ? envelope.result : '';
      onDelta({
        type: 'error',
        text: oneLine(text, 'Claude Code reported an error.'),
      });
      onDelta({ type: 'done', text: '' });
      return fullText;
    }

    // No incremental text deltas (e.g. non-streaming server) — fall back to the
    // terminal envelope's result text so callers still receive the answer.
    if (!fullText && typeof envelope?.result === 'string') {
      fullText = envelope.result;
      if (fullText) onDelta({ type: 'text', text: fullText });
    }

    onDelta({ type: 'done', text: '' });
    return fullText;
  }

  /**
   * Check whether the `claude` CLI is installed and usable on this machine.
   *
   * @returns `true` if the CLI can be located, else `false`.
   */
  async isAvailable(): Promise<boolean> {
    try {
      return Boolean(this.resolveCommand());
    } catch {
      return false;
    }
  }

  private resolveCommand(): string {
    return this.claudePath ?? this.findCommand();
  }

  /**
   * Spawn the CLI, stream stdin, collect stdout/stderr, and enforce a timeout
   * and abort signal. Resolves with captured output on a clean (code 0) exit;
   * rejects on spawn error, non-zero exit, timeout, or abort.
   */
  private runProcess(
    args: readonly string[],
    prompt: string,
    timeoutMs: number,
    cwd: string | undefined,
    signal: AbortSignal | undefined,
    onStdout?: (chunk: string) => void,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let command: string;
      try {
        command = this.resolveCommand();
      } catch (error) {
        reject(
          isNotFoundError(error)
            ? notFoundError()
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let stdinError: Error | null = null;
      let finished = false;

      const child = this.spawnFn(command, args, {
        cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settleReject = (error: Error): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup();
        child.kill('SIGTERM');
        reject(new Error('Claude Code timed out.'));
      }, timeoutMs);

      const onAbort = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        child.kill('SIGTERM');
        reject(new Error('Claude Code run was aborted.'));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        onStdout?.(text);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin?.on('error', (error) => {
        stdinError = error;
      });
      child.on('error', (error) => {
        settleReject(
          isNotFoundError(error) ? notFoundError() : error,
        );
      });
      child.on('close', (code, closeSignal) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (code !== 0) {
          reject(
            new Error(
              oneLine(
                stderr || stdout || stdinError?.message,
                closeSignal
                  ? `Claude Code was terminated by ${closeSignal}.`
                  : `Claude Code exited with code ${code}.`,
              ),
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });

      child.stdin?.end(prompt, () => {});
    });
  }
}

/**
 * Parse the `--output-format json` envelope, preferring `structured_output`
 * over the free-text `result`. Throws on a reported error, malformed JSON, or
 * output that contains no usable structured payload.
 */
function parseStructuredEnvelope<T>(
  stdout: string,
  model: string,
): AgentResult<T> {
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    envelope = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Claude Code did not return JSON. ${oneLine(stdout)}`.trim());
  }

  const resultText =
    typeof envelope.result === 'string' ? envelope.result : '';

  if (envelope.is_error) {
    throw new Error(oneLine(resultText, 'Claude Code reported an error.'));
  }

  if (
    envelope.structured_output &&
    typeof envelope.structured_output === 'object'
  ) {
    const raw = JSON.stringify(envelope.structured_output);
    return { data: envelope.structured_output as T, model, raw };
  }

  // No structured_output: try to salvage JSON from the result text.
  if (resultText) {
    try {
      return { data: JSON.parse(resultText) as T, model, raw: resultText };
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Claude Code did not return structured output. ${oneLine(stdout)}`.trim(),
  );
}
