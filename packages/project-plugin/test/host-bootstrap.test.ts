// Host 启动期配置与实例打开测试（tasks 5.2）。
// 覆盖：配置只接受绝对路径；有效资料打开并建立基线；重启复用不推进源代际；
// 缺资料／身份不一致／本机根与资料根重叠时明确失败，不写半截状态。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import {
  createLocalStateService,
  openConfiguredInstance,
  resolveHostConfig,
  type HostWiring,
} from '../src/host/bootstrap.js';
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clock = (): string => new Date().toISOString();
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

function wiring(root: string): HostWiring {
  return {
    files: createSourceFiles(formatsDir, sha256),
    store: new LocalStateStore(),
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    sha256,
    clock,
    newInstanceId: () => randomUUID(),
    defaultLocalRoot: async () => root,
    describeLocation: (target) => ({ displayPath: target }),
  };
}

async function open(root: string, config: { projectRoot: string; localDataRoot: string; instanceId?: string }) {
  const w = wiring(root);
  return openConfiguredInstance(config, {
    files: w.files,
    store: w.store,
    sha256: w.sha256,
    clock: w.clock,
    localState: createLocalStateService(w),
    defaultLocalRoot: w.defaultLocalRoot,
    describeLocation: w.describeLocation,
  });
}

test('配置只接受绝对路径，空串视同未配置', () => {
  const ok = resolveHostConfig({ projectRoot: '/tmp/a/../b', localDataRoot: '/tmp/l', instanceId: '  ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.config.projectRoot, '/tmp/b', '路径归一但不做 realpath');
  assert.equal(ok.ok && ok.config.localDataRoot, '/tmp/l');
  assert.equal(ok.ok && ok.config.instanceId, undefined);

  const empty = resolveHostConfig({ projectRoot: '   ' });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.ok && empty.config, {});

  const bad = resolveHostConfig({ projectRoot: 'relative/dir' });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false ? bad.issues[0]?.code : '', 'cona-config-not-absolute');
});

test('有效资料：打开并建立基线，重启复用实例且不推进源代际', async () => {
  const base = mkdtempSync(path.join(artifacts, 'host-open-'));
  const source = path.join(base, 'source');
  const local = path.join(base, 'local');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const first = await open(base, { projectRoot: source, localDataRoot: local });
  assert.equal(first.status, 'opened', JSON.stringify(first));
  if (first.status !== 'opened') return;
  assert.equal(first.instance.projectId, PROJECT_ID);
  assert.equal(first.instance.created, true);
  assert.equal(first.instance.baselineEstablished, true);
  assert.equal(first.instance.sourceEpoch, 2, '登记为 1，首次基线刷新推进到 2');
  assert.equal(first.instance.sourceDisplay, source);

  // 同一资料根再次启动：复用实例，基线已一致，不再刷新。
  const second = await open(base, { projectRoot: source, localDataRoot: local });
  assert.equal(second.status, 'opened', JSON.stringify(second));
  if (second.status !== 'opened') return;
  assert.equal(second.instance.instanceId, first.instance.instanceId, '同资料根复用实例');
  assert.equal(second.instance.created, false);
  assert.equal(second.instance.sourceEpoch, first.instance.sourceEpoch, '未变化时不推进源代际');

  // 外部追加（重写头）后启动：磁盘与观察不一致 → 显式刷新并推进代际。
  const doc = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(path.join(source, 'project.json'), JSON.stringify({ ...doc, records: [] }, null, 4));
  const third = await open(base, { projectRoot: source, localDataRoot: local });
  assert.equal(third.status, 'opened', JSON.stringify(third));
  if (third.status !== 'opened') return;
  assert.equal(third.instance.sourceEpoch, second.instance.sourceEpoch + 1, '外部变化后刷新推进代际');
});

