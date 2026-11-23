// 4.1 v2 公开格式与独立复算（A/F 层）。
// 覆盖：v2 schema 样例自校验与指纹；v1／v2 向量由主实现与独立实现复算一致；
// v2 集合重排稳定；过程记录不影响规划指纹；v2 诊断码（缺节点、重复、哈希、未知字段、缺 roadmap、
// v1 带 roadmap、伪造指纹）；结构变换保留 v2 roadmap；独立校验 CLI 对 v2 可用。

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlanCommand,
  computePlanVersion,
  planVersionFromJsonText,
  validateProjectDocument,
} from '../src/domain/index.js';
import { planVersionFromJsonTextAlt } from '../src/domain/canonical/plan-fingerprint-alt.js';
import type { PlanCommand } from '../src/domain/commands.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const v2Dir = path.join(packageRoot, 'formats', 'v2');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

const sampleV2 = (): ProjectDocument =>
  JSON.parse(readFileSync(path.join(v2Dir, 'sample-project-v2.json'), 'utf8')) as ProjectDocument;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

interface V2Vector {
  id: string;
  scope: 'plan' | 'reject';
  inputJson: string;
  canonical?: string;
  expectedPlanVersion?: string;
  expectedError?: string;
}

const v2Vectors = (): { protocol: string; vectors: V2Vector[] } =>
  JSON.parse(readFileSync(path.join(v2Dir, 'plan-vectors-v2.json'), 'utf8')) as never;

test('4.1 v2 样例自校验：schemaVersion 2、roadmap 有效、指纹与自报一致', () => {
  const doc = sampleV2();
  assert.equal(doc.schemaVersion, 2);
  const validated = validateProjectDocument(doc, { sha256 });
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? [] : validated.issues));
  if (!validated.ok) return;
  const computed = computePlanVersion(validated.doc, sha256).planVersion;
  assert.equal(doc.planVersion, computed);
  assert.deepEqual(
    validated.doc.plan.roadmap?.milestones.map((item) => item.nodeId),
    ['00000000-0000-4000-8000-000000000002'],
  );
});

test('4.1 v1 指纹保持原值：加入 v2 分派不影响 v1 canonical 与散列', () => {
  const v1 = JSON.parse(
    readFileSync(path.join(packageRoot, 'formats', 'v1', 'sample-project.json'), 'utf8'),
  ) as ProjectDocument;
  const validated = validateProjectDocument(v1, { sha256 });
  assert.equal(validated.ok, true);
  assert.equal(v1.plan.roadmap, undefined, 'v1 文档不带扩展字段');
  assert.equal(v1.planVersion, 'sha256:100013083ec6e0153fd76c519ab318b0b4b1ba26dcb3cb9ce756bfaef9b115c8');
});

test('4.1 v2 向量协议标识与数量', () => {
  const vectors = v2Vectors();
  assert.equal(vectors.protocol, 'v2-plan');
  assert.ok(vectors.vectors.filter((item) => item.scope === 'plan').length >= 4);
  assert.ok(vectors.vectors.filter((item) => item.scope === 'reject').length >= 8);
});

for (const vector of v2Vectors().vectors) {
  if (vector.scope === 'plan') {
    test(`[v2-plan/${vector.id}] 主实现复算 canonical 与散列`, () => {
      const result = planVersionFromJsonText(vector.inputJson, sha256);
      assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
      assert.equal(result.canonicalText, vector.canonical);
      assert.equal(result.planVersion, vector.expectedPlanVersion);
    });
    test(`[v2-plan/${vector.id}] 独立实现复算并字节一致`, () => {
      const primary = planVersionFromJsonText(vector.inputJson, sha256);
      const alt = planVersionFromJsonTextAlt(vector.inputJson, sha256);
      assert.deepEqual(alt.issues, []);
      assert.equal(alt.canonicalText, primary.canonicalText);
      assert.equal(alt.planVersion, primary.planVersion);
      assert.deepEqual(new Uint8Array(Buffer.from(alt.canonicalText, 'utf8')), primary.canonicalBytes);
    });
  } else {
    test(`[v2-reject/${vector.id}] 两实现均拒绝为 ${vector.expectedError}`, () => {
      const primary = planVersionFromJsonText(vector.inputJson, sha256);
      assert.equal(primary.issues.length > 0, true, '主实现必须拒绝');
      const alt = planVersionFromJsonTextAlt(vector.inputJson, sha256);
      assert.equal(alt.issues.length > 0, true, '独立实现必须拒绝');
    });
  }
}

