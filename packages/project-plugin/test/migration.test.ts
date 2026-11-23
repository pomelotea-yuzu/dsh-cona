// 事务化迁移与启动定位测试（tasks 1.4–1.5）。
// 覆盖：三位置迁移循环保持身份（C04）、四个持久断点注入与恢复（C05）、取消清理、
// 目标占用／重叠／非空冲突、迁移进行中拒绝刷新与登记抢占、旧 registry schema 1
// 升级、请求摘要重复确认、启动定位解析。真实文件后端 + 真实锁；临时目录在包内 artifacts/。

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createMigrationFiles } from '../src/adapters/fs/migration-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { readSourceBaseline } from '../src/application/baseline.js';
import { LocalStateService } from '../src/application/local-state.js';
import { MIGRATION_MARKER_NAME, MigrationService } from '../src/application/migration.js';
import type { MigrationHooks } from '../src/application/migration.js';
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localCli = path.join(packageRoot, 'lib', 'cli', 'local.js');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SAMPLE_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const SAMPLE_NODE_ID = '00000000-0000-4000-8000-000000000002';
const R1 = '00000000-0000-4000-8000-00000000c241';

function sha256Hex(text: string): string {
  return sha256(new Uint8Array(Buffer.from(text, 'utf8')));
}

function readDoc(source: string): any {
  return JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8'));
}

function writeDoc(source: string, doc: any): void {
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
}

/** 写一条记录正文并加入索引；records 不参与规划投影，planVersion 不变。 */
function addRecord(source: string, recordId: string, bodyText: string): string {
  const contentHash = 'sha256:' + sha256Hex(bodyText);
  const recordPath = `records/${recordId}/${contentHash.slice(7)}.md`;
  mkdirSync(path.join(source, 'records', recordId), { recursive: true });
  writeFileSync(path.join(source, ...recordPath.split('/')), bodyText);
  const doc = readDoc(source);
  doc.records = [
    ...doc.records.filter((record: any) => record.id !== recordId),
    { id: recordId, kind: 'analysis-note', subjectNodeIds: [SAMPLE_NODE_ID], path: recordPath, contentHash, summary: `记录 ${recordId}`, sources: [] },
  ];
  writeDoc(source, doc);
  return recordPath;
}

/** 目录内全部文件的相对路径（协议形态）。 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
    }
  };
  walk(root, '');
  return out.sort();
}

/** 目录内容指纹（全部文件相对路径 + 字节哈希）。 */
function fingerprint(root: string): string {
  const lines = listFiles(root).map((file) => `${file} ${sha256(new Uint8Array(readFileSync(path.join(root, ...file.split('/')))))}`);
  return sha256Hex(lines.join('\n'));
}

function makeSource(base: string, name: string): string {
  const source = path.join(base, name);
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  addRecord(source, R1, '# R1 迁移正文\n');
  return source;
}

interface Env {
  base: string;
  localRoot: string;
  local: LocalStateService;
  migration: MigrationService;
}

function makeEnv(base: string): Env {
  const localRoot = path.join(base, 'local');
  mkdirSync(localRoot, { recursive: true });
  const sourceFiles = createSourceFiles(formatsDir, sha256);
  const local = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: () => ({ inRepository: false, trackedFiles: [], ignored: true, checked: false }) },
    store: new LocalStateStore(),
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
    readBaseline: (root: string) => readSourceBaseline(sourceFiles, root, sha256, () => new Date().toISOString()),
    sha256,
  });
  const migration = new MigrationService({
    store: new LocalStateStore(),
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    readBaseline: (root: string) => readSourceBaseline(sourceFiles, root, sha256, () => new Date().toISOString()),
    files: createMigrationFiles(),
    candidatePathFor: (toRoot: string, operationId: string) => path.join(path.dirname(toRoot), `.cona-mig-${operationId}`),
    sha256,
    clock: () => new Date().toISOString(),
    newOperationId: () => randomUUID(),
    newOwnershipToken: () => randomUUID(),
  });
  return { base, localRoot, local, migration };
}

