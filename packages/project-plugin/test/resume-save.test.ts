// 接续记录保存与回读集成测试（R2 任务 3.1）：真实文件后端。
// 覆盖：经 append-record 保存带前缀 execution-note、只推进状态修订、
// 索引候选选取、正文按内容哈希读回、解析往返、同 operationId 幂等只一条。
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateService } from '../src/application/local-state.js';
import { ProjectCommandService, type CommandEnvelope } from '../src/application/command-service.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { buildResume, parseResumeBody, selectResumeCandidate } from '../src/domain/resume.js';
import type { Sha256Fn, RecordIndexEntry } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const OWNER = { kind: 'remote-owner' } as const;

async function setup(name: string) {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store, clock: () => new Date().toISOString(), newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({ localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID });
  assert.equal(registered.ok, true);
  if (!registered.ok) throw new Error('register failed');
  const service = new ProjectCommandService({
    localRoot, store, files, sha256, clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(), newRecordId: () => randomUUID(),
  });
  const planVersion = (): string => (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  const envelope = (command: Parameters<typeof service.execute>[1]['command'], overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(), projectId: PROJECT_ID, instanceId: registered.entry.instanceId,
    sourceEpoch: registered.entry.sourceGeneration, expectedPlanVersion: planVersion(), expectedPlanRevision: 0,
    command, ...overrides,
  });
  return { source, service, files, planVersion, envelope, instanceId: registered.entry.instanceId };
}

test('接续记录：append-record 保存 → 索引候选 → 正文哈希核对 → 解析往返', async () => {
  const fx = await setup('resume-save-');
  const built = buildResume({
    stoppedAt: '完成阶段1目标编辑', nextStep: '实现题库切换', nextStepKind: 'confirmed',
    savedAt: '2026-11-19T05:00:00.000Z', outcome: '目标已保存',
    verifications: [{ status: 'pass', subjectId: 'v1', label: '单元通过' }],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const opId = randomUUID();
  const command = {
    type: 'append-record' as const,
    kind: 'execution-note' as const,
    subjectNodeIds: [ROOT_NODE],
    summary: built.summary,
    sources: [],
    body: built.body,
  };
  const committed = await fx.service.execute(OWNER, fx.envelope(command, { operationId: opId }));
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') return;
  assert.equal(committed.impact, 'state');
  assert.equal(committed.planRevision, 0, '接续记录不推进规划修订');

  // 索引里有带前缀候选
  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as { records: RecordIndexEntry[] };
  const candidate = selectResumeCandidate(doc.records);
  assert.notEqual(candidate, null);
  if (candidate === null) return;
  assert.equal(candidate.kind, 'execution-note');
  assert.ok(candidate.summary.startsWith('[cona:resume] '));

  // 按 path 读正文并核哈希（R1 规则）
  const read = await fx.files.readScopedFile(fx.source, candidate.path);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal('sha256:' + sha256(read.bytes), candidate.contentHash, '正文哈希与索引一致');
  const parsed = parseResumeBody(new TextDecoder().decode(read.bytes));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.payload.stoppedAt, '完成阶段1目标编辑');
    assert.equal(parsed.payload.nextStepKind, 'confirmed');
    assert.equal(parsed.payload.verifications?.[0]?.status, 'pass', '历史验证状态原样保留');
  }
});

test('接续保存幂等：同 operationId 重试只产生一条记录', async () => {
  const fx = await setup('resume-idem-');
  const built = buildResume({ stoppedAt: '停点A', nextStep: '下一步A', nextStepKind: 'suggested', savedAt: '2026-11-19T05:10:00.000Z' });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const command = { type: 'append-record' as const, kind: 'execution-note' as const, subjectNodeIds: [ROOT_NODE], summary: built.summary, sources: [], body: built.body };
  const opId = randomUUID();
  const first = await fx.service.execute(OWNER, fx.envelope(command, { operationId: opId }));
  assert.equal(first.status, 'committed', JSON.stringify(first));
  const retry = await fx.service.execute(OWNER, fx.envelope(command, { operationId: opId }));
  assert.equal(retry.status, 'committed', JSON.stringify(retry));
  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as { records: RecordIndexEntry[] };
  assert.equal(doc.records.length, 1, '重试后仍只有一条接续记录');
  assert.equal(doc.records[0]?.id, first.status === 'committed' ? first.recordId : undefined);
});

test('普通执行记录不误选为接续候选', async () => {
  const fx = await setup('resume-skip-');
  const result = await fx.service.execute(OWNER, fx.envelope({
    type: 'append-record', kind: 'execution-note', subjectNodeIds: [ROOT_NODE],
    summary: '普通过程记录', sources: [], body: '# 普通\n\n没有接续标记',
  }));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as { records: RecordIndexEntry[] };
  assert.equal(selectResumeCandidate(doc.records), null, '普通 execution-note 不得被当接续');
});
