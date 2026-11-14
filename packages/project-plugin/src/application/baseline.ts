// 完整资料基线读取（tasks 3.5，design §4）：规划指纹之外，另记头字节哈希与每条引用正文的观察哈希。
// 基线用于识别外部追加、外部改写与 Git 操作造成的差异；它不代替领域校验或授权。

import { strictParse } from '../domain/strict-json.js';
import { validateProjectDocument } from '../domain/validate.js';
import type { ProjectDocument, Sha256Fn } from '../domain/types.js';
import type { SourceFilesPort } from './ports.js';

export interface RecordBaseline {
  /** 协议路径 `records/<recordId>/<contentHash-hex>.md`。 */
  path: string;
  /** 索引声明的哈希。 */
  contentHash: string;
  /** 本次实际读取字节的哈希；与 contentHash 不一致即拒绝。 */
  observedHash: string;
  bytes: number;
}

export interface SourceBaseline {
  projectId: string;
  planVersion: string;
  /** project.json 原始字节的哈希（排版变化也会改变它，与 planVersion 用途不同）。 */
  headHash: string;
  records: RecordBaseline[];
  observedAt: string;
}

export interface BaselineIssue {
  code: string;
  message: string;
  path?: string;
}

export type BaselineResult =
  | { ok: true; baseline: SourceBaseline; doc: ProjectDocument }
  | { ok: false; issues: BaselineIssue[] };

/** Git 冲突标记出现在行首：视为资料需要人工处理，不继续当作可写基线。 */
const CONFLICT_MARKER = /(^|\n)(<{7}|={7}|>{7})( |\n|$)/;

/**
 * 重读完整资料基线：头字节 → 严格解析 → 领域校验 → 逐条正文核对。
 * 任何一步失败都返回稳定诊断，不返回“部分可用”的基线，也不改动磁盘。
 */
export async function readSourceBaseline(
  files: SourceFilesPort,
  root: string,
  sha256: Sha256Fn,
  clock: () => string,
): Promise<BaselineResult> {
  const head = await files.readHead(root);
  if (!head.ok) {
    return {
      ok: false,
      issues: head.issues.map((issue) => ({
        code: issue.code,
        message: issue.message ?? '资料头不可读',
        path: issue.path,
      })),
    };
  }
  if (CONFLICT_MARKER.test(head.text)) {
    return {
      ok: false,
      issues: [{ code: 'source-conflict-markers', message: 'project.json 含 Git 冲突标记，先人工处理再刷新', path: 'project.json' }],
    };
  }

  const parsed = strictParse(head.text);
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: parsed.error.code, message: parsed.error.message, path: 'project.json' }] };
  }
  const validated = validateProjectDocument(parsed.value, { sha256 });
  if (!validated.ok) {
    return {
      ok: false,
      issues: validated.issues.map((issue) => ({
        code: issue.code,
        message: issue.message ?? '资料未通过领域校验',
        path: issue.path,
      })),
    };
  }
  const doc = validated.doc;

  const records: RecordBaseline[] = [];
  for (const record of doc.records) {
    const body = await files.readScopedFile(root, record.path);
    if (!body.ok) {
      return {
        ok: false,
        issues: body.issues.map((issue) => ({
          code: issue.code === 'scope-not-found' ? 'body-missing' : issue.code,
          message: issue.message ?? '引用正文不可读',
          path: record.path,
        })),
      };
    }
    const observedHash = 'sha256:' + sha256(body.bytes);
    if (observedHash !== record.contentHash) {
      return {
        ok: false,
        issues: [{ code: 'body-hash-mismatch', message: '正文实际字节哈希与索引不一致', path: record.path }],
      };
    }
    records.push({ path: record.path, contentHash: record.contentHash, observedHash, bytes: body.bytes.length });
  }

  return {
    ok: true,
    doc,
    baseline: {
      projectId: doc.project.id,
      planVersion: doc.planVersion,
      headHash: 'sha256:' + sha256(head.bytes),
      records,
      observedAt: clock(),
    },
  };
}
