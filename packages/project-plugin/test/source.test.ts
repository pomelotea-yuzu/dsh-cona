// 资料位置与基础接入测试（tasks 3.1）。
// 覆盖：三种位置同格式创建／接入、实际路径与 Git 只读状态、无代码目录、非空目标拒绝、
// 全新本机根首次接入外部 v1（沿用原 id）、非法位置输入。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceService } from '../src/application/source-service.js';
import type { LocationPlan } from '../src/application/location.js';
import { describeRoot, resolveLocation, toDisplayPath } from '../src/adapters/fs/location.js';
import { readGitStatus } from '../src/adapters/fs/git-status.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceCli = path.join(packageRoot, 'lib', 'cli', 'source.js');
const validateCli = path.join(packageRoot, 'lib', 'cli', 'validate.js');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const SAMPLE_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const FIXED_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FIXED_NODE_ID = '22222222-2222-4222-8222-222222222222';

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 测试装配：固定 id 生成器，便于比较不同位置的等价规划字节一致。 */
function fixedService(projectId = FIXED_PROJECT_ID, nodeId = FIXED_NODE_ID): SourceService {
  return new SourceService({
    location: { resolve: resolveLocation, describe: describeRoot },
    files: createSourceFiles(formatsDir, sha256),
    git: { read: (root: string) => readGitStatus(root) },
    sha256,
    newProjectId: () => projectId,
    newNodeId: () => nodeId,
  });
}

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

function runSource(args: string[]): { status: number; json: Record<string, unknown> } {
  return run(sourceCli, args);
}

type SourceResult = {
  ok: boolean;
  location: { kind?: string; root: string; displayPath: string };
  inspection?: { exists: boolean; entries: string[]; hasProjectJson: boolean };
  git?: { available: boolean; trackState: string; dirty: boolean | 'unknown'; reason?: string } | null;
  project?: { id: string; title: string };
  nodeIds?: string[];
  planVersion?: string;
  created?: string[];
  instance?: { projectId: string; root: string; registry: string };
  issues?: { code: string; message: string; path?: string }[];
};

function asSource(json: Record<string, unknown>): SourceResult {
  return json as unknown as SourceResult;
}