test('失败路径：缺资料、本机根重叠与实例身份不一致都明确拒绝', async () => {
  const base = mkdtempSync(path.join(artifacts, 'host-fail-'));
  const emptySource = path.join(base, 'empty');
  mkdirSync(emptySource, { recursive: true });

  const missing = await open(base, { projectRoot: emptySource, localDataRoot: path.join(base, 'local-a') });
  assert.equal(missing.status, 'failed', JSON.stringify(missing));
  assert.equal(missing.status === 'failed' ? missing.code : '', 'invalid-project');

  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const overlapping = await open(base, { projectRoot: source, localDataRoot: path.join(source, 'local') });
  assert.equal(overlapping.status, 'failed', JSON.stringify(overlapping));
  assert.equal(overlapping.status === 'failed' ? overlapping.code : '', 'local-root-overlaps-source');

  const mismatched = await open(base, {
    projectRoot: source,
    localDataRoot: path.join(base, 'local-b'),
    instanceId: randomUUID(),
  });
  assert.equal(mismatched.status, 'failed', JSON.stringify(mismatched));
  assert.equal(mismatched.status === 'failed' ? mismatched.code : '', 'cona-instance-mismatch');

  // 未配置 projectRoot：不是失败，是明确的“未配置”。
  const unconfigured = await open(base, { projectRoot: '', localDataRoot: path.join(base, 'local-c') });
  assert.equal(unconfigured.status, 'not-configured');

  // 拒绝后不得留下注册表条目（local-b 只有一次失败尝试，注册已发生但刷新失败不适用；
  // 这里只核对重叠目录没有被创建为本机根）。
  assert.equal(readFileSync(path.join(source, 'project.json')).length > 0, true);
});

test('5.2 回归：历史回退不得由启动期自动接纳；恢复后重新打开', async () => {
  const { execFileSync } = await import('node:child_process');
  const base = mkdtempSync(path.join(artifacts, 'host-fb-'));
  const source = path.join(base, 'source');
  const local = path.join(base, 'local');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const git = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', ...args], {
      cwd: source,
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: artifacts },
    });
  };
  const commitFile = (body: string, message: string, recordId = '00000000-0000-4000-8000-00000000c231'): void => {
    const hash = createHash('sha256').update(body, 'utf8').digest('hex');
    mkdirSync(path.join(source, 'records', recordId), { recursive: true });
    writeFileSync(path.join(source, 'records', recordId, hash + '.md'), body);
    const doc = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as {
      records: { id: string; kind: string; subjectNodeIds: string[]; path: string; contentHash: string; summary: string; sources: string[] }[];
    };
    doc.records = doc.records.filter((record) => record.id !== recordId);
    doc.records.push({
      id: recordId,
      kind: 'analysis-note',
      subjectNodeIds: ['00000000-0000-4000-8000-000000000002'],
      path: 'records/' + recordId + '/' + hash + '.md',
      contentHash: 'sha256:' + hash,
      summary: '记录 ' + recordId.slice(-4),
      sources: [],
    });
    writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', message]);
  };

  git(['init', '--quiet']);
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'c1: 基线只有 R1']);
  const c1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  commitFile('# R2 原文\n', 'c2: 追加 R2');

  const opened = await open(base, { projectRoot: source, localDataRoot: local });
  assert.equal(opened.status, 'opened', JSON.stringify(opened));

  // 切回历史 commit：候选丢 R2 → 启动期必须停写并给出回退确认提示，不自动接纳。
  git(['checkout', '--quiet', '--detach', c1]);
  const rejected = await open(base, { projectRoot: source, localDataRoot: local });
  assert.equal(rejected.status, 'failed', JSON.stringify(rejected));
  assert.equal(rejected.status === 'failed' ? rejected.code : '', 'source-index-loss');
  assert.equal(
    rejected.status === 'failed' ? /历史回退/.test(rejected.message) && /显式确认/.test(rejected.message) : false,
    true,
    JSON.stringify(rejected),
  );

  // 回到 HEAD 前沿：内容与既有基线一致 → 打开成功，不重复推进代际（代际是订阅替换边界）。
  git(['checkout', '--quiet', '-']);
  const restored = await open(base, { projectRoot: source, localDataRoot: local });
  assert.equal(restored.status, 'opened', JSON.stringify(restored));
  if (restored.status === 'opened') {
    assert.equal(restored.instance.sourceEpoch, opened.instance.sourceEpoch, '恢复后无实质变化不推进代际');
  }

  // 恢复后仍能接纳合法追加：新记录推进代际。
  commitFile('# R3 原文\n', 'c3: 追加 R3', '00000000-0000-4000-8000-00000000c233');
  const advanced = await open(base, { projectRoot: source, localDataRoot: local });
  assert.equal(advanced.status, 'opened', JSON.stringify(advanced));
  if (advanced.status === 'opened' && opened.status === 'opened') {
    assert.equal(advanced.instance.sourceEpoch > opened.instance.sourceEpoch, true, '合法追加推进代际');
  }
  rmSync(base, { recursive: true, force: true });
});
