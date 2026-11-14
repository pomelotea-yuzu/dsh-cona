// 候选核对与恢复测试（tasks 4.4）。
// 覆盖：prepared 终止为未发布、publishing 精确匹配候选后补回执且修订只推一次、
// 退回原基线与分叉保持待核对、committed 在资料回退后只返历史不重放、反复重开不重复计数。
// 临时目录放在包内 artifacts/。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import type { PublishHooksPort } from '../src/application/ports.js';

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
  projectFile: () => string;
  bytes: () => Buffer;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
}

async function setup(name: string): Promise<Ctx> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store: new LocalStateStore(),
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
  const projectFile = path.join(source, 'project.json');
  const planVersion = (): string => (JSON.parse(readFileSync(projectFile, 'utf8')) as { planVersion: string }).planVersion;
  return {
    localRoot,
    source,
    instanceId,
    planVersion,
    projectFile: () => projectFile,
    bytes: () => readFileSync(projectFile),
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

function service(
  ctx: Ctx,
  options: { hooks?: { publish?: PublishHooksPort; body?: PublishHooksPort; state?: PublishHooksPort } } = {},
): ProjectCommandService {
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

function state(ctx: Ctx): {
  revisions: { plan: number; state: number };
  operations: { operationId: string; status: string; recovered?: boolean; result?: { planRevision: number; stateRevision: number } }[];
} {
  return JSON.parse(readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json'), 'utf8')) as never;
}

/** 构造停在 publishing 的记录：资料头已替换但回执未写。 */
async function stuckAtPublishing(ctx: Ctx, command: Command): Promise<{ operationId: string; bytes: Buffer }> {
  const svc = service(ctx, {
    hooks: {
      publish: {
        afterRename: () => {
          throw new Error('injected-head-unknown');
        },
      },
    },
  });
  const envelope = ctx.envelope(command);
  const result = await svc.execute(OWNER, envelope);
  assert.equal(result.status, 'pending-reconciliation', JSON.stringify(result));
  return { operationId: envelope.operationId, bytes: ctx.bytes() };
}

test('prepared 阶段恢复：标记未发布并解除阻塞，不重放', async () => {
  const ctx = await setup('recover-prepared-');
  let count = 0;
  const svc = service(ctx, {
    hooks: {
      state: {
        beforeTempWrite: () => {
          count += 1;
          // 第 2 次（publishing）与第 3 次（拒绝回执）都失败，记录停在 prepared。
          if (count === 2 || count === 3) throw new Error('stop-after-prepared');
        },
      },
    },
  });
  const envelope = ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '未发布' } });
  const first = await svc.execute(OWNER, envelope);
  assert.equal(first.status, 'rejected', JSON.stringify(first));
  assert.equal(state(ctx).operations[0]?.status, 'prepared');
  const before = ctx.bytes();

  // 新服务（模拟重启）恢复：标记未发布。
  const recovered = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: envelope.operationId });
  assert.equal(recovered.status, 'rejected', JSON.stringify(recovered));
  assert.equal(recovered.status === 'rejected' ? recovered.code : '', 'not-published');
  assert.equal(recovered.status === 'rejected' ? recovered.recovery : '', 'not-published');
  assert.equal(state(ctx).operations[0]?.status, 'rejected');
  assert.deepEqual(ctx.bytes(), before, '恢复不得写入资料');

  // 未决解除后新命令可执行。
  const next = await service(ctx).execute(OWNER, {
    ...ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '新命令' } }),
  });
  assert.equal(next.status, 'committed', JSON.stringify(next));
});

test('publishing 精确匹配候选：补回执且双修订只推一次', async () => {
  const ctx = await setup('recover-matched-');
  const stuck = await stuckAtPublishing(ctx, { type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '候选已发布' } });
  assert.equal(state(ctx).operations[0]?.status, 'publishing');
  assert.deepEqual(state(ctx).revisions, { plan: 0, state: 0 });

  const first = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: stuck.operationId });
  assert.equal(first.status, 'committed', JSON.stringify(first));
  assert.equal(first.status === 'committed' ? first.recovery : '', 'candidate-matched');
  assert.equal(first.status === 'committed' ? first.planRevision : -1, 1);
  assert.equal(first.status === 'committed' ? first.stateRevision : -1, 1);
  assert.deepEqual(state(ctx).revisions, { plan: 1, state: 1 });
  assert.equal(state(ctx).operations[0]?.recovered, true);

  // 反复重开再恢复：返回历史，修订不再推进。
  const again = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: stuck.operationId });
  assert.equal(again.status, 'committed');
  assert.equal(again.status === 'committed' ? again.recovery : '', 'history');
  assert.deepEqual(state(ctx).revisions, { plan: 1, state: 1 });
});

