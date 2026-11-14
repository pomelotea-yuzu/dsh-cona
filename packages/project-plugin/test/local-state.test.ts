// 本机根、注册表与单实例聚合测试（tasks 3.2）。
// 覆盖：本机根解析与显示、资料根／本机根互斥、Git 私有根三类结果（被忽略／未忽略／已跟踪）、
// 注册与复用、同项目双目录隔离、私有内容不入公开头、遗留锁与进程内重复写者、损坏注册表不覆盖。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { LOCAL_DATA_SEGMENTS } from '../src/application/local-state.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localCli = path.join(packageRoot, 'lib', 'cli', 'local.js');
const sourceCli = path.join(packageRoot, 'lib', 'cli', 'source.js');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const SAMPLE_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function run(cli: string, args: string[]): { status: number; json: Record<string, unknown> } {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  return { status, json: JSON.parse(stdout) as Record<string, unknown> };
}

type LocalResult = {
  ok: boolean;
  root?: { root: string; displayPath: string };
  privacy?: { inRepository: boolean; trackedFiles: string[]; ignored: boolean | 'unknown'; checked: boolean };
  entry?: { instanceId: string; projectId: string; sourceRoot: string; sourceGeneration: number };
  aggregate?: { instanceId: string; projectId: string; revisions: { plan: number; state: number } };
  reused?: boolean;
  entries?: { instanceId: string; sourceRoot: string; projectId: string }[];
  released?: boolean;
  issues?: { code: string; message: string; path?: string }[];
};

function asLocal(json: Record<string, unknown>): LocalResult {
  return json as unknown as LocalResult;
}

function issueCodes(result: LocalResult): string[] {
  return (result.issues ?? []).map((issue) => issue.code);
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

/** 造一份合法的公开资料根（供登记使用）。 */
function makeSource(base: string, name: string): string {
  const root = path.join(base, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'project.json'), readFileSync(sample));
  return root;
}

test('本机根解析：dshHome 默认分段、显式 localDataRoot 原样、缺省拒绝', () => {
  const base = mkdtempSync(path.join(artifacts, 'local-root-'));
  const home = path.join(base, 'home');

  const fromHome = resolveLocalRoot(
    { base: 'dsh-home', basePath: home, segments: [...LOCAL_DATA_SEGMENTS] },
    { homeDir: home },
  );
  assert.equal(fromHome.ok, true);
  if (!fromHome.ok) return;
  assert.equal(fromHome.root.root, path.join(home, 'data', 'dsh-cona', 'local'));
  assert.equal(fromHome.root.displayPath, path.join('~', 'data', 'dsh-cona', 'local'));

  const explicit = resolveLocalRoot({ base: 'explicit', basePath: path.join(base, 'my-local'), segments: [] }, { homeDir: home });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.ok ? explicit.root.root : null, path.join(base, 'my-local'));

  const missing = run(localCli, ['root']);
  assert.equal(missing.status, 1);
  assert.deepEqual(issueCodes(asLocal(missing.json)), ['local-root-missing']);

  const relative = run(localCli, ['root', '--local-root', 'relative/local']);
  assert.equal(relative.status, 1);
  assert.deepEqual(issueCodes(asLocal(relative.json)), ['location-root-not-absolute']);
});

test('根关系：same／nested／disjoint 三态', () => {
  const base = path.join(path.sep, 'tmp', 'cona-rel');
  assert.equal(rootRelation(base, base), 'same');
  assert.equal(rootRelation(path.join(base, 'a'), base), 'nested');
  assert.equal(rootRelation(base, path.join(base, 'b')), 'nested');
  assert.equal(rootRelation(path.join(base, 'a'), path.join(base, 'b')), 'disjoint');
});

test('本机根与公开资料根不得相同或互相包含', () => {
  const base = mkdtempSync(path.join(artifacts, 'overlap-'));
  const source = makeSource(base, 'source');

  for (const [caseName, localRoot] of [
    ['相同', source],
    ['本机根在资料根内', path.join(source, 'local')],
    ['本机根包含资料根', base],
  ] as const) {
    const result = run(localCli, ['root', '--local-root', localRoot, '--source', source]);
    assert.equal(result.status, 1, caseName);
    assert.deepEqual(issueCodes(asLocal(result.json)), ['local-root-overlaps-source'], caseName);
  }
});

