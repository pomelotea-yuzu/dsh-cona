// 公开资料头（project.json）的读写适配器（tasks 3.1）。
// 序列化只影响排版，不改变协议语义：planVersion 由规划投影计算，与键序／缩进无关。
// 写入采用同目录临时文件 + rename，并回读核对；失败注入与三态结果在 3.4 补。

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strictParse } from '../../domain/strict-json.js';
import { validateProjectDocument } from '../../domain/validate.js';
import type {
  DependencyEdge,
  ProjectDocument,
  RecordIndexEntry,
  RecordSource,
  Sha256Fn,
  ValidationIssue,
  WorkNode,
} from '../../domain/types.js';

const PROJECT_FILE = 'project.json';

/** 稳定排版：固定键序 + 2 空格缩进 + 结尾换行，减少 Git 无关差异。 */
export function serializeProjectDocument(doc: ProjectDocument): string {
  const ordered = {
    schemaVersion: doc.schemaVersion,
    project: {
      id: doc.project.id,
      title: doc.project.title,
      goal: doc.project.goal,
      constraints: [...doc.project.constraints],
      repositories: doc.project.repositories.map((repo) => ({ id: repo.id, label: repo.label })),
    },
    plan: {
      nodes: doc.plan.nodes.map((node: WorkNode) => ({
        id: node.id,
        parentId: node.parentId,
        order: node.order,
        title: node.title,
        goal: node.goal,
        completionCriteria: [...node.completionCriteria],
        status: node.status,
      })),
      dependencies: doc.plan.dependencies.map((edge: DependencyEdge) => ({
        nodeId: edge.nodeId,
        requiresNodeId: edge.requiresNodeId,
      })),
    },
    planVersion: doc.planVersion,
    records: doc.records.map((record: RecordIndexEntry) => serializeRecord(record)),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

function serializeRecord(record: RecordIndexEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: record.id,
    kind: record.kind,
    subjectNodeIds: [...record.subjectNodeIds],
    path: record.path,
    contentHash: record.contentHash,
    summary: record.summary,
    sources: record.sources.map((source: RecordSource) =>
      typeof source === 'string'
        ? source
        : {
            repositoryId: source.repositoryId,
            relativePath: source.relativePath,
            ...(source.observedHash === undefined ? {} : { observedHash: source.observedHash }),
          },
    ),
  };
  if (record.verification !== undefined) {
    out.verification = {
      status: record.verification.status,
      subject: { kind: record.verification.subject.kind, id: record.verification.subject.id },
      ...(record.verification.subjectVersion === undefined ? {} : { subjectVersion: record.verification.subjectVersion }),
      ...(record.verification.scope === undefined ? {} : { scope: record.verification.scope }),
    };
  }
  return out;
}

export type ReadProjectDocumentResult =
  | { ok: true; doc: ProjectDocument; text: string }
  | { ok: false; issues: ValidationIssue[] };

/** 读取并完整校验资料头；BOM、非法 UTF-8、未知字段都以稳定码拒绝。 */
export async function readProjectDocument(root: string, sha256?: Sha256Fn): Promise<ReadProjectDocumentResult> {
  const filePath = path.join(root, PROJECT_FILE);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(filePath));
  } catch (error) {
    return { ok: false, issues: [{ code: 'file-unreadable', path: PROJECT_FILE, message: (error as Error).message }] };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, issues: [{ code: 'bom', path: PROJECT_FILE, message: 'project.json 带 UTF-8 BOM，协议拒绝' }] };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false, issues: [{ code: 'invalid-utf8', path: PROJECT_FILE, message: 'project.json 不是合法 UTF-8' }] };
  }
  const parsed = strictParse(text);
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: parsed.error.code, path: PROJECT_FILE, message: parsed.error.message }] };
  }
  const validated = validateProjectDocument(parsed.value, sha256 === undefined ? {} : { sha256 });
  if (!validated.ok) return { ok: false, issues: validated.issues };
  return { ok: true, doc: validated.doc, text };
}

export type WriteProjectDocumentResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

/**
 * 原子替换资料头：临时文件与目标同目录（不跨盘），rename 后逐字节回读核对。
 * 本函数不宣称断电安全；rename 后、回读前的异常在 3.4 以 unknown 表达。
 */
export async function writeProjectDocument(root: string, doc: ProjectDocument): Promise<WriteProjectDocumentResult> {
  const target = path.join(root, PROJECT_FILE);
  const temp = path.join(root, `.${PROJECT_FILE}.tmp-${randomUUID()}`);
  const text = serializeProjectDocument(doc);
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    return {
      ok: false,
      issues: [{ code: 'persistence-failed', path: PROJECT_FILE, message: (error as Error).message }],
    };
  }
  try {
    const readBack = await readFile(target, 'utf8');
    if (readBack !== text) {
      return {
        ok: false,
        issues: [{ code: 'persistence-reread-mismatch', path: PROJECT_FILE, message: '回读字节与写入内容不一致' }],
      };
    }
  } catch (error) {
    return { ok: false, issues: [{ code: 'persistence-failed', path: PROJECT_FILE, message: (error as Error).message }] };
  }
  return { ok: true };
}
