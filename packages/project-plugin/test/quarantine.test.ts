// unknown-state 隔离与只读诊断测试（tasks 4.5）。
// 覆盖：回执写入未知 → 隔离并停止命令／回执／恢复；聚合不可读 → 隔离；
// 只读诊断报告；解除隔离必须显式确认；隔离期间资料不被写入。
// 临时目录放在包内 artifacts/。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  quarantineFile: () => string;
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
    quarantineFile: () => path.join(localRoot, 'quarantine', `${instanceId}.json`),
  };
}

function service(ctx: Ctx, hooks?: { state?: PublishHooksPort }): ProjectCommandService {
  return new ProjectCommandService({
    localRoot: ctx.localRoot,
    store: new LocalStateStore(),
    files: createSourceFiles(formatsDir, sha256),
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    ...(hooks === undefined ? {} : { hooks }),
  });
}

/** 让第 3 次聚合写（回执）在 rename 后失败，得到 unknown-state。 */
function unknownOnReceipt(): { state: PublishHooksPort } {
  let count = 0;
  return {
    state: {
      beforeTempWrite: () => {
        count += 1;
      },
      afterRename: () => {
        if (count === 3) throw new Error('injected-unknown-receipt');
      },
    },
  };
}

test('回执写入未知：写隔离标记并停止命令、回执与恢复', async () => {
  const ctx = await setup('quar-unknown-');
  const before = ctx.bytes();
  const envelope = ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '未知回执' } });
  const result = await service(ctx, unknownOnReceipt()).execute(OWNER, envelope);
  assert.equal(result.status, 'pending-reconciliation', JSON.stringify(result));
  assert.equal(result.status === 'pending-reconciliation' ? result.stage : '', 'local-state');

  assert.equal(existsSync(ctx.quarantineFile()), true, '应写隔离标记');
  const marker = JSON.parse(readFileSync(ctx.quarantineFile(), 'utf8')) as {
    reason: string;
    stage: string;
    operationId?: string;
    requires: string;
  };
  assert.equal(marker.reason, 'unknown-state');
  assert.equal(marker.stage, 'receipt');
  assert.equal(marker.operationId, envelope.operationId, '保留原操作 id');
  assert.equal(marker.requires, 'offline-review');

  const bytesAfter = ctx.bytes();
  const blocked = await service(ctx).execute(OWNER, ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '隔离后' } }));
  assert.equal(blocked.status, 'rejected', JSON.stringify(blocked));
  assert.equal(blocked.status === 'rejected' ? blocked.code : '', 'unknown-state');

  const receipt = await service(ctx).getReceipt(OWNER, { instanceId: ctx.instanceId, operationId: envelope.operationId });
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.status === 'rejected' ? receipt.code : '', 'unknown-state');

  const recover = await service(ctx).recover(OWNER, { instanceId: ctx.instanceId, operationId: envelope.operationId });
  assert.equal(recover.status, 'rejected');
  assert.equal(recover.status === 'rejected' ? recover.code : '', 'unknown-state');

  assert.deepEqual(ctx.bytes(), bytesAfter, '隔离期间不得写入资料（含 before 之外的任何改动）');
  assert.notDeepEqual(ctx.bytes(), before);
});

test('只读诊断：列出隔离原因、操作与磁盘比对，且不写文件', async () => {
  const ctx = await setup('quar-diagnostics-');
  const envelope = ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '待核对' } });
  assert.equal((await service(ctx, unknownOnReceipt()).execute(OWNER, envelope)).status, 'pending-reconciliation');
  const bytesBeforeDiag = ctx.bytes();
  const stateBeforeDiag = readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json'));

  const report = await service(ctx).diagnostics(ctx.instanceId);
  assert.equal(report.quarantined?.reason, 'unknown-state');
  assert.equal(report.quarantined?.operationId, envelope.operationId);
  assert.equal(report.operations.length, 1);
  assert.equal(report.operations[0]?.status, 'committed');
  assert.match(report.operations[0]?.candidateHeadHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.current?.planVersion, ctx.planVersion());
  assert.equal(report.comparisons.length, 0, '已 committed 的操作不再参与比对');
  assert.ok(report.guidance.length > 0);
  assert.deepEqual(ctx.bytes(), bytesBeforeDiag, '诊断不得写资料');
  assert.deepEqual(
    readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json')),
    stateBeforeDiag,
    '诊断不得写聚合',
  );
});

test('解除隔离必须显式确认，解除后新命令可执行', async () => {
  const ctx = await setup('quar-release-');
  assert.equal(
    (await service(ctx, unknownOnReceipt()).execute(OWNER, ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'x' } }))).status,
    'pending-reconciliation',
  );

  const store = new LocalStateStore();
  // 未确认不解除（CLI 层校验 --confirm；服务层只提供显式释放入口）。
  assert.equal(existsSync(ctx.quarantineFile()), true);
  const released = await store.releaseQuarantine(ctx.localRoot, ctx.instanceId);
  assert.equal(released, true);
  assert.equal(existsSync(ctx.quarantineFile()), false);
  assert.deepEqual(await store.listQuarantined(ctx.localRoot), []);

  // unknown 只是注入的：聚合实际已推进，解除后必须用当前修订，不能沿用旧基线。
  const current = (
    JSON.parse(readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json'), 'utf8')) as {
      revisions: { plan: number };
    }
  ).revisions.plan;
  const after = await service(ctx).execute(
    OWNER,
    ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '解除后' } }, { expectedPlanRevision: current }),
  );
  assert.equal(after.status, 'committed', JSON.stringify(after));
  const report = await service(ctx).diagnostics(ctx.instanceId);
  assert.equal(report.quarantined, null);
});

test('聚合不可读：隔离为 aggregate-unreadable，诊断仍返回原因', async () => {
  const ctx = await setup('quar-corrupt-');
  const statePath = path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json');
  writeFileSync(statePath, '{ this is not json');
  const before = ctx.bytes();

  const result = await service(ctx).execute(OWNER, ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'x' } }));
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.status === 'rejected' ? result.code : '', 'unknown-state');
  assert.deepEqual(ctx.bytes(), before);

  const marker = JSON.parse(readFileSync(ctx.quarantineFile(), 'utf8')) as { reason: string; stage: string };
  assert.equal(marker.reason, 'aggregate-unreadable');
  assert.equal(marker.stage, 'read');

  const report = await service(ctx).diagnostics(ctx.instanceId);
  assert.equal(report.quarantined?.reason, 'aggregate-unreadable');
  assert.ok(report.issues.length > 0, '聚合不可读应进入 issues');
  assert.equal(report.operations.length, 0);
});

test('诊断对未隔离实例也给出当前基线与指引', async () => {
  const ctx = await setup('quar-clean-');
  const report = await service(ctx).diagnostics(ctx.instanceId);
  assert.equal(report.quarantined, null);
  assert.equal(report.operations.length, 0);
  assert.equal(report.current?.recordCount, 0);
  assert.match(report.current?.headHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.issues.length, 0);
  assert.match(report.guidance[0] ?? '', /未隔离/);
});