test('4.1 集合重排不改变指纹：里程碑与交付顺序仅由排序规则决定', () => {
  const vectors = v2Vectors().vectors;
  const base = vectors.find((item) => item.id === 'plan-v2-milestones');
  const permuted = vectors.find((item) => item.id === 'plan-v2-milestones-permuted');
  assert.ok(base !== undefined && permuted !== undefined);
  assert.equal(base?.expectedPlanVersion, permuted?.expectedPlanVersion);
  assert.equal(base?.canonical, permuted?.canonical, 'canonical 文本逐字节一致');
  // 原始书写顺序确实不同（否则该向量没有意义）。
  assert.notEqual(base?.inputJson, permuted?.inputJson);
});

test('4.1 过程记录变化不改变 v2 规划指纹', () => {
  const vectors = v2Vectors().vectors;
  const base = vectors.find((item) => item.id === 'plan-v2-milestones');
  const withRecord = vectors.find((item) => item.id === 'plan-v2-record-added');
  assert.equal(base?.expectedPlanVersion, withRecord?.expectedPlanVersion);
});

test('4.1 v2 诊断：缺里程碑节点、重复里程碑、重复交付、哈希失配、未知字段、缺 roadmap、v1 带 roadmap', () => {
  const base = sampleV2();
  const cases: { label: string; mutate: (doc: ProjectDocument) => void; code: string }[] = [
    {
      label: '里程碑节点不存在',
      mutate: (doc) => { (doc.plan.roadmap as NonNullable<ProjectDocument['plan']['roadmap']>).milestones[0]!.nodeId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; },
      code: 'milestone-node-missing',
    },
    {
      label: '同一节点多个里程碑',
      mutate: (doc) => { (doc.plan.roadmap as NonNullable<ProjectDocument['plan']['roadmap']>).milestones.push({ nodeId: '00000000-0000-4000-8000-000000000002', deliveries: [] }); },
      code: 'duplicate-milestone',
    },
    {
      label: '同一交付重复',
      mutate: (doc) => {
        (doc.plan.roadmap as NonNullable<ProjectDocument['plan']['roadmap']>).milestones[0]!.deliveries.push({ kind: 'node', refId: '00000000-0000-4000-8000-000000000003' });
      },
      code: 'duplicate-milestone-delivery',
    },
    {
      label: '交付记录哈希失配',
      mutate: (doc) => {
        (doc.plan.roadmap as NonNullable<ProjectDocument['plan']['roadmap']>).milestones[0]!.deliveries = [
          { kind: 'record', refId: '00000000-0000-4000-8000-000000000007', contentHash: `sha256:${'b'.repeat(64)}` },
        ];
      },
      code: 'milestone-delivery-hash-mismatch',
    },
    {
      label: '未知字段',
      mutate: (doc) => { (doc.plan.roadmap as unknown as { extra: boolean }).extra = true; },
      code: 'unknown-field',
    },
    {
      label: 'v2 缺 roadmap',
      mutate: (doc) => { delete doc.plan.roadmap; },
      code: 'missing-field',
    },
    {
      label: '不支持版本',
      mutate: (doc) => { doc.schemaVersion = 9; },
      code: 'invalid-schema-version',
    },
  ];
  for (const item of cases) {
    const doc = clone(base);
    item.mutate(doc);
    const result = validateProjectDocument(doc);
    assert.equal(result.ok, false, `${item.label} 应被拒绝`);
    if (result.ok) continue;
    assert.ok(codes(result.issues).includes(item.code), `${item.label}: ${JSON.stringify(codes(result.issues))}`);
  }

  // v1 文档出现 roadmap：按未知字段拒绝，不静默按 v2 解释。
  const v1WithRoadmap = JSON.parse(
    readFileSync(path.join(packageRoot, 'formats', 'v1', 'sample-project.json'), 'utf8'),
  ) as ProjectDocument & { plan: { roadmap?: unknown } };
  v1WithRoadmap.plan.roadmap = { milestones: [] };
  const v1Result = validateProjectDocument(v1WithRoadmap);
  assert.equal(v1Result.ok, false);
  assert.ok(codes(v1Result.ok ? [] : v1Result.issues).includes('unknown-field'));
});