async function registerInstance(env: Env, source: string): Promise<string> {
  const result = await env.local.register({
    localDataRoot: env.localRoot,
    sourceRoot: source,
    sourceKind: 'custom',
    projectId: SAMPLE_PROJECT_ID,
  });
  assert.equal(result.ok, true, JSON.stringify((result as { issues?: unknown }).issues ?? {}));
  return (result as { entry: { instanceId: string } }).entry.instanceId;
}

async function refreshOnce(env: Env, instanceId: string, source: string): Promise<void> {
  const sourceFiles = createSourceFiles(formatsDir, sha256);
  const baseline = await readSourceBaseline(sourceFiles, source, sha256, () => new Date().toISOString());
  assert.equal(baseline.ok, true, JSON.stringify(baseline.ok === false ? baseline.issues : {}));
  const result = await env.local.refresh({
    localDataRoot: env.localRoot,
    instanceId,
    baseline: (baseline as { baseline: any }).baseline,
    source,
  });
  assert.equal(result.ok, true, JSON.stringify((result as { issues?: unknown }).issues ?? {}));
}

function testDir(prefix: string): string {
  const dir = mkdtempSync(path.join(artifacts, prefix));
  return dir;
}

// ---------- 1.4：三位置迁移循环保持身份 ----------

test('迁移在三种位置间循环推进，身份与旧根保留，写入只落新根', async () => {
  const base = testDir('mig-loop-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src-project');
  const instanceId = await registerInstance(env, source1);
  await refreshOnce(env, instanceId, source1);
  const before = fingerprint(source1);

  // 第一跳：项目目录 → DSH 数据目录。
  const dshTarget = path.join(base, 'dsh-home', 'data', 'dsh-cona', 'projects', SAMPLE_PROJECT_ID);
  const first = await env.migration.migrate({
    localDataRoot: env.localRoot,
    instanceId,
    toRoot: dshTarget,
    toKind: 'dsh-data',
  });
  assert.equal(first.ok, true, JSON.stringify(first.ok === false ? first.issues : {}));
  const firstRec = (first as any).record;
  assert.equal(firstRec.status, 'committed');
  assert.equal(firstRec.from.root, source1);
  assert.equal(firstRec.from.expectedGeneration, 2);
  assert.equal(firstRec.newGeneration, 3);
  assert.equal(firstRec.receipt.effectiveRoot, dshTarget);
  assert.equal(firstRec.requestDigest.startsWith('sha256:'), true);
  assert.equal((first as any).entry.sourceRoot, dshTarget);
  assert.equal((first as any).entry.sourceKind, 'dsh-data');
  assert.equal((first as any).aggregate.source.root, dshTarget);
  assert.equal((first as any).aggregate.source.generation, 3);
  assert.equal((first as any).aggregate.revisions.state, 1);
  // 旧根字节原样保留；目标逐字节等于冻结清单。
  assert.equal(fingerprint(source1), before);
  assert.equal(fingerprint(dshTarget), before);

  // 第二跳：DSH → 自定义目录。
  const customTarget = path.join(base, 'custom-data');
  const second = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId, toRoot: customTarget, toKind: 'custom' });
  assert.equal(second.ok, true, JSON.stringify(second.ok === false ? second.issues : {}));
  assert.equal((second as any).record.newGeneration, 4);
  assert.equal(fingerprint(dshTarget), before, '上一跳旧根保留');

  // 第三跳：自定义 → 项目目录的可用位置。
  const projectTarget = path.join(base, 'proj-final', '.dsh-cona-project');
  const third = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId, toRoot: projectTarget, toKind: 'project-directory' });
  assert.equal(third.ok, true, JSON.stringify(third.ok === false ? third.issues : {}));
  assert.equal((third as any).entry.sourceRoot, projectTarget);

  // registry schema 2，三次 committed，登记项保留。
  const registry = JSON.parse(readFileSync(path.join(env.localRoot, 'registry.json'), 'utf8'));
  assert.equal(registry.schemaVersion, 2);
  assert.equal(registry.instances.length, 1);
  assert.equal(registry.instances[0].instanceId, instanceId);
  assert.equal(registry.migrations.length, 3);
  for (const item of registry.migrations) assert.equal(item.status, 'committed');

  // 新写入只落新根：refresh 推进代际；带旧根来源的刷新被拒绝。
  await refreshOnce(env, instanceId, projectTarget);
  const stale = createSourceFiles(formatsDir, sha256);
  const staleBaseline = await readSourceBaseline(stale, source1, sha256, () => new Date().toISOString());
  const staleResult = await env.local.refresh({
    localDataRoot: env.localRoot,
    instanceId,
    baseline: (staleBaseline as { baseline: any }).baseline,
    source: source1,
  });
  assert.equal(staleResult.ok, false);
  assert.equal((staleResult as any).issues[0].code, 'source-location-mismatch');

  // 外部编辑旧根不影响当前实例；显式重接入旧根得到独立实例。
  const r1Path = (readDoc(source1).records as any[]).find((record) => record.id === R1).path as string;
  writeFileSync(path.join(source1, ...r1Path.split('/')), '# 旧根被外部修改\n');
  const reregistered = await env.local.register({
    localDataRoot: env.localRoot,
    sourceRoot: source1,
    sourceKind: 'custom',
    projectId: SAMPLE_PROJECT_ID,
  });
  assert.equal(reregistered.ok, true);
  assert.notEqual((reregistered as any).entry.instanceId, instanceId);
  assert.equal((reregistered as any).reused, false);
  rmSync(base, { recursive: true, force: true });
});

