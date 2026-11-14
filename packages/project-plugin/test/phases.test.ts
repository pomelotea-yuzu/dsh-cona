// 持久阶段与中断注入测试（tasks 4.3）。
// 覆盖：prepared／publishing／committed／rejected 阶段、正文先于资料头、各边界失败结局、
// 未决意图阻止新写、通知失败不撤回提交，以及“重开”（新服务实例）后的观察。
// 临时目录放在包内 artifacts/。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateService } from '../src/application/local-state.js';
import {
  ProjectCommandService,
  type Command,
  type CommandEnvelope,
  type TrustedContext,
} from '../src/application/command-service.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import type { PublishHooksPort } from '../src/application/ports.js';
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const OWNER: TrustedContext = { kind: 'remote-owner' };

interface Ctx {
  localRoot: string;
  source: string;
  instanceId: string;
  planVersion: () => string;
  bytes: () => Buffer;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
}

async function setup(name: string): Promise<Ctx> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const store = new LocalStateStore();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store,
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot,
    sourceRoot: source,
    sourceKind: 'custom',
    projectId: PROJECT_ID,
  });
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;
  const planVersion = (): string =>
    (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  return {
    localRoot,
    source,
    instanceId,
    planVersion,
    bytes: () => readFileSync(path.join(source, 'project.json')),
    envelope: (command, overrides = {}) => ({
      operationId: randomUUID(),
      projectId: PROJECT_ID,
      instanceId,
      sourceEpoch: registered.entry.sourceGeneration,
      expectedPlanVersion: planVersion(),
      expectedPlanRevision: 0,
      command,
      ...overrides,
    }),
  };
}

function service(ctx: Ctx, options: { hooks?: { publish?: PublishHooksPort; body?: PublishHooksPort; state?: PublishHooksPort }; notify?: () => void } = {}): ProjectCommandService {
  return new ProjectCommandService({
    localRoot: ctx.localRoot,
    store: new LocalStateStore(),
    files: createSourceFiles(formatsDir, sha256),
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    ...options,
  });
}

/** 第 n 次调用抛错；用于区分 prepared／publishing／回执三次聚合写。 */
function failAt(n: number): PublishHooksPort {
  let count = 0;
  return {
    beforeTempWrite: () => {
      count += 1;
      if (count === n) throw new Error(`injected-fail-at-${n}`);
    },
  };
}

function operations(ctx: Ctx): { operationId: string; status: string }[] {
  return (
    JSON.parse(readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json'), 'utf8')) as {
      operations: { operationId: string; status: string }[];
    }
  ).operations;
}

function recordCommand(body: string): Command {
  return {
    type: 'append-record',
    kind: 'analysis-note',
    subjectNodeIds: [ROOT_NODE],
    summary: '阶段测试',
    sources: [],
    body,
  };
}

test('顺序：正文先于资料头写入', async () => {
  const ctx = await setup('phase-order-');
  const order: string[] = [];
  const svc = service(ctx, {
    hooks: {
      body: { beforeTempWrite: () => { order.push('body'); } },
      publish: { beforeTempWrite: () => { order.push('head'); } },
    },
  });
  const result = await svc.execute(OWNER, ctx.envelope(recordCommand('# 正文\n')));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.deepEqual(order, ['body', 'head']);
  assert.equal(operations(ctx)[0]?.status, 'committed');
});

test('prepared 意图写入失败：不写正文、不改资料头', async () => {
  const ctx = await setup('phase-prepared-fail-');
  const before = ctx.bytes();
  const svc = service(ctx, { hooks: { state: failAt(1) } });
  const result = await svc.execute(OWNER, ctx.envelope(recordCommand('# 正文\n')));
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.status === 'rejected' ? result.code : '', 'persistence-failed');
  assert.deepEqual(ctx.bytes(), before);
  assert.equal(operations(ctx).length, 0, 'prepared 未保存时不留记录');
  const doc = JSON.parse(before.toString('utf8')) as { records: unknown[] };
  assert.equal(doc.records.length, 0);
});

test('publishing 阶段写入失败：拒绝且不发布正文与头', async () => {
  const ctx = await setup('phase-publishing-fail-');
  const before = ctx.bytes();
  const svc = service(ctx, { hooks: { state: failAt(2) } });
  const result = await svc.execute(OWNER, ctx.envelope(recordCommand('# 正文\n')));
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.deepEqual(ctx.bytes(), before);
  const op = operations(ctx)[0];
  assert.equal(op?.status, 'rejected', '明确未发布后标记 rejected');
});

test('正文写入失败：头不发布，记录拒绝', async () => {
  const ctx = await setup('phase-body-fail-');
  const before = ctx.bytes();
  const svc = service(ctx, {
    hooks: {
      body: {
        beforeTempWrite: () => {
          throw new Error('injected-body-fail');
        },
      },
    },
  });
  const result = await svc.execute(OWNER, ctx.envelope(recordCommand('# 正文\n')));
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.status === 'rejected' ? result.code : '', 'persistence-failed');
  assert.deepEqual(ctx.bytes(), before, '正文失败时不得发布资料头');
  assert.equal(operations(ctx)[0]?.status, 'rejected');
});