test('publishing 但资料退回原基线：保持待核对，不宣称未提交', async () => {
  const ctx = await setup('recover-reverted-');
  const original = ctx.bytes();
  const stuck = await stuckAtPublishing(ctx, { type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '会被回退' } });
  assert.notDeepEqual(ctx.bytes(), original);

  // 模拟 Git 回退：把资料换回提交前的字节。
  writeFileSync(ctx.projectFile(), original);
  const result = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: stuck.operationId });
  assert.equal(result.status, 'pending-reconciliation', JSON.stringify(result));
  assert.equal(result.status === 'pending-reconciliation' ? result.stage : '', 'reverted');
  assert.deepEqual(state(ctx).revisions, { plan: 0, state: 0 });
  assert.equal(state(ctx).operations[0]?.status, 'publishing', '未决保持');
});

test('publishing 已分叉：保持待核对，不自动覆盖', async () => {
  const ctx = await setup('recover-diverged-');
  const stuck = await stuckAtPublishing(ctx, { type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '候选' } });

  // 合法但既非候选也非原基线的第三方内容。
  const doc = JSON.parse(ctx.bytes().toString('utf8')) as ProjectDocument;
  const diverged: ProjectDocument = {
    ...doc,
    project: { ...doc.project, goal: '第三方改动' },
    planVersion: '',
  };
  diverged.planVersion = computePlanVersion(diverged, sha256).planVersion;
  writeFileSync(ctx.projectFile(), JSON.stringify(diverged, null, 2) + '\n');

  const result = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: stuck.operationId });
  assert.equal(result.status, 'pending-reconciliation', JSON.stringify(result));
  assert.equal(result.status === 'pending-reconciliation' ? result.stage : '', 'diverged');
  assert.equal(state(ctx).operations[0]?.status, 'publishing');
});

test('committed 之后资料回退：重试只返历史，不重放到当前分支', async () => {
  const ctx = await setup('recover-history-');
  const before = ctx.bytes();
  const envelope = ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '已提交' } });
  const committed = await service(ctx).execute(OWNER, envelope);
  assert.equal(committed.status, 'committed', JSON.stringify(committed));

  // 模拟 Git 回退到旧规划。
  writeFileSync(ctx.projectFile(), before);
  const bytesAfterRevert = ctx.bytes();

  const retry = await service(ctx).execute(OWNER, envelope);
  assert.equal(retry.status, 'committed', JSON.stringify(retry));
  assert.equal(retry.status === 'committed' ? retry.replayed : false, true);
  assert.deepEqual(ctx.bytes(), bytesAfterRevert, '历史回执不得重新应用到当前分支');

  const receipt = await service(ctx).getReceipt(OWNER, { instanceId: ctx.instanceId, operationId: envelope.operationId });
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.status === 'committed' ? receipt.replayed : false, true);

  const recovered = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: envelope.operationId });
  assert.equal(recovered.status, 'committed');
  assert.equal(recovered.status === 'committed' ? recovered.recovery : '', 'history');
  assert.deepEqual(ctx.bytes(), bytesAfterRevert);
});

test('恢复：归属不明或记录不存在时明确拒绝', async () => {
  const ctx = await setup('recover-guard-');
  const agentSvc = service(ctx);
  const envelope = ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '工具' } });
  const viaAgent = await agentSvc.execute(
    { kind: 'agent-work', workRunId: 'run-a', bindingVersion: 1, instanceId: ctx.instanceId },
    envelope,
  );
  assert.equal(viaAgent.status, 'committed');

  const ownerRecover = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: envelope.operationId });
  assert.equal(ownerRecover.status, 'rejected');
  assert.equal(ownerRecover.status === 'rejected' ? ownerRecover.code : '', 'forbidden');

  const missing = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: randomUUID() });
  assert.equal(missing.status, 'not-found');

  const noContext = await service(ctx).recover(undefined, { instanceId: ctx.instanceId, operationId: envelope.operationId });
  assert.equal(noContext.status, 'rejected');
  assert.equal(noContext.status === 'rejected' ? noContext.code : '', 'forbidden');
});