function issueCodes(result: SourceResult): string[] {
  return (result.issues ?? []).map((issue) => issue.code);
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

test('位置解析：三种位置的根路径规则与 home 折叠显示', () => {
  const base = mkdtempSync(path.join(artifacts, 'loc-'));
  const home = path.join(base, 'home');
  const planOf = (plan: LocationPlan) => {
    const result = resolveLocation(plan, { homeDir: home });
    assert.equal(result.ok, true);
    return result.ok ? result.location : undefined;
  };

  const projectDir = planOf({
    kind: 'project-directory',
    base: 'code-root',
    basePath: path.join(base, 'code'),
    segments: ['.dsh-cona-project'],
  });
  assert.equal(projectDir?.root, path.join(base, 'code', '.dsh-cona-project'));

  const dshData = planOf({
    kind: 'dsh-data',
    base: 'dsh-home',
    basePath: home,
    segments: ['data', 'dsh-cona', 'projects', FIXED_PROJECT_ID],
  });
  assert.equal(dshData?.root, path.join(home, 'data', 'dsh-cona', 'projects', FIXED_PROJECT_ID));
  assert.equal(dshData?.displayPath, path.join('~', 'data', 'dsh-cona', 'projects', FIXED_PROJECT_ID));

  const custom = planOf({ kind: 'custom', base: 'custom-root', basePath: path.join(base, 'custom'), segments: [] });
  assert.equal(custom?.root, path.join(base, 'custom'));
  assert.equal(toDisplayPath(home, home), '~');
});

test('位置解析：拒绝相对基准、`..` 段与 NUL', () => {
  const root = path.sep;
  const rel = resolveLocation({ kind: 'custom', base: 'custom-root', basePath: ['data', 'project'].join(path.sep), segments: [] });
  assert.equal(rel.ok, false);
  assert.deepEqual(rel.ok ? [] : rel.issues.map((issue) => issue.code), ['location-root-not-absolute']);

  // 手拼字符串：path.join 会规范化掉 `..`，构造不出待测输入。
  const escapePath = [root, 'tmp', '..', 'etc'].join(path.sep);
  const escape = resolveLocation(
    { kind: 'custom', base: 'custom-root', basePath: escapePath, segments: [] },
    { homeDir: [root, 'tmp'].join(path.sep) },
  );
  assert.equal(escape.ok, false);
  assert.deepEqual(escape.ok ? [] : escape.issues.map((issue) => issue.code), ['location-path-escapes']);

  const nulPath = [root, 'tmp', 'a\0b'].join(path.sep);
  const nul = resolveLocation(
    { kind: 'custom', base: 'custom-root', basePath: nulPath, segments: [] },
    { homeDir: [root, 'tmp'].join(path.sep) },
  );
  assert.equal(nul.ok, false);
  assert.deepEqual(nul.ok ? [] : nul.issues.map((issue) => issue.code), ['location-path-invalid']);
});

test('preview：三种位置只报实际路径与现有内容，不创建目录', () => {
  const base = mkdtempSync(path.join(artifacts, 'preview-'));
  const codeRoot = path.join(base, 'code');
  const dshHome = path.join(base, 'home');
  const customRoot = path.join(base, 'custom');

  const cases: { args: string[]; expected: string }[] = [
    {
      args: ['--kind', 'project-directory', '--code-root', codeRoot],
      expected: path.join(codeRoot, '.dsh-cona-project'),
    },
    {
      args: ['--kind', 'dsh-data', '--dsh-home', dshHome, '--project-id', FIXED_PROJECT_ID],
      expected: path.join(dshHome, 'data', 'dsh-cona', 'projects', FIXED_PROJECT_ID),
    },
    { args: ['--kind', 'custom', '--custom-root', customRoot], expected: customRoot },
  ];
  for (const item of cases) {
    const { status, json } = runSource(['preview', ...item.args]);
    const result = asSource(json);
    assert.equal(status, 0, JSON.stringify(json));
    assert.equal(result.location.root, item.expected);
    assert.equal(result.inspection?.exists, false);
    assert.equal(result.git, null);
    assert.equal(readdirSync(base).includes(path.basename(item.expected)), false, 'preview 不得创建目录');
  }
});

test('create：三种位置写入同一 schema，等价规划字节一致且可被独立校验命令读取', async () => {
  const base = mkdtempSync(path.join(artifacts, 'create3-'));
  const codeRoot = path.join(base, 'code');
  const dshHome = path.join(base, 'home');
  const customRoot = path.join(base, 'custom');
  mkdirSync(codeRoot, { recursive: true });

  const requests = [
    { request: { kind: 'project-directory' as const, codeRoot }, root: path.join(codeRoot, '.dsh-cona-project') },
    { request: { kind: 'dsh-data' as const, dshHome }, root: path.join(dshHome, 'data', 'dsh-cona', 'projects', FIXED_PROJECT_ID) },
    { request: { kind: 'custom' as const, customRoot }, root: customRoot },
  ];

  const texts: string[] = [];
  for (const item of requests) {
    const created = await fixedService().create({ ...item.request, title: '三处同格式', goal: '同一规划落在不同位置' });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) return;
    assert.equal(created.location.root, item.root);
    assert.equal(created.project.id, FIXED_PROJECT_ID);
    assert.deepEqual(created.nodeIds, [FIXED_NODE_ID]);
    assert.match(created.planVersion, /^sha256:[0-9a-f]{64}$/);

    const entries = readdirSync(item.root).sort();
    for (const expected of ['README.md', 'project.json', 'protocol', 'records', 'schema']) {
      assert.ok(entries.includes(expected), `缺 ${expected}（${item.request.kind}）`);
    }
    // 独立校验命令在无宿主进程读取同一资料。
    const checked = run(validateCli, ['check', item.root]);
    assert.equal(checked.status, 0, JSON.stringify(checked.json));
    texts.push(readFileSync(path.join(item.root, 'project.json'), 'utf8'));
  }
  assert.equal(new Set(texts).size, 1, '三种位置的等价规划应产生一致的 project.json');

  for (const item of requests) {
    const { status, json } = runSource(['attach', item.root]);
    const result = asSource(json);
    assert.equal(status, 0, JSON.stringify(json));
    assert.equal(result.project?.id, FIXED_PROJECT_ID);
    assert.deepEqual(result.nodeIds, [FIXED_NODE_ID]);
    assert.equal(result.instance?.registry, 'pending-3.2');
  }
});