// ---------- 1.4：启动定位 ----------

test('启动定位解析到已迁移实例的有效定位，歧义时要求显式选择', async () => {
  const base = testDir('mig-startup-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src-a');
  const instanceId = await registerInstance(env, source1);
  const target = path.join(base, 'moved');
  const result = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId, toRoot: target, toKind: 'custom' });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : {}));

  // 配置仍指向旧根：解析到新定位（迁移）。
  const moved = await env.migration.resolveStartup({ localDataRoot: env.localRoot, configuredRoot: source1 });
  assert.equal(moved.ok, true, JSON.stringify(moved.ok === false ? moved.issues : {}));
  assert.equal((moved as any).migrated, true);
  assert.equal((moved as any).effectiveRoot, target);
  assert.equal((moved as any).instanceId, instanceId);

  // 配置指向有效定位：直接命中。
  const direct = await env.migration.resolveStartup({ localDataRoot: env.localRoot, configuredRoot: target });
  assert.equal(direct.ok, true);
  assert.equal((direct as any).migrated, false);

  // 旧根显式登记为另一实例后：歧义，按实例显式选择。
  await registerInstance(env, source1);
  const ambiguous = await env.migration.resolveStartup({ localDataRoot: env.localRoot, configuredRoot: source1 });
  assert.equal(ambiguous.ok, false);
  assert.equal((ambiguous as any).issues[0].code, 'startup-location-ambiguous');

  const unknown = await env.migration.resolveStartup({ localDataRoot: env.localRoot, configuredRoot: path.join(base, 'nowhere') });
  assert.equal(unknown.ok, false);
  assert.equal((unknown as any).issues[0].code, 'startup-location-unknown');
  rmSync(base, { recursive: true, force: true });
});

// ---------- 1.5：四个持久断点注入与恢复 ----------

