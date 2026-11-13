// 独立校验命令（tasks 1.5）：在无 DSH 服务的纯 Node 进程中校验公开资料。
// 不加载宿主、浏览器或模型服务；不执行资料根内的校验脚本或远程引用。
// 用法：
//   validate.js check <root>                      校验资料根（project.json + 记录正文 + 孤立正文）
//   validate.js check-file <file>                 校验单个 project.json
//   validate.js compute-plan-version <file>       输出期望指纹（可 --print-canonical 输出规范文本）
//   validate.js init <dir>                        建立资料根骨架（README / protocol / schema / records）
// 输出为一行 JSON；校验失败退出码 1。

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  findOrphanBodies,
  referencedBodyPaths,
  strictParse,
  utf8Encode,
  validateProjectDocument,
  computePlanVersion,
} from '../domain/index.js';
import type { ProjectDocument, Sha256Fn, ValidationIssue } from '../domain/types.js';

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonicalTextOf(doc: ProjectDocument): string {
  return computePlanVersion(doc, sha256).canonicalText;
}

function planVersionFromValidatedDoc(doc: ProjectDocument): string {
  return computePlanVersion(doc, sha256).planVersion;
}

async function readProjectJsonText(filePath: string): Promise<{ ok: true; text: string } | { ok: false; issue: ValidationIssue }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(filePath));
  } catch (error) {
    return { ok: false, issue: { code: 'file-unreadable', path: filePath, message: (error as Error).message } };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, issue: { code: 'bom', path: filePath, message: 'project.json 带 UTF-8 BOM，协议拒绝' } };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return { ok: true, text: decoder.decode(bytes) };
  } catch {
    return { ok: false, issue: { code: 'invalid-utf8', path: filePath, message: 'project.json 不是合法 UTF-8' } };
  }
}

async function listRecordBodies(root: string): Promise<string[]> {
  const recordsDir = path.join(root, 'records');
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(recordsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const subDir = path.join(recordsDir, entry.name);
    if (!entry.isDirectory()) continue;
    let files;
    try {
      files = await readdir(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      // 协议路径分段已知合法（records/<id>/<hex>.md），直接拼接。
      found.push(`records/${entry.name}/${file.name}`);
    }
  }
  return found;
}

interface RootCheckResult {
  ok: boolean;
  root: string;
  planVersion?: string;
  issues: ValidationIssue[];
}

async function checkRoot(root: string): Promise<RootCheckResult> {
  const issues: ValidationIssue[] = [];
  const projectJsonPath = path.join(root, 'project.json');
  const read = await readProjectJsonText(projectJsonPath);
  if (!read.ok) {
    return { ok: false, root, issues: [read.issue] };
  }
  const parsed = strictParse(read.text);
  if (!parsed.ok) {
    return { ok: false, root, issues: [{ code: parsed.error.code, path: '/<root>/project.json', message: parsed.error.message }] };
  }
  const validated = validateProjectDocument(parsed.value, { sha256 });
  let doc: ProjectDocument | null = validated.ok ? validated.doc : null;
  if (!validated.ok) {
    issues.push(...validated.issues);
  }

  if (doc !== null) {
    // 引用正文逐字节核对（正文哈希覆盖实际字节）。
    for (const record of doc.records) {
      const bodyPath = path.join(root, ...record.path.split('/'));
      try {
        const info = await stat(bodyPath);
        if (!info.isFile()) {
          issues.push({ code: 'body-not-regular-file', path: record.path, message: '引用正文不是常规文件' });
          continue;
        }
        const bytes = new Uint8Array(await readFile(bodyPath));
        const actual = sha256(bytes);
        if ('sha256:' + actual !== record.contentHash) {
          issues.push({ code: 'body-hash-mismatch', path: record.path, message: '正文实际字节哈希与索引 contentHash 不一致' });
        }
      } catch {
        issues.push({ code: 'body-missing', path: record.path, message: '索引引用的正文不存在' });
      }
    }
    // 孤立正文不发布。
    const present = await listRecordBodies(root);
    const orphans = findOrphanBodies(present, doc.records);
    for (const orphan of orphans) {
      issues.push({ code: 'orphan-body', path: orphan, message: '孤立正文：未被任何索引条目引用，不得发布' });
    }
    void referencedBodyPaths;
  }

  return {
    ok: issues.length === 0,
    root,
    planVersion: doc?.planVersion,
    issues,
  };
}

async function checkFile(filePath: string): Promise<{ ok: boolean; issues: ValidationIssue[]; planVersion?: string }> {
  const read = await readProjectJsonText(filePath);
  if (!read.ok) {
    return { ok: false, issues: [read.issue] };
  }
  const parsed = strictParse(read.text);
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: parsed.error.code, path: '', message: parsed.error.message }] };
  }
  // 完整校验（含自报 planVersion 与重算指纹比对）。
  const validated = validateProjectDocument(parsed.value, { sha256 });
  if (!validated.ok) {
    return { ok: false, issues: validated.issues };
  }
  return { ok: true, issues: [], planVersion: validated.doc.planVersion };
}