test('create：CLI 端到端在三种位置可建项目，无代码目录也可', () => {
  const base = mkdtempSync(path.join(artifacts, 'nocode-'));
  const dshHome = path.join(base, 'home');
  const customRoot = path.join(base, 'plan-only');
  assert.equal(readdirSync(base).includes('code'), false);

  const dsh = runSource(['create', '--kind', 'dsh-data', '--dsh-home', dshHome, '--title', '无代码目录']);
  assert.equal(dsh.status, 0, JSON.stringify(dsh.json));
  assert.equal(asSource(dsh.json).nodeIds?.length, 1);

  const custom = runSource(['create', '--kind', 'custom', '--custom-root', customRoot, '--title', '无代码目录']);
  assert.equal(custom.status, 0, JSON.stringify(custom.json));
  assert.equal(readdirSync(base).includes('code'), false, '不需要先创建代码目录');

  const reused = runSource(['create', '--kind', 'custom', '--custom-root', customRoot, '--title', '重复创建']);
  assert.equal(reused.status, 1);
  assert.deepEqual(issueCodes(asSource(reused.json)), ['source-not-empty']);
});

test('create：非空目标与已有 project.json 均拒绝覆盖', () => {
  const base = mkdtempSync(path.join(artifacts, 'nonempty-'));
  const customRoot = path.join(base, 'occupied');
  mkdirSync(customRoot, { recursive: true });
  writeFileSync(path.join(customRoot, 'notes.md'), '已有内容\n');

  const occupied = runSource(['create', '--kind', 'custom', '--custom-root', customRoot, '--title', '不应创建']);
  const occupiedResult = asSource(occupied.json);
  assert.equal(occupied.status, 1);
  assert.deepEqual(issueCodes(occupiedResult), ['source-not-empty']);
  assert.equal(readFileSync(path.join(customRoot, 'notes.md'), 'utf8'), '已有内容\n');

  // 已有 project.json（外部资料）同样不得被当成新项目覆盖。
  const existing = path.join(base, 'existing');
  mkdirSync(existing, { recursive: true });
  writeFileSync(path.join(existing, 'project.json'), readFileSync(sample));
  const before = readFileSync(path.join(existing, 'project.json'), 'utf8');
  const occupied2 = runSource(['create', '--kind', 'custom', '--custom-root', existing, '--title', '不应创建']);
  assert.equal(occupied2.status, 1);
  assert.deepEqual(issueCodes(asSource(occupied2.json)), ['source-not-empty']);
  assert.equal(readFileSync(path.join(existing, 'project.json'), 'utf8'), before);
});

test('attach：全新本机根首次接入外部 v1，沿用原项目／节点 id 且不生成额外状态', () => {
  const base = mkdtempSync(path.join(artifacts, 'attach-fresh-'));
  const external = path.join(base, 'external-copy');
  mkdirSync(external, { recursive: true });
  writeFileSync(path.join(external, 'project.json'), readFileSync(sample));
  const before = readdirSync(external).sort();

  const { status, json } = runSource(['attach', external]);
  const result = asSource(json);
  assert.equal(status, 0, JSON.stringify(json));
  assert.equal(result.project?.id, SAMPLE_PROJECT_ID);
  assert.deepEqual(result.nodeIds, [
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ]);
  assert.equal(result.planVersion, 'sha256:100013083ec6e0153fd76c519ab318b0b4b1ba26dcb3cb9ce756bfaef9b115c8');
  // 只读接入：不写注册表、回执或授权文件。
  assert.deepEqual(readdirSync(external).sort(), before);
  assert.equal(readdirSync(base).filter((name) => name !== 'external-copy').length, 0);
});

test('attach：资料缺失、目录为空或资料非法时明确拒绝', () => {
  const base = mkdtempSync(path.join(artifacts, 'attach-fail-'));
  const missing = runSource(['attach', path.join(base, 'nope')]);
  assert.equal(missing.status, 1);
  assert.deepEqual(issueCodes(asSource(missing.json)), ['source-not-found']);

  const empty = path.join(base, 'empty');
  mkdirSync(empty, { recursive: true });
  const noProject = runSource(['attach', empty]);
  assert.equal(noProject.status, 1);
  assert.deepEqual(issueCodes(asSource(noProject.json)), ['source-missing-project-file']);

  const broken = path.join(base, 'broken');
  mkdirSync(broken, { recursive: true });
  const sampleJson = JSON.parse(readFileSync(sample, 'utf8')) as { planVersion: string };
  sampleJson.planVersion = 'sha256:' + '0'.repeat(64);
  writeFileSync(path.join(broken, 'project.json'), JSON.stringify(sampleJson, null, 2) + '\n');
  const mismatch = runSource(['attach', broken]);
  assert.equal(mismatch.status, 1);
  assert.ok(issueCodes(asSource(mismatch.json)).includes('plan-version-mismatch'));
});