test('断点一：prepared 后中断，恢复继续复制并提交；取消只清理候选', async () => {
  const base = testDir('mig-bp1-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src');
  const instanceId = await registerInstance(env, source1);
  const target = path.join(base, 'target');
  const hooks: MigrationHooks = { afterPrepared: async () => { throw new Error('inject-prepared'); } };
  const interrupted = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId, toRoot: target, toKind: 'custom' }, hooks);
  assert.equal(interrupted.ok, false);
  assert.equal((interrupted as any).record.status, 'prepared');
  assert.equal(existsSync(target), false);

  // 错误确认摘要拒绝；正确摘要恢复到 committed。
  const badConfirm = await env.migration.recover({
    localDataRoot: env.localRoot,
    operationId: (interrupted as any).record.operationId,
    confirmDigest: 'sha256:wrong',
  });
  assert.equal(badConfirm.ok, false);
  assert.equal((badConfirm as any).issues[0].code, 'migration-confirm-mismatch');

  const recovered = await env.migration.recover({
    localDataRoot: env.localRoot,
    operationId: (interrupted as any).record.operationId,
    confirmDigest: (interrupted as any).record.requestDigest,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.ok === false ? recovered.issues : {}));
  assert.equal((recovered as any).record.status, 'committed');
  assert.equal(fingerprint(target), fingerprint(source1));
  assert.equal(existsSync(path.join(path.dirname(target), `.cona-mig-${(interrupted as any).record.operationId}`)), false);
  rmSync(base, { recursive: true, force: true });

  // 取消路径：重新准备一个 prepared 后取消，候选被清理、目标从未出现。
  const base2 = testDir('mig-cancel1-');
  const env2 = makeEnv(base2);
  const source2 = makeSource(base2, 'src');
  const instance2 = await registerInstance(env2, source2);
  const target2 = path.join(base2, 'target');
  const op = await env2.migration.migrate({ localDataRoot: env2.localRoot, instanceId: instance2, toRoot: target2, toKind: 'custom' }, { afterPrepared: async () => { throw new Error('inject'); } });
  assert.equal(op.ok, false);
  const canceled = await env2.migration.cancel({
    localDataRoot: env2.localRoot,
    operationId: (op as any).record.operationId,
    confirmDigest: (op as any).record.requestDigest,
  });
  assert.equal(canceled.ok, true, JSON.stringify(canceled.ok === false ? canceled.issues : {}));
  assert.equal((canceled as any).record.status, 'canceled');
  // prepared 后候选尚未建立：无可清理项，目标从未出现。
  assert.deepEqual((canceled as any).record.cancel.removed, []);
  assert.equal(existsSync(target2), false);
  assert.equal(fingerprint(source2), fingerprint(makeSource(base2, 'src-reference')), '旧根原样保留');
  rmSync(base2, { recursive: true, force: true });
});

test('断点二：复制中途中断，恢复幂等重复制；候选含意外内容时拒绝', async () => {
  const base = testDir('mig-bp2-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src');
  const instanceId = await registerInstance(env, source1);
  const target = path.join(base, 'target');
  let copied = 0;
  const hooks: MigrationHooks = { duringCopy: async (count) => { if (count >= 1) { copied = count; throw new Error('inject-copy'); } } };
  const interrupted = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId, toRoot: target, toKind: 'custom' }, hooks);
  assert.equal(interrupted.ok, false);
  assert.equal(copied, 1);
  assert.equal((interrupted as any).record.status, 'prepared');
  // 候选残留：含所有权标记与部分文件。
  const candidate = path.join(path.dirname(target), `.cona-mig-${(interrupted as any).record.operationId}`);
  assert.equal(existsSync(path.join(candidate, MIGRATION_MARKER_NAME)), true);
  assert.equal(existsSync(target), false);

  const recovered = await env.migration.recover({
    localDataRoot: env.localRoot,
    operationId: (interrupted as any).record.operationId,
    confirmDigest: (interrupted as any).record.requestDigest,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.ok === false ? recovered.issues : {}));
  assert.equal((recovered as any).record.status, 'committed');
  assert.equal(fingerprint(target), fingerprint(source1));
  rmSync(base, { recursive: true, force: true });

  // 候选含意外内容：恢复与取消都拒绝清理，保留现场。
  const base2 = testDir('mig-cand-x-');
  const env2 = makeEnv(base2);
  const source2 = makeSource(base2, 'src');
  const instance2 = await registerInstance(env2, source2);
  const target2 = path.join(base2, 'target');
  const op = await env2.migration.migrate({ localDataRoot: env2.localRoot, instanceId: instance2, toRoot: target2, toKind: 'custom' }, { duringCopy: async () => { throw new Error('inject'); } });
  assert.equal(op.ok, false);
  const candidate2 = path.join(path.dirname(target2), `.cona-mig-${(op as any).record.operationId}`);
  writeFileSync(path.join(candidate2, 'unexpected.txt'), '外部内容');
  const rec = await env2.migration.recover({ localDataRoot: env2.localRoot, operationId: (op as any).record.operationId, confirmDigest: (op as any).record.requestDigest });
  assert.equal(rec.ok, false);
  assert.equal((rec as any).issues[0].code, 'migration-candidate-unverified');
  const can = await env2.migration.cancel({ localDataRoot: env2.localRoot, operationId: (op as any).record.operationId, confirmDigest: (op as any).record.requestDigest });
  assert.equal(can.ok, false);
  assert.equal((can as any).issues[0].code, 'migration-candidate-unverified');
  assert.equal(existsSync(candidate2), true, '候选保留现场');
  rmSync(base2, { recursive: true, force: true });
});

