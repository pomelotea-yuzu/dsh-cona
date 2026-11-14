// 公开资料发布与正文不可变写入测试（tasks 3.4）。
// 覆盖：正常发布、写入前／rename 前／rename 后／回读前注入失败的三态结果与临时文件清理、
// 正文幂等与冲突、孤立正文不当作已发布、本机聚合替换三态。
// 临时目录放在包内 artifacts/。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishProjectDocument, writeBodyImmutable } from '../src/adapters/fs/publish.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const validateCli = path.join(packageRoot, 'lib', 'cli', 'validate.js');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const RECORD_ID = '44444444-4444-4444-8444-444444444444';

function makeRoot(name: string): string {
  const root = path.join(mkdtempSync(path.join(artifacts, name)), 'data');
  mkdirSync(root, { recursive: true });
  copyFileSync(sample, path.join(root, 'project.json'));
  return root;
}

function sampleDoc(): ProjectDocument {
  return JSON.parse(readFileSync(sample, 'utf8')) as ProjectDocument;
}

function withExtraRecord(doc: ProjectDocument, bodyPath: string, contentHash: string): ProjectDocument {
  const next: ProjectDocument = {
    ...doc,
    project: { ...doc.project },
    plan: { ...doc.plan },
    records: [
      ...doc.records,
      {
        id: RECORD_ID,
        kind: 'analysis-note',
        subjectNodeIds: ['00000000-0000-4000-8000-000000000002'],
        path: bodyPath,
        contentHash,
        summary: '外部追加的分析',
        sources: [],
      },
    ],
  };
  // records 不参与规划投影，planVersion 不变；这里重算一次确保与实现一致。
  next.planVersion = computePlanVersion(next, sha256).planVersion;
  return next;
}

test('发布：正常写入为 published，内容与序列化一致', async () => {
  const root = makeRoot('publish-ok-');
  const doc = sampleDoc();
  const result = await publishProjectDocument(root, doc);
  assert.equal(result.status, 'published');
  assert.equal(result.stage, 'done');
  const text = readFileSync(path.join(root, 'project.json'), 'utf8');
  assert.equal(text.includes('"planVersion"'), true);
  // 不留临时文件。
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith('.project.json.tmp-')),
    [],
  );
});

test('发布：写入前注入失败为 not-published，原文件不变', async () => {
  const root = makeRoot('publish-before-');
  const before = readFileSync(path.join(root, 'project.json'));
  const doc = sampleDoc();
  doc.project.title = '被拒绝的标题';
  const result = await publishProjectDocument(root, doc, {
    beforeTempWrite: () => {
      throw new Error('injected-before-temp');
    },
  });
  assert.equal(result.status, 'not-published');
  assert.equal(result.stage, 'temp');
  assert.deepEqual(readFileSync(path.join(root, 'project.json')), before);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.project.json.tmp-')), []);
});

test('发布：rename 前注入失败为 not-published，临时文件被清理', async () => {
  const root = makeRoot('publish-rename-before-');
  const before = readFileSync(path.join(root, 'project.json'));
  const doc = sampleDoc();
  doc.project.title = '不应生效';
  const result = await publishProjectDocument(root, doc, {
    beforeRename: () => {
      throw new Error('injected-before-rename');
    },
  });
  assert.equal(result.status, 'not-published');
  assert.equal(result.stage, 'rename');
  assert.deepEqual(readFileSync(path.join(root, 'project.json')), before);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.project.json.tmp-')), []);
});

