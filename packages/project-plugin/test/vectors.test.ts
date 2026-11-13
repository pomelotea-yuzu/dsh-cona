// v1-plan 强制一致性向量复算（tasks 1.3，协议 §5）。
// 主实现与独立第二实现均须复算全部正向向量（canonical 字节与散列完全一致）并拒绝负向向量。
// 向量来自包内 formats/v1/plan-vectors.json（与 change 工件逐字节一致，见 check:protocol-sync），
// 不得由被测实现重新生成期望值。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictParse, planVersionFromJsonText, encodeCanonical } from '../src/domain/index.js';
import { planVersionFromJsonTextAlt, encodeCanonicalAlt } from '../src/domain/canonical/plan-fingerprint-alt.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vectorsFile = path.join(packageRoot, 'formats', 'v1', 'plan-vectors.json');
const vectors = JSON.parse(readFileSync(vectorsFile, 'utf8')) as {
  protocol: string;
  vectors: {
    id: string;
    scope: 'plan' | 'serializer' | 'reject';
    inputJson: string;
    canonical?: string;
    expectedPlanVersion?: string;
    expectedError?: string;
  }[];
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('向量工件协议标识为 v1-plan', () => {
  assert.equal(vectors.protocol, 'v1-plan');
});

for (const vector of vectors.vectors) {
  if (vector.scope === 'plan') {
    test(`[plan/${vector.id}] 主实现复算 canonical 与散列`, () => {
      const result = planVersionFromJsonText(vector.inputJson, sha256);
      assert.deepEqual(result.issues, [], `校验问题：${JSON.stringify(result.issues)}`);
      assert.equal(result.canonicalText, vector.canonical);
      assert.equal(result.planVersion, vector.expectedPlanVersion);
    });
    test(`[plan/${vector.id}] 独立实现复算 canonical 与散列`, () => {
      const result = planVersionFromJsonTextAlt(vector.inputJson, sha256);
      assert.deepEqual(result.issues, []);
      assert.equal(result.canonicalText, vector.canonical);
      assert.equal(result.planVersion, vector.expectedPlanVersion);
    });
    test(`[plan/${vector.id}] 两实现的 canonical 字节一致`, () => {
      const primary = planVersionFromJsonText(vector.inputJson, sha256);
      const alt = planVersionFromJsonTextAlt(vector.inputJson, sha256);
      assert.deepEqual(new Uint8Array(Buffer.from(alt.canonicalText, 'utf8')), primary.canonicalBytes);
    });
  } else if (vector.scope === 'serializer') {
    test(`[serializer/${vector.id}] 主实现编码`, () => {
      const parsed = strictParse(vector.inputJson);
      assert.ok(parsed.ok, `严格解析失败：${parsed.ok ? '' : parsed.error.message}`);
      if (!parsed.ok) return;
      const text = encodeCanonical(parsed.value);
      assert.equal(text, vector.canonical);
      assert.equal('sha256:' + sha256(new Uint8Array(Buffer.from(text, 'utf8'))), vector.expectedPlanVersion);
    });
    test(`[serializer/${vector.id}] 独立实现编码`, () => {
      const parsed = strictParse(vector.inputJson);
      assert.ok(parsed.ok);
      if (!parsed.ok) return;
      const text = encodeCanonicalAlt(parsed.value);
      assert.equal(text, vector.canonical);
      assert.equal('sha256:' + sha256(new Uint8Array(Buffer.from(text, 'utf8'))), vector.expectedPlanVersion);
    });
  } else if (vector.scope === 'reject') {
    test(`[reject/${vector.id}] 主实现拒绝（${vector.expectedError}）`, () => {
      const parsed = strictParse(vector.inputJson);
      assert.ok(!parsed.ok, '必须拒绝');
      if (parsed.ok) return;
      assert.equal(parsed.error.code, vector.expectedError);
    });
    test(`[reject/${vector.id}] 独立实现入口拒绝（${vector.expectedError}）`, () => {
      const result = planVersionFromJsonTextAlt(vector.inputJson, sha256);
      assert.ok(result.issues.length > 0);
      assert.equal(result.issues[0]?.code, vector.expectedError);
    });
  }
}
