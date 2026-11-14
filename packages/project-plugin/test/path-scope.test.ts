// 资料根范围与路径校验测试（tasks 3.3）。
// 覆盖：相对引用协议、越界、符号链接（逐段）、多硬链接写目标、非常规文件、
// 权限错误、大小写冲突检测（按实际平台记录）、范围内读取与目录列举。
// 临时目录放在包内 artifacts/。

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRelativePath } from '../src/domain/relative-path.js';
import {
  findCaseConflicts,
  listInScopeDirectory,
  readInScope,
  resolveInScope,
} from '../src/adapters/fs/path-scope.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

function codes(result: { ok: boolean; issues?: { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

test('相对引用协议：合法分段与各类非法写法', () => {
  assert.deepEqual(validateRelativePath('records/abc/def.md'), {
    ok: true,
    segments: ['records', 'abc', 'def.md'],
  });
  assert.equal(validateRelativePath('项目/说明.md').ok, true);

  const cases: [unknown, string][] = [
    ['', 'path-empty'],
    [42, 'path-not-string'],
    ['/etc/passwd', 'path-absolute'],
    ['C:/tmp/x', 'path-drive-letter'],
    ['records\\file.md', 'path-backslash'],
    ['records/a\0b.md', 'path-nul'],
    ['records//file.md', 'path-empty-segment'],
    ['records/./file.md', 'path-dot-segment'],
    ['records/../file.md', 'path-dot-segment'],
    ['records/%2e%2e/file.md', 'path-encoded-escape'],
    ['records/a%2Fb.md', 'path-encoded-escape'],
    ['records/a%20b.md', 'path-encoded-escape'],
  ];
  for (const [input, expected] of cases) {
    const result = validateRelativePath(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(result.ok ? null : result.error.code, expected, String(input));
  }
});

test('范围内解析：越界与绝对引用拒绝，正常路径返回根内绝对路径', async () => {
  const base = mkdtempSync(path.join(artifacts, 'scope-'));
  const root = path.join(base, 'data');
  mkdirSync(path.join(root, 'records', 'r1'), { recursive: true });
  writeFileSync(path.join(root, 'records', 'r1', 'a.md'), '# a\n');

  const ok = await resolveInScope(root, 'records/r1/a.md');
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.absolutePath, path.join(root, 'records', 'r1', 'a.md'));
  assert.equal(ok.root, path.join(root));

  const escape = await resolveInScope(root, '../outside.md');
  assert.deepEqual(codes(escape), ['scope-path-dot-segment']);

  const absolute = await resolveInScope(root, '/etc/passwd');
  assert.deepEqual(codes(absolute), ['scope-path-absolute']);

  const missing = await resolveInScope(root, 'records/missing.md');
  assert.deepEqual(codes(missing), ['scope-not-found']);
});

test('符号链接：文件与中间段一律拒绝，不跟随到根外', async () => {
  const base = mkdtempSync(path.join(artifacts, 'symlink-'));
  const root = path.join(base, 'data');
  const outside = path.join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.md'), 'secret\n');
  symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
  mkdirSync(path.join(root, 'records'), { recursive: true });
  symlinkSync(outside, path.join(root, 'records', 'linked-dir'));

  const fileLink = await resolveInScope(root, 'link.md');
  assert.deepEqual(codes(fileLink), ['scope-symlink']);

  const dirLink = await resolveInScope(root, 'records/linked-dir/secret.md');
  assert.deepEqual(codes(dirLink), ['scope-symlink']);

  const read = await readInScope(root, 'link.md');
  assert.deepEqual(codes(read), ['scope-symlink']);
});

test('硬链接：写目标有多个链接时拒绝，读取仍允许', async () => {
  const base = mkdtempSync(path.join(artifacts, 'hardlink-'));
  const root = path.join(base, 'data');
  mkdirSync(root, { recursive: true });
  const original = path.join(root, 'project.json');
  writeFileSync(original, '{}\n');
  linkSync(original, path.join(base, 'outside-link.json'));

  const write = await resolveInScope(root, 'project.json', { mode: 'write' });
  assert.deepEqual(codes(write), ['scope-hardlink']);

  const read = await resolveInScope(root, 'project.json', { mode: 'read' });
  assert.equal(read.ok, true, '读取不因硬链接被拒（只限制写入）');
});

test('非常规文件：FIFO 不当作资料文件', async () => {
  const base = mkdtempSync(path.join(artifacts, 'fifo-'));
  const root = path.join(base, 'data');
  mkdirSync(root, { recursive: true });
  const fifo = path.join(root, 'pipe.md');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    // 平台不支持 mkfifo（如部分 Windows 环境）：跳过该场景，不伪造结果。
    return;
  }
  const result = await resolveInScope(root, 'pipe.md');
  assert.deepEqual(codes(result), ['scope-not-regular-file']);
});

test('权限错误：不可读目录返回稳定码，不抛出裸异常', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // root 会绕过权限位，结果不具代表性。
    return;
  }
  const base = mkdtempSync(path.join(artifacts, 'perm-'));
  const root = path.join(base, 'data');
  const locked = path.join(root, 'locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(path.join(locked, 'a.md'), '# a\n');
  chmodSync(locked, 0o000);
  try {
    const result = await readInScope(root, 'locked/a.md');
    assert.deepEqual(codes(result), ['scope-permission-denied']);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('范围内读取：正常读取、超限拒绝、目录列举与 symlink 子目录拒绝', async () => {
  const base = mkdtempSync(path.join(artifacts, 'read-'));
  const root = path.join(base, 'data');
  mkdirSync(path.join(root, 'records', 'r1'), { recursive: true });
  writeFileSync(path.join(root, 'records', 'r1', 'a.md'), '# 正文\n');
  writeFileSync(path.join(root, 'records', 'r1', 'big.md'), 'x'.repeat(2048));

  const normal = await readInScope(root, 'records/r1/a.md');
  assert.equal(normal.ok, true);
  if (normal.ok) assert.equal(Buffer.from(normal.bytes).toString('utf8'), '# 正文\n');

  const tooLarge = await readInScope(root, 'records/r1/big.md', { maxBytes: 1024 });
  assert.deepEqual(codes(tooLarge), ['scope-too-large']);

  const listing = await listInScopeDirectory(root, 'records/r1');
  assert.equal(listing.ok, true);
  if (listing.ok) {
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ['a.md', 'big.md'],
    );
  }

  symlinkSync(path.join(base, 'outside-dir'), path.join(root, 'records', 'linked'));
  mkdirSync(path.join(base, 'outside-dir'), { recursive: true });
  const linkedListing = await listInScopeDirectory(root, 'records/linked');
  assert.deepEqual(codes(linkedListing), ['scope-symlink']);
});

test('大小写冲突：按实际平台记录结果，不假定文件系统大小写敏感度', async () => {
  const base = mkdtempSync(path.join(artifacts, 'case-'));
  const root = path.join(base, 'data');
  mkdirSync(root, { recursive: true });

  writeFileSync(path.join(root, 'Project.json'), '{"a":1}\n');
  let distinct = false;
  try {
    writeFileSync(path.join(root, 'project.json'), '{"b":2}\n', { flag: 'wx' });
    distinct = true;
  } catch {
    distinct = false;
  }

  const result = await findCaseConflicts(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  if (distinct) {
    // 大小写敏感文件系统（如 Linux ext4）：两个条目同时存在，应报告冲突。
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0]?.variants, ['Project.json', 'project.json']);
  } else {
    // 大小写不敏感文件系统（本机 macOS APFS）：无法并存，因此不存在冲突条目。
    assert.equal(existsSync(path.join(root, 'Project.json')), true);
    assert.equal(result.conflicts.length, 0);
  }
});