test('发布：rename 后注入失败为 unknown，且文件确已替换', async () => {
  const root = makeRoot('publish-rename-after-');
  const doc = sampleDoc();
  doc.project.title = '已替换但无法确认';
  const result = await publishProjectDocument(root, doc, {
    afterRename: () => {
      throw new Error('injected-after-rename');
    },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.stage, 'rename');
  const text = readFileSync(path.join(root, 'project.json'), 'utf8');
  assert.equal(text.includes('已替换但无法确认'), true, 'rename 已生效，unknown 不代表未提交');
});

test('发布：回读前注入与外部改字节都判为 unknown', async () => {
  const root = makeRoot('publish-reread-');
  const doc = sampleDoc();
  doc.project.title = '回读前中断';
  const injected = await publishProjectDocument(root, doc, {
    beforeReread: () => {
      throw new Error('injected-before-reread');
    },
  });
  assert.equal(injected.status, 'unknown');
  assert.equal(injected.stage, 'reread');

  const root2 = makeRoot('publish-external-');
  const doc2 = sampleDoc();
  doc2.project.title = '外部改写';
  const external = await publishProjectDocument(root2, doc2, {
    beforeReread: () => {
      writeFileSync(path.join(root2, 'project.json'), '{"schemaVersion":1}\n');
    },
  });
  assert.equal(external.status, 'unknown');
  assert.equal(external.stage, 'reread');
});

test('正文：首次写入 written，重复同字节 already-present，不同字节 conflict', async () => {
  const root = makeRoot('body-');
  const body = new TextEncoder().encode('# 分析正文\n');
  const contentHash = 'sha256:' + sha256(body);

  const first = await writeBodyImmutable(root, RECORD_ID, contentHash, body);
  assert.equal(first.status, 'written');
  assert.equal(first.path, `records/${RECORD_ID}/${contentHash.slice(7)}.md`);

  const again = await writeBodyImmutable(root, RECORD_ID, contentHash, body);
  assert.equal(again.status, 'already-present');

  // 同路径已有不同字节（模拟外部破坏或哈希碰撞防御）：不覆盖。
  const bodyPath = path.join(root, ...first.path.split('/'));
  writeFileSync(bodyPath, '# 被改写的正文\n');
  const conflict = await writeBodyImmutable(root, RECORD_ID, contentHash, body);
  assert.equal(conflict.status, 'conflict');
  assert.equal(readFileSync(bodyPath, 'utf8'), '# 被改写的正文\n');

  const mismatch = await writeBodyImmutable(root, RECORD_ID, 'sha256:' + '0'.repeat(64), body);
  assert.equal(mismatch.status, 'conflict');
});

test('隔离：孤立正文报 orphan-body，发布引用后校验通过', async () => {
  const root = makeRoot('isolate2-');
  const body = new TextEncoder().encode('# 外部追加的分析\n');
  const contentHash = 'sha256:' + sha256(body);
  const recordPath = `records/${RECORD_ID}/${contentHash.slice(7)}.md`;
  mkdirSync(path.join(root, 'records', RECORD_ID), { recursive: true });
  writeFileSync(path.join(root, ...recordPath.split('/')), body);

  let checkStatus = 0;
  let checkOut = '';
  try {
    checkOut = execFileSync(process.execPath, [validateCli, 'check', root], { encoding: 'utf8' });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    checkStatus = err.status ?? 1;
    checkOut = err.stdout ?? '';
  }
  assert.equal(checkStatus, 1, checkOut);
  assert.equal(checkOut.includes('orphan-body'), true, checkOut);

  // 发布引用该正文的资料头后，孤立正文成为已发布记录。
  const doc = withExtraRecord(sampleDoc(), recordPath, contentHash);
  const published = await publishProjectDocument(root, doc);
  assert.equal(published.status, 'published');
  const after = execFileSync(process.execPath, [validateCli, 'check', root], { encoding: 'utf8' });
  assert.equal((JSON.parse(after) as { ok: boolean }).ok, true, after);
});

test('本机聚合替换：saved／not-saved／unknown-state 三态', async () => {
  const base = mkdtempSync(path.join(artifacts, 'aggregate-'));
  const localRoot = path.join(base, 'local');
  mkdirSync(localRoot, { recursive: true });
  const store = new LocalStateStore();

  const aggregate = {
    schemaVersion: 1 as const,
    instanceId: '55555555-5555-4555-8555-555555555555',
    projectId: '00000000-0000-4000-8000-000000000001',
    source: { root: path.join(base, 'src'), kind: 'custom' as const, generation: 1 },
    revisions: { plan: 0, state: 0 },
    conversations: [],
    workRuns: [],
    operations: [],
    lastObservation: null,
  };

  const saved = await store.replaceAggregateChecked(localRoot, aggregate);
  assert.equal(saved.status, 'saved');
  assert.equal(existsSync(path.join(localRoot, 'instances', aggregate.instanceId, 'state.json')), true);

  const notSaved = await store.replaceAggregateChecked(localRoot, aggregate, {
    beforeTempWrite: () => {
      throw new Error('injected-aggregate-temp');
    },
  });
  assert.equal(notSaved.status, 'not-saved');
  assert.equal(notSaved.stage, 'temp');

  const unknown = await store.replaceAggregateChecked(localRoot, aggregate, {
    afterRename: () => {
      throw new Error('injected-aggregate-rename');
    },
  });
  assert.equal(unknown.status, 'unknown-state');
  assert.equal(unknown.stage, 'rename');
});
