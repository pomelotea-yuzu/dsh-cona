// R2 收尾 4.3：里程碑完成记录正文的公开工件与独立核对（A/F 层）。
// 覆盖：schema 与协议文件随包存在且与解析器一致；构造/解析往返；版本标记、围栏、重复键、
// 未知版本、未知字段、空证据、索引断层等反例；独立核对对正例与三类篡改给稳定诊断。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  buildMilestoneCompletionText,
  parseMilestoneCompletionText,
  verifyMilestoneCompletions,
  type MilestoneCompletionBody,
} from '../src/domain/milestone-completion.js';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import { validateProjectDocument } from '../src/domain/validate.js';
import type { ProjectDocument, RecordIndexEntry, Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const v2Dir = path.join(packageRoot, 'formats', 'v2');
const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const M = '00000000-0000-4000-8000-000000000101';
const SUB = '00000000-0000-4000-8000-000000000102';
const REC_1 = '00000000-0000-4000-8000-000000000201';
const REC_2 = '00000000-0000-4000-8000-000000000202';

const textOfRecord = (id: string): string => `# 证据 ${id}\n`;
const hashOf = (text: string): string => 'sha256:' + sha256(new TextEncoder().encode(text));
const INPUT_VERSION = 'sha256:' + 'a'.repeat(64);

function body(): MilestoneCompletionBody {
  return {
    version: 1,
    milestoneNodeId: M,
    inputPlanVersion: INPUT_VERSION,
    evidence: [
      { criterionIndex: 0, criterionText: '条件一', recordId: REC_1, contentHash: hashOf(textOfRecord(REC_1)) },
      { criterionIndex: 1, criterionText: '条件二', recordId: REC_2, contentHash: hashOf(textOfRecord(REC_2)) },
    ],
  };
}

function record(id: string, subject: string, version: string, status: 'pass' | 'fail' = 'pass'): RecordIndexEntry {
  const contentHash = hashOf(textOfRecord(id));
  return {
    id,
    kind: 'verification',
    subjectNodeIds: [subject],
    path: `records/${id}/${contentHash.slice('sha256:'.length)}.md`,
    contentHash,
    summary: `验证 ${id}`,
    sources: [],
    verification: { status, subject: { kind: 'node', id: subject }, subjectVersion: version, scope: '本地复测' },
  };
}

/** 一个已完成的 v2 文档：里程碑节点 done，完成记录在索引末尾。 */
function completedDoc(overrides: { evidence?: MilestoneCompletionBody['evidence'] } = {}): {
  doc: ProjectDocument;
  completionText: string;
  bodies: Map<string, string>;
} {
  const evidence = overrides.evidence ?? body().evidence;
  const completionInput = { ...body(), evidence };
  const completionText = buildMilestoneCompletionText(completionInput);
  const draft: ProjectDocument = {
    schemaVersion: 2,
    project: { id: PROJECT_ID, title: '完成记录夹具', goal: '核对', constraints: [], repositories: [] },
    plan: {
      nodes: [
        { id: M, parentId: null, order: 0, title: '里程碑', goal: '完成', completionCriteria: ['条件一', '条件二'], status: 'done' },
        { id: SUB, parentId: M, order: 0, title: '交付', goal: '交付', completionCriteria: [], status: 'todo' },
      ],
      dependencies: [],
      roadmap: { milestones: [{ nodeId: M, deliveries: [{ kind: 'node', refId: SUB }] }] },
    },
    planVersion: '',
    records: [],
  };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  draft.records = [
    record(REC_1, M, INPUT_VERSION),
    record(REC_2, M, INPUT_VERSION),
    {
      id: '00000000-0000-4000-8000-000000000301',
      kind: 'verification',
      subjectNodeIds: [M],
      path: `records/00000000-0000-4000-8000-000000000301/${hashOf(completionText).slice('sha256:'.length)}.md`,
      contentHash: hashOf(completionText),
      summary: '[cona:milestone-completion] 完成（2 项条件）',
      sources: [],
      verification: { status: 'pass', subject: { kind: 'node', id: M }, subjectVersion: draft.planVersion, scope: '里程碑完成记录' },
    },
  ];
  const bodies = new Map<string, string>();
  for (const item of draft.records) {
    bodies.set(item.path, item.id === '00000000-0000-4000-8000-000000000301' ? completionText : textOfRecord(item.id));
  }
  return { doc: draft, completionText, bodies };
}

test('4.3 工件随包：完成记录 schema 与协议文件存在，schema 与解析器一致', () => {
  const schema = JSON.parse(readFileSync(path.join(v2Dir, 'milestone-completion-v1.schema.json'), 'utf8')) as {
    required: string[];
    additionalProperties: boolean;
    properties: { version: { const: number }; evidence: { minItems: number } };
  };
  assert.deepEqual(schema.required, ['version', 'milestoneNodeId', 'inputPlanVersion', 'evidence']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.version.const, 1);
  assert.equal(schema.properties.evidence.minItems, 1);

  const protocol = readFileSync(path.join(v2Dir, 'milestone-completion-protocol.md'), 'utf8');
  assert.ok(protocol.includes('<!-- cona:milestone-completion v1 -->'));
  assert.ok(protocol.includes('[cona:milestone-completion] '));
  assert.ok(protocol.includes('validate.js check-completion'));
  assert.ok(protocol.includes('completion-evidence-version'));
});

test('4.3 正文往返：首行标记 + json 围栏 + 可读表格，解析回同一结构', () => {
  const text = buildMilestoneCompletionText(body());
  assert.ok(text.startsWith('<!-- cona:milestone-completion v1 -->\n'));
  assert.ok(text.includes('```json'));
  assert.ok(text.includes('| 条件序号 | 完成条件 | 证据记录 | 正文哈希 |'));
  const parsed = parseMilestoneCompletionText(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.deepEqual(parsed.body, body());
});

test('4.3 正文反例：标记、围栏、重复键、未知版本、未知字段、空证据、索引断层', () => {
  const cases: { label: string; text: string; code: string }[] = [
    { label: '标记错误', text: '<!-- cona:milestone-completion v9 -->\n', code: 'completion-version-marker' },
    { label: '缺少围栏', text: '<!-- cona:milestone-completion v1 -->\n\n无代码块\n', code: 'completion-json-fence' },
    {
      label: '重复键',
      text: '<!-- cona:milestone-completion v1 -->\n\n```json\n{"version":1,"version":1}\n```\n',
      code: 'duplicate-key',
    },
    {
      label: '未知版本',
      text: `<!-- cona:milestone-completion v1 -->\n\n\`\`\`json\n${JSON.stringify({ ...body(), version: 2 })}\n\`\`\`\n`,
      code: 'completion-unknown-version',
    },
    {
      label: '未知字段',
      text: `<!-- cona:milestone-completion v1 -->\n\n\`\`\`json\n${JSON.stringify({ ...body(), extra: true })}\n\`\`\`\n`,
      code: 'completion-unknown-field',
    },
    {
      label: '空证据',
      text: `<!-- cona:milestone-completion v1 -->\n\n\`\`\`json\n${JSON.stringify({ ...body(), evidence: [] })}\n\`\`\`\n`,
      code: 'completion-evidence-empty',
    },
    {
      label: '索引断层',
      text: `<!-- cona:milestone-completion v1 -->\n\n\`\`\`json\n${JSON.stringify({
        ...body(),
        evidence: [{ ...body().evidence[0]!, criterionIndex: 1 }],
      })}\n\`\`\`\n`,
      code: 'completion-evidence-order',
    },
  ];
  for (const item of cases) {
    const parsed = parseMilestoneCompletionText(item.text);
    assert.equal(parsed.ok, false, item.label);
    if (parsed.ok) continue;
    assert.ok(parsed.issues.some((issue) => issue.code === item.code), `${item.label}: ${JSON.stringify(parsed.issues)}`);
  }
});

test('4.3 独立核对正例：索引、正文哈希、主题、受检版本与证据逐项通过', () => {
  const { doc, bodies } = completedDoc();
  assert.equal(validateProjectDocument(doc, { sha256 }).ok, true);
  const result = verifyMilestoneCompletions({
    doc,
    textOf: (record) => bodies.get(record.path) ?? null,
    sha256,
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.completions, [{ recordId: '00000000-0000-4000-8000-000000000301', milestoneNodeId: M, evidenceCount: 2 }]);
});

test('4.3 独立核对反例：证据正文被改、证据受检版本不符、证据不是 pass', () => {
  const tamperedBody = completedDoc();
  const evidencePath = tamperedBody.doc.records[0]!.path;
  tamperedBody.bodies.set(evidencePath, '# 被改过的证据\n');
  const tampered = verifyMilestoneCompletions({
    doc: tamperedBody.doc,
    textOf: (record) => tamperedBody.bodies.get(record.path) ?? null,
    sha256,
  });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.issues.some((issue) => issue.code === 'completion-evidence-body-hash-mismatch'));

  const wrongVersion = completedDoc();
  wrongVersion.doc.records[0] = record(REC_1, M, 'sha256:' + 'b'.repeat(64));
  const versionResult = verifyMilestoneCompletions({
    doc: wrongVersion.doc,
    textOf: (record) => wrongVersion.bodies.get(record.path) ?? null,
    sha256,
  });
  assert.ok(versionResult.issues.some((issue) => issue.code === 'completion-evidence-version'));

  const failed = completedDoc();
  failed.doc.records[1] = record(REC_2, M, INPUT_VERSION, 'fail');
  const failedResult = verifyMilestoneCompletions({
    doc: failed.doc,
    textOf: (record) => failed.bodies.get(record.path) ?? null,
    sha256,
  });
  assert.ok(failedResult.issues.some((issue) => issue.code === 'completion-evidence-not-pass'));
});
