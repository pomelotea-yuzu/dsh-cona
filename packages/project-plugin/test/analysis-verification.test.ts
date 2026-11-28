// 验证记录索引与正文读取测试（tasks 5.1）：捕获索引、重查当前索引、正文哈希核对、
// 按行/预算交付凭证、历史变化拒绝。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AnalysisVerificationService, type VerificationIndexEntry } from '../src/application/analysis-verification.js';
import { DEFAULT_ANALYSIS_LIMITS, ReadBudget } from '../src/domain/analysis.js';
import type { ProjectDocument } from '../src/domain/types.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const body = 'line one\nline two\nline three\n';
const contentHash = `sha256:${sha256(Buffer.from(body))}`;

function doc(overrides: Partial<{ contentHash: string; subjectVersion: string; kind: string }> = {}): ProjectDocument {
  return {
    records: [
      {
        id: 'rec-1',
        kind: overrides.kind ?? 'verification',
        subjectNodeIds: ['node-1'],
        path: 'records/rec-1/body.md',
        contentHash: overrides.contentHash ?? contentHash,
        summary: 'verified build',
        sources: [],
        verification: {
          status: 'pass',
          subject: { kind: 'node', id: 'node-1' },
          subjectVersion: overrides.subjectVersion ?? 'sha256:plan',
          scope: 'unit',
        },
      },
      { id: 'rec-2', kind: 'analysis-note', subjectNodeIds: [], path: 'records/rec-2/body.md', contentHash: 'sha256:x', summary: 'note', sources: [] },
    ],
  } as unknown as ProjectDocument;
}

function harness(options: { body?: string; readError?: { code: string; message: string } } = {}) {
  let current = doc();
  const service = new AnalysisVerificationService({
    baseline: async () => ({ ok: true, doc: current }),
    readRecord: async (_path, expectedHash) => {
      if (options.readError !== undefined) return { ok: false, ...options.readError };
      const actual = `sha256:${sha256(Buffer.from(options.body ?? body))}`;
      if (actual !== expectedHash) return { ok: false, code: 'body-hash-mismatch', message: 'hash mismatch' };
      return { ok: true, body: options.body ?? body };
    },
    sha256,
    limits: { ...DEFAULT_ANALYSIS_LIMITS, fileBytes: 1024, readBytes: 1024, readLines: 100 },
  });
  return { service, setDoc: (next: ProjectDocument) => { current = next; } };
}

test('5.1 捕获索引只含验证记录，读取按实际交付片段发凭证', async () => {
  const h = harness();
  const index = await h.service.captureIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0]?.recordId, 'rec-1');
  assert.equal(index[0]?.subjectVersion, 'sha256:plan');

  const budget = new ReadBudget(1024);
  const read = await h.service.read(index[0]!, { budget });
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  assert.equal(read.text, 'line one\nline two\nline three');
  assert.deepEqual(
    { start: read.credential.startLine, end: read.credential.endLine, total: read.credential.totalLines, truncated: read.credential.truncated },
    { start: 1, end: 3, total: 3, truncated: false },
  );
  assert.equal(read.credential.contentHash, contentHash);
  assert.equal(read.credential.deliveredHash, sha256(Buffer.from(read.text)));
  assert.equal(budget.used, read.credential.deliveredBytes);

  const range = await h.service.read(index[0]!, { budget: new ReadBudget(1024), startLine: 2, maxLines: 1 });
  assert.equal(range.status, 'ok');
  if (range.status === 'ok') {
    assert.equal(range.text, 'line two');
    assert.deepEqual([range.credential.startLine, range.credential.endLine], [2, 2]);
  }
});

test('5.1 索引或正文变化、缺失、预算不足都拒绝且不发凭证', async () => {
  const h = harness();
  const entry = (await h.service.captureIndex())[0]!;
  h.setDoc(doc({ contentHash: 'sha256:changed' }));
  const changed = await h.service.read(entry, { budget: new ReadBudget(1024) });
  assert.equal(changed.status, 'rejected');
  if (changed.status === 'rejected') assert.equal(changed.code, 'analysis-verification-changed');

  const h2 = harness();
  const entry2 = (await h2.service.captureIndex())[0]!;
  h2.setDoc({ records: [] } as unknown as ProjectDocument);
  const missing = await h2.service.read(entry2, { budget: new ReadBudget(1024) });
  assert.equal(missing.status, 'rejected');
  if (missing.status === 'rejected') assert.equal(missing.code, 'analysis-verification-missing');

  const hashFail = harness({ readError: { code: 'body-hash-mismatch', message: 'bad hash' } });
  const hashEntry = (await hashFail.service.captureIndex())[0]!;
  const badBody = await hashFail.service.read(hashEntry, { budget: new ReadBudget(1024) });
  assert.equal(badBody.status, 'rejected');
  if (badBody.status === 'rejected') assert.equal(badBody.code, 'body-hash-mismatch');

  const h3 = harness();
  const entry3 = (await h3.service.captureIndex())[0]!;
  const noBudget = await h3.service.read(entry3, { budget: new ReadBudget(0) });
  assert.equal(noBudget.status, 'rejected');
  if (noBudget.status === 'rejected') assert.equal(noBudget.code, 'analysis-read-budget-exhausted');
});

test('5.1 引用复核：当前／索引变化／缺失／正文不可读', async () => {
  const h = harness();
  const entry: VerificationIndexEntry = (await h.service.captureIndex())[0]!;
  assert.deepEqual(await h.service.verify(entry), { status: 'current' });
  h.setDoc(doc({ subjectVersion: 'sha256:other' }));
  assert.deepEqual(await h.service.verify(entry), { status: 'changed' });
  h.setDoc({ records: [] } as unknown as ProjectDocument);
  assert.deepEqual(await h.service.verify(entry), { status: 'missing' });

  const unreadable = harness({ readError: { code: 'body-missing', message: 'gone' } });
  const entry2 = (await unreadable.service.captureIndex())[0]!;
  const result = await unreadable.service.verify(entry2);
  assert.equal(result.status, 'inaccessible');
});


test('5.1 缺受检版本：凭证不带 subjectVersion，按历史证据保留', async () => {
  const h = harness();
  const base = doc();
  const first = base.records[0] as unknown as { verification: Record<string, unknown> };
  delete first.verification['subjectVersion'];
  h.setDoc(base);
  const entry = (await h.service.captureIndex())[0]!;
  assert.equal(entry.subjectVersion, undefined);
  const read = await h.service.read(entry, { budget: new ReadBudget(1024) });
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  assert.equal('subjectVersion' in read.credential, false);
  assert.deepEqual(await h.service.verify(entry), { status: 'current' });
});
