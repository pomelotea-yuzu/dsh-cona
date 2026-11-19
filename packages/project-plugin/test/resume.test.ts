// 接续记录领域模块测试（R2 任务 3.1）：正文构造/解析、必填校验、
// 索引候选选取（跳普通记录、首个候选即停、不回退）、各类不可读诊断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESUME_SUMMARY_PREFIX,
  RESUME_BODY_MARKER,
  RESUME_MAX_BODY_BYTES,
  buildResume,
  buildPayload,
  validateResumePayload,
  parseResumeBody,
  selectResumeCandidate,
  hasResumePrefix,
  type ResumePayload,
} from '../src/domain/resume.js';
import type { RecordIndexEntry } from '../src/domain/types.js';

const base = {
  stoppedAt: '做完阶段1的目标编辑',
  nextStep: '实现题库切换',
  nextStepKind: 'suggested' as const,
  savedAt: '2026-11-19T05:00:00.000Z',
};

const entry = (id: string, kind: RecordIndexEntry['kind'], summary: string): RecordIndexEntry => ({
  id,
  kind,
  subjectNodeIds: ['n1'],
  path: `records/${id}/h.md`,
  contentHash: 'sha256:abc',
  summary,
  sources: [],
});

test('buildResume 生成带前缀 summary 与 marker+fenced-JSON 正文，可往返解析', () => {
  const built = buildResume({ ...base, outcome: '目标已保存' });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.summary, `${RESUME_SUMMARY_PREFIX}${base.stoppedAt}`);
  assert.ok(built.body.startsWith(`${RESUME_BODY_MARKER}\n`));
  assert.ok(built.body.includes('```json'));
  const parsed = parseResumeBody(built.body);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.payload.stoppedAt, base.stoppedAt);
    assert.equal(parsed.payload.nextStep, base.nextStep);
    assert.equal(parsed.payload.outcome, '目标已保存');
    assert.equal(parsed.payload.version, 1);
  }
});

test('必填校验：停点/下一步 trim 后非空，类型/版本/状态合法', () => {
  assert.equal(buildPayload({ ...base, stoppedAt: '   ' }).ok, false);
  assert.equal(buildPayload({ ...base, nextStep: '' }).ok, false);
  assert.equal(validateResumePayload({ ...base, version: 2 }).ok, false);
  assert.equal(validateResumePayload({ ...base, version: 1, nextStepKind: 'maybe' }).ok, false);
  assert.equal(validateResumePayload({ ...base, version: 1, verifications: [{ status: 'pass', subjectId: 'r1' }] }).ok, true);
});

test('hasResumePrefix 只认精确前缀', () => {
  assert.equal(hasResumePrefix(`${RESUME_SUMMARY_PREFIX}停点`), true);
  assert.equal(hasResumePrefix('cona:resume 停点'), false);
  assert.equal(hasResumePrefix('普通记录'), false);
});

test('候选选取：从尾部向前，跳过普通记录与异类，命中首个带前缀记录', () => {
  const records: RecordIndexEntry[] = [
    entry('r1', 'execution-note', `${RESUME_SUMMARY_PREFIX}旧接续`),
    entry('r2', 'plan-change', '规划修改'),
    entry('r3', 'execution-note', '普通过程记录'),
    entry('r4', 'analysis-note', `${RESUME_SUMMARY_PREFIX}异类带前缀`),
    entry('r5', 'execution-note', `${RESUME_SUMMARY_PREFIX}最新接续`),
  ];
  assert.equal(selectResumeCandidate(records)?.id, 'r5');
  assert.equal(selectResumeCandidate([...records.slice(0, 4)])?.id, 'r1', '跳过普通与异类，回退到 r1');
  assert.equal(selectResumeCandidate([]), null);
  assert.equal(selectResumeCandidate([entry('x', 'plan-change', '无接续')]), null);
});

test('不可读诊断：坏 marker / 坏 JSON / 未知版本 / 超限', () => {
  assert.equal(parseResumeBody('随便一段文字').ok, false);
  assert.equal(parseResumeBody(`${RESUME_BODY_MARKER}\n\`\`\`json\n{bad\n\`\`\``).ok === false, true);
  const v2 = buildResume(base);
  if (v2.ok) {
    const tampered = v2.body.replace('"version": 1', '"version": 2');
    const r = parseResumeBody(tampered);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'resume-version');
  }
  // 超限：marker + 巨大 fenced 内容
  const huge = `${RESUME_BODY_MARKER}\n\`\`\`json\n${'x'.repeat(RESUME_MAX_BODY_BYTES)}\n\`\`\``;
  const tooBig = parseResumeBody(huge);
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.equal(tooBig.code, 'resume-too-large');
});

test('严格 JSON：重复键被拒', () => {
  const dup = `${RESUME_BODY_MARKER}\n\`\`\`json\n{"version":1,"version":1,"stoppedAt":"x","nextStep":"y","nextStepKind":"suggested","savedAt":"z"}\n\`\`\``;
  const r = parseResumeBody(dup);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(['resume-invalid-json', 'resume-shape'].includes(r.code));
});