test('git：只读观察跟踪／忽略状态；非仓库与 git 不可用不作伪结论', () => {
  const base = mkdtempSync(path.join(artifacts, 'git-'));
  const absent = runSource(['preview', '--kind', 'custom', '--custom-root', path.join(base, 'absent')]);
  assert.equal(asSource(absent.json).git, null, '根不存在时不给伪状态');

  if (!gitAvailable()) {
    const unavailable = readGitStatus(base, { gitBin: 'definitely-not-a-git-binary' });
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.reason, 'git-unavailable');
    return;
  }

  // 非仓库：用 GIT_CEILING_DIRECTORIES 阻止向上找到本仓，隔离测试现场。
  const plain = path.join(base, 'plain');
  mkdirSync(plain, { recursive: true });
  const notRepo = readGitStatus(plain, { env: { GIT_CEILING_DIRECTORIES: base } });
  assert.equal(notRepo.available, false);
  assert.equal(notRepo.reason, 'not-a-repository');

  const unavailable = readGitStatus(plain, { gitBin: 'definitely-not-a-git-binary' });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, 'git-unavailable');

  const repo = path.join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  writeFileSync(path.join(repo, '.gitignore'), 'ignored-root/\n');

  const created = runSource(['create', '--kind', 'project-directory', '--code-root', repo, '--title', 'Git 观察']);
  const createdResult = asSource(created.json);
  assert.equal(created.status, 0, JSON.stringify(created.json));
  assert.equal(createdResult.git?.available, true);
  assert.equal(createdResult.git?.trackState, 'untracked');

  execFileSync('git', ['add', '.dsh-cona-project'], { cwd: repo });
  const tracked = runSource(['attach', path.join(repo, '.dsh-cona-project')]);
  assert.equal(asSource(tracked.json).git?.trackState, 'tracked');

  const ignoredRoot = path.join(repo, 'ignored-root');
  const ignoredCreate = runSource(['create', '--kind', 'custom', '--custom-root', ignoredRoot, '--title', '被忽略']);
  assert.equal(ignoredCreate.status, 0, JSON.stringify(ignoredCreate.json));
  assert.equal(asSource(ignoredCreate.json).git?.trackState, 'ignored');
});

test('preview／create：非法位置输入以稳定码拒绝', () => {
  const base = mkdtempSync(path.join(artifacts, 'invalid-'));
  const unknownKind = runSource(['preview', '--kind', 'network-share', '--custom-root', path.join(base, 'x')]);
  assert.equal(unknownKind.status, 1);
  assert.deepEqual(issueCodes(asSource(unknownKind.json)), ['location-kind-unknown']);

  const missingBase = runSource(['preview', '--kind', 'custom']);
  assert.equal(missingBase.status, 1);
  assert.deepEqual(issueCodes(asSource(missingBase.json)), ['location-base-missing']);

  const dshWithoutId = runSource(['preview', '--kind', 'dsh-data', '--dsh-home', path.join(base, 'home')]);
  assert.equal(dshWithoutId.status, 1);
  assert.deepEqual(issueCodes(asSource(dshWithoutId.json)), ['location-project-id-required']);

  const relative = runSource(['create', '--kind', 'custom', '--custom-root', 'relative/dir', '--title', '相对路径']);
  assert.equal(relative.status, 1);
  assert.deepEqual(issueCodes(asSource(relative.json)), ['location-root-not-absolute']);

  const emptyTitle = runSource(['create', '--kind', 'custom', '--custom-root', path.join(base, 'titled'), '--title', '  ']);
  assert.equal(emptyTitle.status, 1);
  assert.deepEqual(issueCodes(asSource(emptyTitle.json)), ['source-title-required']);
  assert.equal(readdirSync(base).includes('titled'), false, '标题非法时不落盘');
});