test('断点三：装入后定位切换前中断，恢复补切；取消清理候选与装入目标', async () => {
  const base = testDir('mig-bp3-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src');
  const instanceId = await registerInstance(env, source1);
  const target = path.join(base, 'target');
  const op = await env.migration.migrate(
    { localDataRoot: env.localRoot, instanceId, toRoot: target, toKind: 'custom' },
    { afterInstall: async () => { throw new Error('inject-install'); } },
  );
  assert.equal(op.ok, false);
  assert.equal((op as any).record.status, 'prepared');
  assert.equal(existsSync(target), true, '目标已装入');
  assert.equal(fingerprint(target), fingerprint(source1));

  // 恢复：目标已核对即复用，不重新复制，直接补 target-ready → 切换 → committed。
  const recovered = await env.migration.recover({
    localDataRoot: env.localRoot,
    operationId: (op as any).record.operationId,
    confirmDigest: (op as any).record.requestDigest,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.ok === false ? recovered.issues : {}));
  assert.equal((recovered as any).record.status, 'committed');
  assert.equal((recovered as any).entry.sourceRoot, target);
  rmSync(base, { recursive: true, force: true });

  // 取消：装入目标也逐字节核对后清理。
  const base2 = testDir('mig-cancel3-');
  const env2 = makeEnv(base2);
  const source2 = makeSource(base2, 'src');
  const instance2 = await registerInstance(env2, source2);
  const target2 = path.join(base2, 'target');
  const op2 = await env2.migration.migrate({ localDataRoot: env2.localRoot, instanceId: instance2, toRoot: target2, toKind: 'custom' }, { afterInstall: async () => { throw new Error('inject'); } });
  assert.equal(op2.ok, false);
  const can = await env2.migration.cancel({ localDataRoot: env2.localRoot, operationId: (op2 as any).record.operationId, confirmDigest: (op2 as any).record.requestDigest });
  assert.equal(can.ok, true, JSON.stringify(can.ok === false ? can.issues : {}));
  assert.equal(existsSync(target2), false, '装入目标被清理');
  assert.equal(((can as any).record.cancel.removed.includes(target2)), true);
  rmSync(base2, { recursive: true, force: true });
});

