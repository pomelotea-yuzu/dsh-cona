// 结构化替代记录独立校验器（tasks 2.2，design §2）：纯 Node，无 DSH 依赖。
// 从 project.json 出发：读取 plan-change 索引 → 按摘要前缀与正文首行识别替代
// 记录 → 复算正文哈希 → 按索引顺序投影替代关系（clear 指向更早、来源当前
// 指向逐项核对、拒绝重复活跃来源与替代链成环）。任一步失败输出记录 ID、
// 字段与原因并以非零码退出。
//
// 用法：node lib/cli/validate-replacement.js --source <资料根> [--quiet]

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { readInScope } from '../adapters/fs/path-scope.js';
import { parseReplacementText, REPLACEMENT_SUMMARY_PREFIX, type ReplacementBody } from '../domain/replacement.js';
import type { ReplacementReplaceBody } from '../domain/replacement.js';

interface IndexEntry {
  id: string;
  kind: string;
  summary: string;
  path: string;
  contentHash: string;
  subjectNodeIds: string[];
}

function fail(message: string): never {
  process.stderr.write(`replacement 校验失败：${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { source: { type: 'string' }, quiet: { type: 'boolean', default: false } },
  });
  if (typeof values.source !== 'string') {
    process.stderr.write('用法：validate-replacement.js --source <资料根> [--quiet]\n');
    return 2;
  }
  const root = path.resolve(values.source);
  const quiet = values.quiet === true;
  const out = (line: string): void => {
    if (!quiet) process.stdout.write(line + '\n');
  };

  // 索引：严格读取（与领域校验同一套规则由 validateProjectDocument 承担；
  // 本校验器独立实现最小读取，不 import 应用层）。
  const head = await readInScope(root, 'project.json');
  if (!head.ok) fail(`project.json 不可读：${head.issues[0]?.code ?? 'unknown'}`);
  if (!head.ok) return 1;
  const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(head.bytes)) as {
    project: { id: string };
    plan: { nodes: { id: string; status: string }[]; dependencies: { nodeId: string; requiresNodeId: string }[] };
    records: IndexEntry[];
  };
  const nodeIds = new Set(doc.plan.nodes.map((node) => node.id));

  // 识别替代记录：plan-change + 摘要前缀；正文哈希先核对。
  const ordered: { entry: IndexEntry; body: ReplacementBody }[] = [];
  for (const entry of doc.records) {
    if (entry.kind !== 'plan-change' || !entry.summary.startsWith(REPLACEMENT_SUMMARY_PREFIX)) continue;
    const body = await readInScope(root, entry.path);
    if (!body.ok) fail(`记录 ${entry.id} 正文不可读：${body.issues[0]?.code ?? 'unknown'}`);
    if (!body.ok) return 1;
    const actualHash = 'sha256:' + createHash('sha256').update(body.bytes).digest('hex');
    if (actualHash !== entry.contentHash) fail(`记录 ${entry.id} 正文哈希与索引不一致（${entry.contentHash}）`);
    const parsed = parseReplacementText(new TextDecoder().decode(body.bytes));
    if (!parsed.ok) {
      const first = parsed.issues[0]!;
      fail(`记录 ${entry.id} 替代正文无效：${first.code} ${first.path ?? ''} ${first.message}`);
    }
    ordered.push({ entry, body: parsed.body });
  }
  out(`替代记录 ${ordered.length} 条（索引共 ${doc.records.length} 条记录）。`);

  // 按索引顺序投影替代关系。
  const published = new Set<string>();
  const active = new Map<string, string>(); // 来源节点 → 保留节点（当前活跃替代）
  const activeRecordOf = new Map<string, string>(); // 来源节点 → 建立替代的记录 id
  const resolvedRecords = new Set<string>(); // 已被 clear 解除过的记录 id
  for (const { entry, body } of ordered) {
    published.add(entry.id);
    if (body.kind === 'clear') {
      const target = ordered.find((item) => item.entry.id === body.clearsRecordId);
      if (target === undefined || target.entry.id === entry.id) {
        fail(`记录 ${entry.id}：clear 指向不存在或更晚的记录 ${body.clearsRecordId}`);
      }
      if (target.body.kind !== 'replace') fail(`记录 ${entry.id}：clear 指向的 ${body.clearsRecordId} 不是 replace 记录`);
      if (resolvedRecords.has(body.clearsRecordId)) fail(`记录 ${entry.id}：重复解除记录 ${body.clearsRecordId}`);
      for (const source of target.body.sourceNodeIds) {
        if (activeRecordOf.get(source) !== body.clearsRecordId) {
          fail(`记录 ${entry.id}：来源 ${source} 当前不指向被解除记录 ${body.clearsRecordId}（部分清除）`);
        }
      }
      for (const source of target.body.sourceNodeIds) {
        active.delete(source);
        activeRecordOf.delete(source);
      }
      resolvedRecords.add(body.clearsRecordId);
      out(`  ${entry.id.slice(0, 8)} clear → 解除 ${body.clearsRecordId.slice(0, 8)}（${target.body.sourceNodeIds.length} 个来源）。`);
      continue;
    }
    // replace：subjectNodeIds 覆盖来源与保留节点；来源必须都是项目节点。
    for (const id of body.sourceNodeIds) {
      if (!nodeIds.has(id)) fail(`记录 ${entry.id}：来源节点 ${id} 不在当前规划中`);
    }
    if (!nodeIds.has(body.replacementNodeId)) fail(`记录 ${entry.id}：保留节点 ${body.replacementNodeId} 不在当前规划中`);
    const covered = new Set<string>(entry.subjectNodeIds);
    for (const id of [body.replacementNodeId, ...body.sourceNodeIds]) {
      if (!covered.has(id)) fail(`记录 ${entry.id}：索引 subjectNodeIds 未覆盖 ${id}`);
    }
    for (const source of body.sourceNodeIds) {
      if (active.has(source)) {
        fail(`记录 ${entry.id}：来源 ${source} 已有活跃替代（记录 ${activeRecordOf.get(source)}）；拒绝重复活跃来源`);
      }
    }
    // 替代链成环检查：把本次映射加入后，从保留节点沿活跃链出发不得回到任一来源。
    for (const source of body.sourceNodeIds) active.set(source, body.replacementNodeId);
    for (const source of body.sourceNodeIds) {
      const seen = new Set<string>([source]);
      let cursor: string | undefined = active.get(source);
      while (cursor !== undefined) {
        if (seen.has(cursor) || body.sourceNodeIds.includes(cursor)) {
          fail(`记录 ${entry.id}：替代链经 ${cursor} 成环`);
        }
        seen.add(cursor);
        cursor = active.get(cursor);
      }
    }
    for (const source of body.sourceNodeIds) activeRecordOf.set(source, entry.id);
    out(`  ${entry.id.slice(0, 8)} replace → ${body.sourceNodeIds.length} 个来源并入 ${body.replacementNodeId.slice(0, 8)}。`);
  }

  out('replacement 校验通过。');
  return 0;
}

process.exitCode = await main();
