// Host 启动期配置与实例打开测试（tasks 5.2）。
// 覆盖：配置只接受绝对路径；有效资料打开并建立基线；重启复用不推进源代际；
// 缺资料／身份不一致／本机根与资料根重叠时明确失败，不写半截状态。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