async function computePlanVersionCommand(filePath: string, printCanonical: boolean): Promise<{ ok: boolean; issues: ValidationIssue[]; planVersion?: string; canonicalText?: string }> {
  const read = await readProjectJsonText(filePath);
  if (!read.ok) {
    return { ok: false, issues: [read.issue] };
  }
  const parsed = strictParse(read.text);
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: parsed.error.code, path: '', message: parsed.error.message }] };
  }
  // 显式计算期望指纹：忽略自报 planVersion（投影不含该字段），在内存中临时替换为
  // 合法形态后校验；只读行为，不写回文件，不暗中修复资料。
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value) && 'planVersion' in parsed.value) {
    parsed.value['planVersion'] = 'sha256:' + '0'.repeat(64);
  }
  const validated = validateProjectDocument(parsed.value);
  if (!validated.ok) {
    return { ok: false, issues: validated.issues };
  }
  const computed = planVersionFromValidatedDoc(validated.doc);
  return {
    ok: true,
    issues: [],
    planVersion: computed,
    canonicalText: printCanonical ? canonicalTextOf(validated.doc) : undefined,
  };
}

async function copyFile(source: string, target: string): Promise<void> {
  await writeFile(target, await readFile(source));
}

/** 建立资料根骨架：README、协议正文、向量、schema 与 records/ 目录。不生成 project.json（由创建命令负责）。 */
async function initRoot(target: string, packageRoot: string): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
  const formatsDir = path.join(packageRoot, 'formats', 'v1');
  const issues: ValidationIssue[] = [];
  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      issues.push({ code: 'init-target-not-directory', path: target });
      return { ok: false, issues };
    }
    const existing = await readdir(target);
    if (existing.includes('project.json')) {
      issues.push({ code: 'init-target-not-empty', path: target, message: '目标已存在 project.json，拒绝覆盖' });
      return { ok: false, issues };
    }
  } catch {
    // 目录不存在：创建。
  }
  await mkdir(path.join(target, 'records'), { recursive: true });
  await mkdir(path.join(target, 'schema'), { recursive: true });
  await mkdir(path.join(target, 'protocol'), { recursive: true });
  await copyFile(path.join(formatsDir, 'project-README.template.md'), path.join(target, 'README.md'));
  await copyFile(path.join(formatsDir, 'project-v1.schema.json'), path.join(target, 'schema', 'project-v1.schema.json'));
  await copyFile(path.join(formatsDir, 'plan-canonicalization.md'), path.join(target, 'protocol', 'plan-canonicalization.md'));
  await copyFile(path.join(formatsDir, 'plan-vectors.json'), path.join(target, 'protocol', 'plan-vectors.json'));
  return { ok: true, issues };
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'print-canonical': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  const target = positionals[1];
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (command === undefined || target === undefined) {
    process.stderr.write('用法: validate.js <check|check-file|compute-plan-version|init> <path> [--print-canonical]\n');
    return 2;
  }
  try {
    if (command === 'check') {
      const result = await checkRoot(path.resolve(target));
      process.stdout.write(JSON.stringify(result) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'check-file') {
      const result = await checkFile(path.resolve(target));
      process.stdout.write(JSON.stringify(result) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'compute-plan-version') {
      const result = await computePlanVersionCommand(path.resolve(target), values['print-canonical'] === true);
      process.stdout.write(JSON.stringify(result) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'init') {
      const result = await initRoot(path.resolve(target), packageRoot);
      process.stdout.write(JSON.stringify({ ...result, target: path.resolve(target) }) + '\n');
      return result.ok ? 0 : 1;
    }
    process.stderr.write(`未知命令：${command}\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`校验命令执行失败：${(error as Error).message}\n`);
    return 2;
  }
}

process.exitCode = await main();
void utf8Encode;