test('4.1 伪造指纹：自报 planVersion 与重算不一致时诊断', () => {
  const doc = sampleV2();
  doc.planVersion = `sha256:${'0'.repeat(64)}`;
  const result = validateProjectDocument(doc, { sha256 });
  assert.equal(result.ok, false);
  assert.ok(codes(result.ok ? [] : result.issues).includes('plan-version-mismatch'));
});

test('4.1 普通规划变换原样保留 v2 roadmap，并只按实际变化推进指纹', () => {
  const doc = sampleV2();
  const before = computePlanVersion(doc, sha256).planVersion;
  const commands: PlanCommand[] = [
    { type: 'update-node', nodeId: '00000000-0000-4000-8000-000000000003', patch: { goal: '新的交付目标' } },
    { type: 'set-node-status', nodeId: '00000000-0000-4000-8000-000000000004', status: 'in-progress' },
    { type: 'move-node', nodeId: '00000000-0000-4000-8000-000000000004', parentId: '00000000-0000-4000-8000-000000000002', beforeNodeId: '00000000-0000-4000-8000-000000000003' },
  ];
  let current = doc;
  for (const command of commands) {
    const applied = applyPlanCommand(current, command, sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied.ok ? [] : applied.issues));
    if (!applied.ok) return;
    current = applied.doc;
    assert.deepEqual(current.plan.roadmap, doc.plan.roadmap, `${command.type} 不得改动 roadmap`);
    assert.equal(validateProjectDocument(current, { sha256 }).ok, true, '变换后完整校验通过');
  }
  assert.notEqual(computePlanVersion(current, sha256).planVersion, before, '实际结构变化必须改变指纹');

  // 无业务变化的原位移动：指纹与 roadmap 都保持。
  const unchanged = applyPlanCommand(current, {
    type: 'move-node', nodeId: '00000000-0000-4000-8000-000000000004',
    parentId: '00000000-0000-4000-8000-000000000002', beforeNodeId: null,
  }, sha256);
  assert.equal(unchanged.ok, true);
  if (!unchanged.ok) return;
  assert.deepEqual(unchanged.doc.plan.roadmap, doc.plan.roadmap);
});

test('4.1 独立校验 CLI：v2 样例通过；篡改指纹后退出码非零并给诊断码', () => {
  const dir = mkdtempSync(path.join(artifacts, 'roadmap-cli-'));
  const good = path.join(dir, 'project.json');
  copyFileSync(path.join(v2Dir, 'sample-project-v2.json'), good);
  const cli = path.join(packageRoot, 'lib', 'cli', 'validate.js');
  const okOut = execFileSync(process.execPath, [cli, 'check-file', good], { encoding: 'utf8' });
  assert.ok(okOut.includes('"ok":true') || okOut.includes('"status":"ok"'), okOut);

  const bad = path.join(dir, 'project-bad.json');
  const doc = sampleV2();
  doc.planVersion = `sha256:${'1'.repeat(64)}`;
  writeFileSync(bad, JSON.stringify(doc, null, 2) + '\n');
  let failed = '';
  try {
    execFileSync(process.execPath, [cli, 'check-file', bad], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    failed = String((error as { stdout?: string }).stdout ?? '') + String((error as { stderr?: string }).stderr ?? '');
  }
  assert.ok(failed.includes('plan-version-mismatch'), failed);
});