test('Git 私有根：被忽略放行、未忽略与已跟踪拒绝', (t) => {
  if (!gitAvailable()) {
    t.skip('git 不可用');
    return;
  }
  const base = mkdtempSync(path.join(artifacts, 'repo-guard-'));
  const repo = path.join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  writeFileSync(path.join(repo, '.gitignore'), 'ignored-local/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: repo });

  const source = makeSource(base, 'source');

  const ignored = run(localCli, ['root', '--local-root', path.join(repo, 'ignored-local'), '--source', source]);
  const ignoredResult = asLocal(ignored.json);
  assert.equal(ignored.status, 0, JSON.stringify(ignored.json));
  assert.equal(ignoredResult.privacy?.inRepository, true);
  assert.equal(ignoredResult.privacy?.ignored, true);
  assert.deepEqual(ignoredResult.privacy?.trackedFiles, []);

  // 未忽略目录：仓库内新建但既未跟踪、也未被 ignore 覆盖。
  mkdirSync(path.join(repo, 'plain-local'), { recursive: true });
  const notIgnored = run(localCli, ['root', '--local-root', path.join(repo, 'plain-local'), '--source', source]);
  assert.equal(notIgnored.status, 1);
  assert.deepEqual(issueCodes(asLocal(notIgnored.json)), ['local-root-not-ignored']);

  // 已跟踪内容：把文件加入索引后再检查。
  mkdirSync(path.join(repo, 'tracked-local'), { recursive: true });
  writeFileSync(path.join(repo, 'tracked-local', 'keep.md'), '# 已跟踪\n');
  execFileSync('git', ['add', 'tracked-local/keep.md'], { cwd: repo });
  const tracked = run(localCli, ['root', '--local-root', path.join(repo, 'tracked-local'), '--source', source]);
  assert.equal(tracked.status, 1);
  assert.deepEqual(issueCodes(asLocal(tracked.json)), ['local-root-tracked']);
});

test('register：首次登记生成实例与聚合，重复登记复用同一实例', () => {
  const base = mkdtempSync(path.join(artifacts, 'register-'));
  const localRoot = path.join(base, 'local');
  const source = makeSource(base, 'source');

  const first = run(localCli, [
    'register',
    '--local-root', localRoot,
    '--source', source,
    '--project-id', SAMPLE_PROJECT_ID,
    '--kind', 'custom',
  ]);
  const firstResult = asLocal(first.json);
  assert.equal(first.status, 0, JSON.stringify(first.json));
  assert.equal(firstResult.reused, false);
  const instanceId = firstResult.entry?.instanceId;
  assert.match(instanceId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(firstResult.entry?.sourceGeneration, 1);
  assert.deepEqual(firstResult.aggregate?.revisions, { plan: 0, state: 0 });

  const statePath = path.join(localRoot, 'instances', instanceId ?? '', 'state.json');
  const registryPath = path.join(localRoot, 'registry.json');
  assert.ok(existsSync(statePath), '实例聚合应落盘');
  assert.ok(existsSync(registryPath), '注册表应落盘');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { schemaVersion: number; instances: unknown[] };
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.instances.length, 1);

  const again = run(localCli, [
    'register',
    '--local-root', localRoot,
    '--source', source,
    '--project-id', SAMPLE_PROJECT_ID,
    '--kind', 'custom',
  ]);
  const againResult = asLocal(again.json);
  assert.equal(again.status, 0, JSON.stringify(again.json));
  assert.equal(againResult.reused, true);
  assert.equal(againResult.entry?.instanceId, instanceId);
  const registryAfter = JSON.parse(readFileSync(registryPath, 'utf8')) as { instances: unknown[] };
  assert.equal(registryAfter.instances.length, 1, '重复登记不得新增实例');

  const listed = run(localCli, ['list', '--local-root', localRoot]);
  assert.equal(listed.status, 0);
  assert.equal(asLocal(listed.json).entries?.length, 1);

  const shown = run(localCli, ['show', '--local-root', localRoot, '--instance', instanceId ?? '']);
  assert.equal(shown.status, 0);
  assert.equal(asLocal(shown.json).aggregate?.instanceId, instanceId);
});

test('register：同一资料根换了项目 id 拒绝静默复用', () => {
  const base = mkdtempSync(path.join(artifacts, 'identity-'));
  const localRoot = path.join(base, 'local');
  const source = makeSource(base, 'source');

  const first = run(localCli, [
    'register', '--local-root', localRoot, '--source', source, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom',
  ]);
  assert.equal(first.status, 0);

  const changed = run(localCli, [
    'register', '--local-root', localRoot, '--source', source, '--project-id', OTHER_PROJECT_ID, '--kind', 'custom',
  ]);
  assert.equal(changed.status, 1);
  assert.deepEqual(issueCodes(asLocal(changed.json)), ['registry-project-identity-changed']);
  const registry = JSON.parse(readFileSync(path.join(localRoot, 'registry.json'), 'utf8')) as { instances: unknown[] };
  assert.equal(registry.instances.length, 1);
});

test('register：同项目双目录隔离为两个实例，聚合互不覆盖', () => {
  const base = mkdtempSync(path.join(artifacts, 'two-copies-'));
  const localRoot = path.join(base, 'local');
  const copyA = makeSource(base, 'copy-a');
  const copyB = makeSource(base, 'copy-b');

  const a = asLocal(
    run(localCli, ['register', '--local-root', localRoot, '--source', copyA, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom']).json,
  );
  const b = asLocal(
    run(localCli, ['register', '--local-root', localRoot, '--source', copyB, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom']).json,
  );
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.entry?.instanceId, b.entry?.instanceId, '同项目不同目录必须是不同实例');

  const instancesDir = path.join(localRoot, 'instances');
  const dirs = readdirSync(instancesDir).sort();
  assert.deepEqual(dirs, [a.entry?.instanceId, b.entry?.instanceId].sort());

  // 两个聚合各自独立：projectId 相同、instanceId 与 sourceRoot 不同。
  const aggregateA = JSON.parse(readFileSync(path.join(instancesDir, a.entry?.instanceId ?? '', 'state.json'), 'utf8'));
  const aggregateB = JSON.parse(readFileSync(path.join(instancesDir, b.entry?.instanceId ?? '', 'state.json'), 'utf8'));
  assert.equal(aggregateA.projectId, SAMPLE_PROJECT_ID);
  assert.equal(aggregateB.projectId, SAMPLE_PROJECT_ID);
  assert.notEqual(aggregateA.instanceId, aggregateB.instanceId);
});

test('私有内容不入公开头：登记后 project.json 字节不变且不含本机状态', () => {
  const base = mkdtempSync(path.join(artifacts, 'privacy-'));
  const localRoot = path.join(base, 'local');
  const source = makeSource(base, 'source');
  const projectFile = path.join(source, 'project.json');
  const before = readFileSync(projectFile);

  const registered = asLocal(
    run(localCli, ['register', '--local-root', localRoot, '--source', source, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom']).json,
  );
  assert.equal(registered.ok, true);

  const after = readFileSync(projectFile);
  assert.deepEqual(after, before, '本机登记不得改写公开资料');
  const text = after.toString('utf8');
  assert.equal(text.includes(registered.entry?.instanceId ?? 'no-instance'), false, '公开头不得含本机实例 id');
  assert.equal(text.includes(localRoot), false, '公开头不得含本机数据根路径');
  assert.equal(text.includes('localDataRoot'), false);
});

test('遗留锁：占用时拒绝写入，需显式 force 释放，不自动抢占', () => {
  const base = mkdtempSync(path.join(artifacts, 'lock-'));
  const localRoot = path.join(base, 'local');
  const source = makeSource(base, 'source');
  mkdirSync(localRoot, { recursive: true });
  const lockPath = path.join(localRoot, 'lock.json');
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, hostname: 'stale-host', token: 'stale-token', acquiredAt: '2026-01-01T00:00:00.000Z' }, null, 2) + '\n',
  );

  const blocked = run(localCli, [
    'register', '--local-root', localRoot, '--source', source, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom',
  ]);
  assert.equal(blocked.status, 1);
  assert.deepEqual(issueCodes(asLocal(blocked.json)), ['local-lock-held']);
  assert.ok(existsSync(lockPath), '拒绝后必须保留原锁，不能自动清理');
  assert.equal(existsSync(path.join(localRoot, 'registry.json')), false, '锁被占用时不得写注册表');

  // 无 force、无 token：拒绝释放。
  const wrong = run(localCli, ['release-lock', '--local-root', localRoot]);
  assert.equal(wrong.status, 1);
  assert.deepEqual(issueCodes(asLocal(wrong.json)), ['local-lock-token-mismatch']);

  // 显式 force：释放并允许登记。
  const released = run(localCli, ['release-lock', '--local-root', localRoot, '--force']);
  assert.equal(released.status, 0);
  assert.equal(asLocal(released.json).released, true);
  assert.equal(existsSync(lockPath), false);

  const registered = run(localCli, [
    'register', '--local-root', localRoot, '--source', source, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom',
  ]);
  assert.equal(registered.status, 0, JSON.stringify(registered.json));
});

test('进程内重复写者：同根第二次持锁被拒绝', async () => {
  const base = mkdtempSync(path.join(artifacts, 'writer-'));
  const localRoot = path.join(base, 'local');
  mkdirSync(localRoot, { recursive: true });
  const store = new LocalStateStore();

  const outer = await store.withLock(localRoot, async () => {
    const inner = await store.withLock(localRoot, async () => 'inner');
    return inner;
  });
  assert.equal(outer.ok, true);
  if (!outer.ok) return;
  assert.equal(outer.value.ok, false);
  assert.deepEqual(issueCodes(outer.value as unknown as LocalResult), ['local-writer-duplicate']);

  // 外层释放后可再次持锁。
  const again = await store.withLock(localRoot, async () => 'again');
  assert.equal(again.ok, true);
  assert.equal(again.ok ? again.value : null, 'again');
  assert.equal(existsSync(path.join(localRoot, 'lock.json')), false, '正常释放后不留锁文件');
});

test('损坏注册表：稳定码拒绝且不覆盖原文件', () => {
  const base = mkdtempSync(path.join(artifacts, 'corrupt-'));
  const localRoot = path.join(base, 'local');
  const source = makeSource(base, 'source');
  mkdirSync(path.join(localRoot, 'instances'), { recursive: true });
  const registryPath = path.join(localRoot, 'registry.json');
  const broken = '{"schemaVersion": 2, "instances": "not-an-array"}\n';
  writeFileSync(registryPath, broken);

  const listed = run(localCli, ['list', '--local-root', localRoot]);
  assert.equal(listed.status, 1);
  assert.deepEqual(issueCodes(asLocal(listed.json)), ['local-registry-unsupported']);
  assert.equal(readFileSync(registryPath, 'utf8'), broken, '不得静默覆盖不受支持的注册表');

  const register = run(localCli, [
    'register', '--local-root', localRoot, '--source', source, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom',
  ]);
  assert.equal(register.status, 1);
  assert.equal(readFileSync(registryPath, 'utf8'), broken);
});

test('清理：测试用的嵌套仓库不进入外层 Git 索引', () => {
  // 防御性检查：artifacts 整体被忽略，嵌套仓库不得出现在外层索引。
  if (!gitAvailable()) return;
  const listed = spawnSync('git', ['ls-files', '--', 'packages/project-plugin/artifacts'], {
    cwd: path.resolve(packageRoot, '..', '..'),
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout.trim(), '', 'artifacts 内容不得被跟踪');
});