test('断点四：switched 后中断，恢复只补聚合与回执；重复恢复返回原回执', async () => {
  const base = testDir('mig-bp4-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src');
  const instanceId = await registerInstance(env, source1);
  await refreshOnce(env, instanceId, source1);
  const target = path.join(base, 'target');
  const op = await env.migration.migrate(
    { localDataRoot: env.localRoot, instanceId, toRoot: target, toKind: 'custom' },
    { afterSwitch: async () => { throw new Error('inject-switch'); } },
  );
  assert.equal(op.ok, false);
  assert.equal((op as any).record.status, 'switched');

  // switched 后不可取消。
  const can = await env.migration.cancel({ localDataRoot: env.localRoot, operationId: (op as any).record.operationId, confirmDigest: (op as any).record.requestDigest });
  assert.equal(can.ok, false);
  assert.equal((can as any).issues[0].code, 'migration-already-switched');

  const recovered = await env.migration.recover({
    localDataRoot: env.localRoot,
    operationId: (op as any).record.operationId,
    confirmDigest: (op as any).record.requestDigest,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.ok === false ? recovered.issues : {}));
  const rec = (recovered as any).record;
  assert.equal(rec.status, 'committed');
  assert.equal(rec.receipt.effectiveRoot, target);
  const aggregate = await new LocalStateStore().readAggregate(env.localRoot, instanceId);
  assert.equal((aggregate as any).source.root, target);
  assert.equal((aggregate as any).source.generation, 3);

  // 重复恢复：原回执原样返回。
  const again = await env.migration.recover({
    localDataRoot: env.localRoot,
    operationId: (op as any).record.operationId,
    confirmDigest: rec.requestDigest,
  });
  assert.equal(again.ok, true);
  assert.deepEqual((again as any).record.receipt, rec.receipt);
  rmSync(base, { recursive: true, force: true });
});

// ---------- 1.5：目标冲突、占用与并发拒绝 ----------

test('目标被其他实例占用、与来源重叠或非空时拒绝；迁移进行中拒绝刷新与登记抢占', async () => {
  const base = testDir('mig-conflict-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src-a');
  const sourceB = makeSource(base, 'src-b');
  const instanceA = await registerInstance(env, source1);
  const instanceB = await registerInstance(env, sourceB);

  // 占用：目标已登记为另一实例的资料根。
  const occupied = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId: instanceA, toRoot: sourceB, toKind: 'custom' });
  assert.equal(occupied.ok, false);
  assert.equal((occupied as any).issues[0].code, 'migration-target-occupied');

  // 重叠：目标在来源子树内。
  const nested = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId: instanceA, toRoot: path.join(source1, 'records'), toKind: 'custom' });
  assert.equal(nested.ok, false);
  assert.equal((nested as any).issues[0].code, 'migration-overlap');

  // 非空目标：装入前后防覆盖。
  const nonEmpty = path.join(base, 'non-empty');
  mkdirSync(nonEmpty, { recursive: true });
  writeFileSync(path.join(nonEmpty, 'existing.txt'), '外部内容');
  const notEmpty = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId: instanceA, toRoot: nonEmpty, toKind: 'custom' });
  assert.equal(notEmpty.ok, false);
  assert.equal((notEmpty as any).issues[0].code, 'migration-target-not-empty');
  assert.equal(readFileSync(path.join(nonEmpty, 'existing.txt'), 'utf8'), '外部内容');

  // 进行中迁移：再迁移与刷新都收到 migration-in-progress；登记到目标被拒。
  const target = path.join(base, 'target');
  const open = await env.migration.migrate(
    { localDataRoot: env.localRoot, instanceId: instanceA, toRoot: target, toKind: 'custom' },
    { afterPrepared: async () => { throw new Error('inject'); } },
  );
  assert.equal(open.ok, false);
  const again = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId: instanceA, toRoot: path.join(base, 'other'), toKind: 'custom' });
  assert.equal(again.ok, false);
  assert.equal((again as any).issues[0].code, 'migration-in-progress');

  const sourceFiles = createSourceFiles(formatsDir, sha256);
  const baseline = await readSourceBaseline(sourceFiles, source1, sha256, () => new Date().toISOString());
  const refreshed = await env.local.refresh({
    localDataRoot: env.localRoot,
    instanceId: instanceA,
    baseline: (baseline as { baseline: any }).baseline,
    source: source1,
  });
  assert.equal(refreshed.ok, false);
  assert.equal((refreshed as any).issues[0].code, 'migration-in-progress');

  const grabbed = await env.local.register({
    localDataRoot: env.localRoot,
    sourceRoot: target,
    sourceKind: 'custom',
    projectId: SAMPLE_PROJECT_ID,
  });
  assert.equal(grabbed.ok, false);
  assert.equal((grabbed as any).issues[0].code, 'migration-target-occupied');

  // 同操作号幂等重入：返回当前持久状态，不新开操作。
  const resume = await env.migration.migrate({
    localDataRoot: env.localRoot,
    instanceId: instanceA,
    toRoot: target,
    toKind: 'custom',
    operationId: (open as any).record.operationId,
  });
  assert.equal(resume.ok, true);
  assert.equal((resume as any).record.status, 'prepared');

  // 取消后目标释放，可重新迁移。
  const can = await env.migration.cancel({ localDataRoot: env.localRoot, operationId: (open as any).record.operationId, confirmDigest: (open as any).record.requestDigest });
  assert.equal(can.ok, true);
  const retry = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId: instanceA, toRoot: target, toKind: 'custom' });
  assert.equal(retry.ok, true, JSON.stringify(retry.ok === false ? retry.issues : {}));
  rmSync(base, { recursive: true, force: true });
});

