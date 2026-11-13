// CLI 端到端测试（tasks 1.5）：在无 DSH 服务的子进程中校验样例、错误资料与未知字段资料；
// 校验不加载宿主、浏览器或模型服务，不执行资料脚本或远程引用。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(packageRoot, 'dist', 'src', 'cli', 'validate.js');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

function runCli(args: string[]): { status: number; stdout: string } {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  return { status, stdout };
}

test('check-file：合法样例通过，planVersion 与自报一致', () => {
  const { status, stdout } = runCli(['check-file', sample]);
  const parsed = JSON.parse(stdout) as { ok: boolean; planVersion: string };
  assert.equal(status, 0);
  assert.equal(parsed.ok, true);
  assert.match(parsed.planVersion, /^sha256:[0-9a-f]{64}$/);
});

for (const [fixture, expectedCode] of [
  ['err-missing-field.json', 'missing-field'],
  ['err-unknown-field.json', 'unknown-field'],
  ['err-duplicate-node.json', 'duplicate-node-id'],
  ['err-missing-parent.json', 'parent-not-found'],
  ['err-tree-cycle.json', 'parent-cycle'],
  ['err-dep-cycle.json', 'dependency-cycle'],
  ['err-plan-version-mismatch.json', 'plan-version-mismatch'],
  ['err-record-hash-mismatch.json', 'content-hash-path-mismatch'],
  ['err-dangling-subject.json', 'subject-node-not-found'],
  ['err-done-without-verification.json', 'completion-no-verification'],
] as const) {
  test(`check-file：错误资料 ${fixture} 以 ${expectedCode} 拒绝`, () => {
    const { status, stdout } = runCli(['check-file', path.join(packageRoot, 'test', 'fixtures', fixture)]);
    const parsed = JSON.parse(stdout) as { ok: boolean; issues: { code: string }[] };
    assert.equal(status, 1);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.issues.some((issue) => issue.code === expectedCode), JSON.stringify(parsed.issues));
  });
}

test('init + check：资料根骨架可建立并被校验', () => {
  const root = mkdtempSync(path.join(artifacts, 'cli-init-'));
  try {
    const init = runCli(['init', root]);
    assert.equal(init.status, 0, init.stdout);
    // 骨架没有 project.json：check 报 file-unreadable（明确失败而非崩溃）。
    const check = runCli(['check', root]);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /file-unreadable/);
    // 放入样例后应通过。
    cpSync(sample, path.join(root, 'project.json'));
    const checkOk = runCli(['check', root]);
    assert.equal(checkOk.status, 0, checkOk.stdout);
    // init 幂等保护：已有 project.json 时拒绝覆盖。
    const reInit = runCli(['init', root]);
    assert.equal(reInit.status, 1);
    assert.match(reInit.stdout, /init-target-not-empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check：孤立正文与哈希不符正文被拒绝', () => {
  const root = mkdtempSync(path.join(artifacts, 'cli-body-'));
  try {
    const doc = JSON.parse(readFileSync(sample, 'utf8')) as {
      planVersion: string;
      records: { id: string; kind: string; subjectNodeIds: string[]; path: string; contentHash: string; summary: string; sources: string[] }[];
    };
    const recordId = '00000000-0000-4000-8000-000000000020';
    const body = '# 观察正文\n\n内容一致。\n';
    const hash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
    doc.records.push({
      id: recordId,
      kind: 'analysis-note',
      subjectNodeIds: [],
      path: `records/${recordId}/${hash}.md`,
      contentHash: 'sha256:' + hash,
      summary: '正文一致',
      sources: [],
    });
    // 哈希变更后 planVersion 不变（records 不在投影内）。
    mkdirSync(path.join(root, 'records', recordId), { recursive: true });
    writeFileSync(path.join(root, 'project.json'), JSON.stringify(doc));
    writeFileSync(path.join(root, 'records', recordId, hash + '.md'), body);
    // 一致正文 + 一个孤立正文。
    writeFileSync(path.join(root, 'records', recordId, 'f'.repeat(64) + '.md'), '孤立正文');
    const { status, stdout } = runCli(['check', root]);
    const parsed = JSON.parse(stdout) as { ok: boolean; issues: { code: string; path: string }[] };
    assert.equal(status, 1);
    assert.ok(parsed.issues.some((issue) => issue.code === 'orphan-body' && issue.path.includes('f'.repeat(64))), JSON.stringify(parsed.issues));
    assert.ok(!parsed.issues.some((issue) => issue.code === 'body-hash-mismatch'), '一致正文不应报哈希不符');
    // 删除孤立正文后应通过。
    rmSync(path.join(root, 'records', recordId, 'f'.repeat(64) + '.md'));
    const okRun = runCli(['check', root]);
    assert.equal(okRun.status, 0, okRun.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compute-plan-version：显式计算期望指纹（忽略自报值，不写回）', () => {
  const { status, stdout } = runCli(['compute-plan-version', sample, '--print-canonical']);
  const parsed = JSON.parse(stdout) as { ok: boolean; planVersion: string; canonicalText: string };
  assert.equal(status, 0);
  assert.equal(parsed.planVersion, (JSON.parse(readFileSync(sample, 'utf8')) as { planVersion: string }).planVersion);
  assert.ok(parsed.canonicalText.startsWith('{"plan":'));
});
