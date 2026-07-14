import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';

const SHA = 'abc1234';

describe('parseUnifiedDiff', () => {
  it('returns [] for empty / whitespace-only input', () => {
    expect(parseUnifiedDiff('', SHA)).toEqual([]);
    expect(parseUnifiedDiff('   \n  \n', SHA)).toEqual([]);
  });

  it('parses a modified file with two hunks and stable IDs', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      ' import x from "x";',
      '-const a = 1;',
      '+const a = 2;',
      '+const b = 3;',
      ' export default a;',
      '@@ -10,2 +11,2 @@ function foo()',
      '-  return 1;',
      '+  return 2;',
      '   done',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.path).toBe('src/app.ts');
    expect(f.oldPath).toBeUndefined();
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    expect(f.hunks).toHaveLength(2);

    expect(f.hunks[0].id).toBe(`src/app.ts:${SHA}:h1`);
    expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(f.hunks[0].patch.startsWith('@@ -1,3 +1,4 @@')).toBe(true);

    expect(f.hunks[1].id).toBe(`src/app.ts:${SHA}:h2`);
    expect(f.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 2, newStart: 11, newLines: 2 });
    expect(f.hunks[1].patch).toContain('function foo()');
  });

  it('parses an added file (new file mode, /dev/null old side)', () => {
    const diff = [
      'diff --git a/newfile.txt b/newfile.txt',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/newfile.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.status).toBe('added');
    expect(f.path).toBe('newfile.txt');
    expect(f.oldPath).toBeUndefined();
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(0);
    expect(f.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
  });

  it('parses a deleted file (deleted file mode, /dev/null new side)', () => {
    const diff = [
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    const f = files[0];
    expect(f.status).toBe('deleted');
    expect(f.path).toBe('gone.txt');
    expect(f.oldPath).toBeUndefined();
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(2);
    expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
  });

  it('parses a rename with similarity index and no body hunks', () => {
    const diff = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 100%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    const f = files[0];
    expect(f.status).toBe('renamed');
    expect(f.oldPath).toBe('old/name.ts');
    expect(f.path).toBe('new/name.ts');
    expect(f.hunks).toHaveLength(0);
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
  });

  it('parses a rename with a partial-content hunk', () => {
    const diff = [
      'diff --git a/old.ts b/renamed.ts',
      'similarity index 80%',
      'rename from old.ts',
      'rename to renamed.ts',
      'index 5555555..6666666 100644',
      '--- a/old.ts',
      '+++ b/renamed.ts',
      '@@ -1 +1 @@',
      '-old content',
      '+new content',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    const f = files[0];
    expect(f.status).toBe('renamed');
    expect(f.oldPath).toBe('old.ts');
    expect(f.path).toBe('renamed.ts');
    expect(f.hunks).toHaveLength(1);
    // Omitted counts default to 1.
    expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    expect(f.hunks[0].id).toBe(`renamed.ts:${SHA}:h1`);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
  });

  it('marks a binary file with status binary and zero hunks', () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      'index 7777777..8888888 100644',
      'GIT binary patch',
      'literal 8',
      'zcmV+0Fake0bytes',
      '',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    const f = files[0];
    expect(f.status).toBe('binary');
    expect(f.path).toBe('logo.png');
    expect(f.hunks).toHaveLength(0);
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
  });

  it('marks a "Binary files ... differ" file as binary', () => {
    const diff = [
      'diff --git a/img.jpg b/img.jpg',
      'index 9999999..aaaaaaa 100644',
      'Binary files a/img.jpg and b/img.jpg differ',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    expect(files[0].status).toBe('binary');
    expect(files[0].hunks).toHaveLength(0);
  });

  it('handles a mode-change-only entry as modified with no hunks', () => {
    const diff = [
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    const f = files[0];
    expect(f.status).toBe('modified');
    expect(f.path).toBe('script.sh');
    expect(f.hunks).toHaveLength(0);
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
  });

  it('handles no-newline-at-end-of-file markers without counting them', () => {
    const diff = [
      'diff --git a/eof.txt b/eof.txt',
      'index bbbbbbb..ccccccc 100644',
      '--- a/eof.txt',
      '+++ b/eof.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    const f = files[0];
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    expect(f.hunks[0].patch).toContain('\\ No newline at end of file');
  });

  it('parses a multi-file diff preserving order and per-file hunk ordinals', () => {
    const diff = [
      'diff --git a/one.ts b/one.ts',
      'index 1..2 100644',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/two.ts b/two.ts',
      'index 3..4 100644',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -1 +1,2 @@',
      ' keep',
      '+added',
      '@@ -5 +6 @@',
      '-x',
      '+y',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    expect(files.map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
    expect(files[0].hunks.map((h) => h.id)).toEqual([`one.ts:${SHA}:h1`]);
    expect(files[1].hunks.map((h) => h.id)).toEqual([
      `two.ts:${SHA}:h1`,
      `two.ts:${SHA}:h2`,
    ]);
    expect(files[1].additions).toBe(2);
    expect(files[1].deletions).toBe(1);
  });

  it('parses paths containing spaces via ---/+++ lines', () => {
    const diff = [
      'diff --git a/dir with space/file.txt b/dir with space/file.txt',
      'index 1..2 100644',
      '--- a/dir with space/file.txt',
      '+++ b/dir with space/file.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    expect(files[0].path).toBe('dir with space/file.txt');
    expect(files[0].hunks[0].id).toBe(`dir with space/file.txt:${SHA}:h1`);
  });

  it('ignores leading commit metadata before the first diff --git', () => {
    const diff = [
      'commit deadbeef',
      'Author: Someone <s@example.com>',
      '',
      '    a message',
      '',
      'diff --git a/z.ts b/z.ts',
      'index 1..2 100644',
      '--- a/z.ts',
      '+++ b/z.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff, SHA);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('z.ts');
  });
});