test('资料头 not-published：正文已写但未引用，头不变', async () => {
  const ctx = await setup('phase-head-abort-');
  const before = ctx.bytes();
  const svc = service(ctx, {
    hooks: {
      publish: {
        beforeRename: () => {
          throw new Error('injected-head-abort');
        },
      },
    },
  });
  const result = await svc.execute(OWNER, ctx.envelope(recordCommand('# 正文\n')));
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.deepEqual(ctx.bytes(), before, '头未替换');
  const doc = JSON.parse(before.toString('utf8')) as { records: unknown[] };
  assert.equal(doc.records.length, 0, '正文虽已写，但索引未引用它');
  assert.equal(operations(ctx)[0]?.status, 'rejected');
});

test('资料头 unknown：停在 publishing，新命令被未决意图阻止', async () => {
  const ctx = await setup('phase-head-unknown-');
  const svc = service(ctx, {
    hooks: {
      publish: {
        afterRename: () => {
          throw new Error('injected-head-unknown');
        },
      },
    },
  });
  const stuck = await svc.execute(OWNER, ctx.envelope(recordCommand('# 正文\n')));
  assert.equal(stuck.status, 'pending-reconciliation', JSON.stringify(stuck));
  assert.equal(stuck.status === 'pending-reconciliation' ? stuck.stage : '', 'head');
  assert.equal(operations(ctx)[0]?.status, 'publishing');
  const bytesAfterStuck = ctx.bytes();

  // 重开：新服务实例读同一本机根；另一条命令必须被阻止，而不是继续写入。
  const fresh = service(ctx);
  const blocked = await fresh.execute(OWNER, ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '新命令' } }));
  assert.equal(blocked.status, 'pending-reconciliation', JSON.stringify(blocked));
  assert.equal(blocked.status === 'pending-reconciliation' ? blocked.stage : '', 'instance-blocked');
  assert.deepEqual(ctx.bytes(), bytesAfterStuck, '未决期间不得写入');

  // 同一 operationId 重试仍然待核对，不重跑。
  const retry = await fresh.execute(OWNER, ctx.envelope(recordCommand('# 正文\n'), { operationId: stuck.status === 'pending-reconciliation' ? stuck.operationId : randomUUID() }));
  assert.equal(retry.status, 'pending-reconciliation');
});

test('回执写入失败：资料已发布，返回待核对而不是可重试失败', async () => {
  const ctx = await setup('phase-receipt-fail-');
  const svc = service(ctx, { hooks: { state: failAt(3) } });
  const result = await svc.execute(OWNER, ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '回执失败' } }));
  assert.equal(result.status, 'pending-reconciliation', JSON.stringify(result));
  assert.equal(result.status === 'pending-reconciliation' ? result.stage : '', 'receipt');
  // 资料确实已发布（update-node 改的是节点目标）。
  const plan = JSON.parse(ctx.bytes().toString('utf8')) as { plan: { nodes: { id: string; goal: string }[] } };
  assert.equal(plan.plan.nodes[0]?.goal, '回执失败');
  assert.equal(operations(ctx)[0]?.status, 'publishing', '回执未落盘时停在 publishing');
});

test('通知失败不撤回提交', async () => {
  const ctx = await setup('phase-notify-fail-');
  const svc = service(ctx, {
    notify: () => {
      throw new Error('injected-notify-fail');
    },
  });
  const result = await svc.execute(OWNER, ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '通知失败' } }));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal(operations(ctx)[0]?.status, 'committed');
  const receipt = await svc.getReceipt(OWNER, {
    instanceId: ctx.instanceId,
    operationId: result.status === 'committed' ? result.operationId : '',
  });
  assert.equal(receipt.status, 'committed', '回执仍可查，未因通知失败回滚');
});

test('prepared 意图保存候选头与正文清单，可供恢复核对', async () => {
  const ctx = await setup('phase-candidate-');
  const svc = service(ctx, {
    hooks: {
      body: {
        beforeTempWrite: () => {
          throw new Error('stop-before-body');
        },
      },
    },
  });
  const result = await svc.execute(OWNER, ctx.envelope(recordCommand('# 候选\n')));
  assert.equal(result.status, 'rejected');
  const aggregate = JSON.parse(
    readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json'), 'utf8'),
  ) as {
    operations: {
      prepared?: { candidateHead: string; candidateHeadHash: string; bodies: { path: string; contentHash: string }[]; writeHead: boolean };
    }[];
  };
  const prepared = aggregate.operations[0]?.prepared;
  assert.ok(prepared !== undefined, '拒绝后仍保留 prepared 内容用于诊断');
  assert.match(prepared?.candidateHeadHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal((prepared?.candidateHead ?? '').includes('"planVersion"'), true);
  assert.equal(prepared?.bodies.length, 1);
  assert.match(prepared?.bodies[0]?.contentHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(prepared?.writeHead, true);
});