test('恢复前旧根被改写或不可读时保留现场不继续；活动工作阻止迁移', async () => {
  const base = testDir('mig-guard-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src');
  const instanceId = await registerInstance(env, source1);
  const target = path.join(base, 'target');
  const op = await env.migration.migrate(
    { localDataRoot: env.localRoot, instanceId, toRoot: target, toKind: 'custom' },
    { afterPrepared: async () => { throw new Error('inject'); } },
  );
  assert.equal(op.ok, false);

  // 源被改写（同 ID 新哈希正文 + 索引同步）→ 冻结清单失配。
  addRecord(source1, R1, '# 源被改写\n');
  const drifted = await env.migration.recover({ localDataRoot: env.localRoot, operationId: (op as any).record.operationId, confirmDigest: (op as any).record.requestDigest });
  assert.equal(drifted.ok, false);
  assert.equal((drifted as any).issues[0].code, 'migration-source-changed');

  // 源不可读 → 保留现场。
  const broken = testDir('mig-guard2-');
  const env2 = makeEnv(broken);
  const source2 = makeSource(broken, 'src');
  const instance2 = await registerInstance(env2, source2);
  const target2 = path.join(broken, 'target');
  const op2 = await env2.migration.migrate({ localDataRoot: env2.localRoot, instanceId: instance2, toRoot: target2, toKind: 'custom' }, { afterPrepared: async () => { throw new Error('inject'); } });
  assert.equal(op2.ok, false);
  rmSync(source2, { recursive: true, force: true });
  const gone = await env2.migration.recover({ localDataRoot: env2.localRoot, operationId: (op2 as any).record.operationId, confirmDigest: (op2 as any).record.requestDigest });
  assert.equal(gone.ok, false);
  assert.equal((gone as any).issues[0].code, 'migration-source-unreadable');

  // 活动 workIntent 阻止迁移。
  const base3 = testDir('mig-work-');
  const env3 = makeEnv(base3);
  const source3 = makeSource(base3, 'src');
  const instance3 = await registerInstance(env3, source3);
  const aggregate = await new LocalStateStore().readAggregate(env3.localRoot, instance3);
  const now = new Date().toISOString();
  const withWork = {
    ...aggregate,
    workIntents: [
      {
        workIntentId: 'wi-1',
        nodeIds: [SAMPLE_NODE_ID],
        allowedActions: ['update'],
        reasonScope: 'local',
        purpose: '测试意图',
        origin: 'panel',
        baseline: { planVersion: 'x', planRevision: 0, sourceEpoch: 0 },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  await new LocalStateStore().writeAggregate(env3.localRoot, withWork as any);
  const blocked = await env3.migration.migrate({ localDataRoot: env3.localRoot, instanceId: instance3, toRoot: path.join(base3, 'target'), toKind: 'custom' });
  assert.equal(blocked.ok, false);
  assert.equal((blocked as any).issues[0].code, 'migration-work-pending');
  rmSync(base, { recursive: true, force: true });
  rmSync(broken, { recursive: true, force: true });
  rmSync(base3, { recursive: true, force: true });
});

// ---------- registry 兼容 ----------

test('旧 schema 1 注册表在首笔迁移时升级 schema 2 且登记项完整；schema 1 不得携带迁移记录', async () => {
  const base = testDir('mig-schema-');
  const env = makeEnv(base);
  const source1 = makeSource(base, 'src');
  const sourceB = makeSource(base, 'src-b');
  const instanceA = await registerInstance(env, source1);
  await registerInstance(env, sourceB);
  // register 写的是 schema 1。
  const raw = JSON.parse(readFileSync(path.join(env.localRoot, 'registry.json'), 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.migrations, undefined);

  const target = path.join(base, 'target');
  const result = await env.migration.migrate({ localDataRoot: env.localRoot, instanceId: instanceA, toRoot: target, toKind: 'custom' });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : {}));
  const upgraded = JSON.parse(readFileSync(path.join(env.localRoot, 'registry.json'), 'utf8'));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.instances.length, 2, '既有登记项完整保留');

  // schema 1 + 迁移记录：store 拒绝写入。
  const store = new LocalStateStore();
  let threw = '';
  try {
    await store.writeRegistry(env.localRoot, { schemaVersion: 1, instances: upgraded.instances, migrations: upgraded.migrations });
  } catch (error) {
    threw = (error as Error).message;
  }
  assert.ok(threw.includes('schema 2'), threw);
  rmSync(base, { recursive: true, force: true });
});

// ---------- CLI 冒烟（F 层辅助） ----------

function runCli(args: string[]): { status: number; json: any } {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [localCli, ...args], { encoding: 'utf8' });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  return { status, json: JSON.parse(stdout) };
}

test('CLI：migrate 链路、migrate-status、startup-location 独立进程可用', async () => {
  const base = testDir('mig-cli-');
  const localRoot = path.join(base, 'local');
  mkdirSync(localRoot, { recursive: true });
  const source = makeSource(base, 'src');
  const registered = runCli(['register', '--local-root', localRoot, '--source', source, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom']);
  assert.equal(registered.status, 0, JSON.stringify(registered.json));
  const instanceId = registered.json.entry.instanceId as string;
  runCli(['refresh', '--local-root', localRoot, '--instance', instanceId, '--source', source]);

  const target = path.join(base, 'target');
  const migrated = runCli(['migrate', '--local-root', localRoot, '--instance', instanceId, '--to', target, '--to-kind', 'custom']);
  assert.equal(migrated.status, 0, JSON.stringify(migrated.json));
  assert.equal(migrated.json.record.status, 'committed');
  const digest = migrated.json.record.requestDigest as string;
  const operationId = migrated.json.record.operationId as string;

  const status = runCli(['migrate-status', '--local-root', localRoot]);
  assert.equal(status.status, 0);
  assert.equal((status.json.migrations as any[]).length, 1);

  // 终态重复恢复按原回执返回。
  const recovered = runCli(['migrate-recover', '--local-root', localRoot, '--operation', operationId, '--confirm', digest]);
  assert.equal(recovered.status, 0, JSON.stringify(recovered.json));
  assert.deepEqual(recovered.json.record.receipt, migrated.json.record.receipt);

  const startup = runCli(['startup-location', '--local-root', localRoot, '--configured-root', source]);
  assert.equal(startup.status, 0, JSON.stringify(startup.json));
  assert.equal(startup.json.migrated, true);
  assert.equal(startup.json.effectiveRoot, target);

  const preview = runCli(['migrate-preview', '--local-root', localRoot, '--instance', instanceId, '--to', path.join(base, 'next'), '--to-kind', 'custom']);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  assert.equal(preview.json.ok, true);
  assert.equal(preview.json.from.root, target);
  rmSync(base, { recursive: true, force: true });
});
