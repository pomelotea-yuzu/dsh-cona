// 命令封套、访问校验、不可变变换与每实例队列测试（tasks 4.1）。
// 覆盖：规划命令提交与双修订、UI／工具同规则、过程记录不推动规划版本、真实规划冲突、
// 完成命令条件、源代际与身份、并发队列、正文/头发布失败的结局。
// 临时目录放在包内 artifacts/。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateService } from '../src/application/local-state.js';
import { ProjectCommandService, type Command, type CommandEnvelope, type CommandResult, type TrustedContext } from '../src/application/command-service.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const CHILD_NODE = '00000000-0000-4000-8000-000000000003';

interface Fixture {
  base: string;
  localRoot: string;
  source: string;
  instanceId: string;
  service: ProjectCommandService;
  store: LocalStateStore;
  planVersion: () => string;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
}

async function setup(name: string): Promise<Fixture> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
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
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error('register failed');

  const service = new ProjectCommandService({
    localRoot,
    store,
    files,
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
  });

  const planVersion = (): string =>
    (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;

  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId: registered.entry.instanceId,
    sourceEpoch: registered.entry.sourceGeneration,
    expectedPlanVersion: planVersion(),
    expectedPlanRevision: 0,
    command,
    ...overrides,
  });

  return { base, localRoot, source, instanceId: registered.entry.instanceId, service, store, planVersion, envelope };
}

function readAggregate(fx: Fixture): { revisions: { plan: number; state: number }; lastObservation: { planVersion: string; headHash: string; records: { path: string }[] } | null } {
  const file = path.join(fx.localRoot, 'instances', fx.instanceId, 'state.json');
  return JSON.parse(readFileSync(file, 'utf8')) as never;
}

const OWNER: TrustedContext = { kind: 'remote-owner' };
const AGENT = (instanceId: string): TrustedContext => ({
  kind: 'agent-work',
  workRunId: 'work-run-1',
  bindingVersion: 1,
  instanceId,
});

function rejected(result: CommandResult): Extract<CommandResult, { status: 'rejected' }> {
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  return result as Extract<CommandResult, { status: 'rejected' }>;
}

test('规划命令：提交成功推进双修订并写回磁盘', async () => {
  const fx = await setup('cmd-plan-');
  const beforeVersion = fx.planVersion();
  const result = await fx.service.execute(
    OWNER,
    fx.envelope({
      type: 'add-nodes',
      nodes: [{ parentId: ROOT_NODE, order: 1, title: '新节点', goal: '目标', completionCriteria: [] }],
    }),
  );
  assert.equal(result.status, 'committed', JSON.stringify(result));
  if (result.status !== 'committed') return;
  assert.equal(result.impact, 'plan');
  assert.equal(result.planRevision, 1);
  assert.equal(result.stateRevision, 1);
  assert.notEqual(result.planVersion, beforeVersion);

  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as {
    plan: { nodes: { title: string }[] };
    planVersion: string;
  };
  assert.equal(doc.plan.nodes.length, 3);
  assert.equal(doc.plan.nodes[2]?.title, '新节点');
  assert.equal(doc.planVersion, result.planVersion);

  const aggregate = readAggregate(fx);
  assert.deepEqual(aggregate.revisions, { plan: 1, state: 1 });
  assert.equal(aggregate.lastObservation?.planVersion, result.planVersion);
});

test('UI 与工具同规则：两种入口同一校验与提交序列', async () => {
  const fx = await setup('cmd-same-rules-');

  const viaOwner = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '由 owner 修改' } }),
  );
  assert.equal(viaOwner.status, 'committed', JSON.stringify(viaOwner));

  const revision = readAggregate(fx).revisions.plan;
  const viaAgent = await fx.service.execute(
    AGENT(fx.instanceId),
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '由工具修改' } }, { expectedPlanRevision: revision }),
  );
  assert.equal(viaAgent.status, 'committed', JSON.stringify(viaAgent));

  // 同一个过期基线，两条入口都必须拒绝，且拒绝码一致。
  const staleOwner = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'x' } }, { expectedPlanRevision: 0 }),
  );
  const staleAgent = await fx.service.execute(
    AGENT(fx.instanceId),
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'x' } }, { expectedPlanRevision: 0 }),
  );
  assert.equal(rejected(staleOwner).code, 'plan-conflict');
  assert.equal(rejected(staleAgent).code, 'plan-conflict');

  // 伪造/缺失的可信上下文不获得任何写资格。
  const noContext = await fx.service.execute(undefined, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'y' } }, { expectedPlanRevision: revision }));
  assert.equal(rejected(noContext).code, 'forbidden');
  const forged = await fx.service.execute(
    { kind: 'agent-work', workRunId: '', bindingVersion: 1, instanceId: fx.instanceId },
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'z' } }, { expectedPlanRevision: revision }),
  );
  assert.equal(rejected(forged).code, 'forbidden');
  const wrongInstance = await fx.service.execute(
    { kind: 'agent-work', workRunId: 'run', bindingVersion: 1, instanceId: randomUUID() },
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'w' } }, { expectedPlanRevision: revision }),
  );
  assert.equal(rejected(wrongInstance).code, 'forbidden');
});

test('过程记录只推进状态修订，规划基线仍可用', async () => {
  const fx = await setup('cmd-record-');
  const planVersionBefore = fx.planVersion();

  const recorded = await fx.service.execute(
    OWNER,
    fx.envelope({
      type: 'append-record',
      kind: 'analysis-note',
      subjectNodeIds: [ROOT_NODE],
      summary: '分析结论',
      sources: [],
      body: '# 分析\n\n过程记录正文\n',
    }),
  );
  assert.equal(recorded.status, 'committed', JSON.stringify(recorded));
  if (recorded.status !== 'committed') return;
  assert.equal(recorded.impact, 'state');
  assert.equal(recorded.planRevision, 0, '记录不推进规划修订');
  assert.equal(recorded.stateRevision, 1);
  assert.equal(recorded.planVersion, planVersionBefore, '记录不改变规划指纹');
  assert.ok(recorded.recordPath !== undefined);

  // 正文写入且哈希匹配；索引已包含该记录。
  const bodyPath = path.join(fx.source, ...(recorded.recordPath ?? '').split('/'));
  const body = readFileSync(bodyPath);
  assert.equal('sha256:' + sha256(new Uint8Array(body)), (JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as { records: { contentHash: string }[] }).records[0]?.contentHash);

  // 记录之后仍可用原规划基线提交规划修改。
  const planned = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { title: '改名' } }),
  );
  assert.equal(planned.status, 'committed', JSON.stringify(planned));
  if (planned.status !== 'committed') return;
  assert.equal(planned.planRevision, 1);
  assert.equal(planned.stateRevision, 2);

  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as { records: unknown[] };
  assert.equal(doc.records.length, 1, '提交规划时不得丢失已追加的记录');
});

test('真实规划冲突：过期 planVersion 或修订都拒绝，文件不动', async () => {
  const fx = await setup('cmd-conflict-');
  const before = readFileSync(path.join(fx.source, 'project.json'));

  const staleVersion = await fx.service.execute(
    OWNER,
    fx.envelope(
      { type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '旧基线' } },
      { expectedPlanVersion: 'sha256:' + '0'.repeat(64) },
    ),
  );
  const staleVersionResult = rejected(staleVersion);
  assert.equal(staleVersionResult.code, 'plan-conflict');
  assert.equal(staleVersionResult.current?.planVersion, fx.planVersion());

  const staleRevision = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '旧修订' } }, { expectedPlanRevision: 7 }),
  );
  assert.equal(rejected(staleRevision).code, 'plan-conflict');

  assert.deepEqual(readFileSync(path.join(fx.source, 'project.json')), before);
});

test('完成命令条件：done 需要完成条件与验证记录', async () => {
  const fx = await setup('cmd-done-');

  const doneWithoutCriteria = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'set-node-status', nodeId: CHILD_NODE, status: 'done' }),
  );
  assert.equal(rejected(doneWithoutCriteria).code, 'invalid-project');
  assert.ok(
    (rejected(doneWithoutCriteria).issues ?? []).some((issue) => issue.code === 'completion-no-verification' || issue.code === 'completion-criteria-empty'),
    JSON.stringify(rejected(doneWithoutCriteria).issues),
  );

  const withCriteria = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: CHILD_NODE, patch: { completionCriteria: ['测试通过'] } }),
  );
  assert.equal(withCriteria.status, 'committed', JSON.stringify(withCriteria));

  const stillNoVerification = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'set-node-status', nodeId: CHILD_NODE, status: 'done' }, { expectedPlanRevision: 1 }),
  );
  assert.equal(rejected(stillNoVerification).code, 'invalid-project');

  const verified = await fx.service.execute(
    OWNER,
    fx.envelope(
      {
        type: 'append-record',
        kind: 'verification',
        subjectNodeIds: [CHILD_NODE],
        summary: '本机复测通过',
        sources: [],
        body: '# 验证\n\n复测通过\n',
        verification: { status: 'pass', subject: { kind: 'node', id: CHILD_NODE } },
      },
      { expectedPlanRevision: 1 },
    ),
  );
  assert.equal(verified.status, 'committed', JSON.stringify(verified));

  const done = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'set-node-status', nodeId: CHILD_NODE, status: 'done' }, { expectedPlanRevision: 1 }),
  );
  assert.equal(done.status, 'committed', JSON.stringify(done));
});

test('源代际与实例身份：过期 epoch 拒绝，伪造项目 id 拒绝', async () => {
  const fx = await setup('cmd-epoch-');
  const stale = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'x' } }, { sourceEpoch: 9 }),
  );
  assert.equal(rejected(stale).code, 'source-changed');

  const wrongProject = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'x' } }, { projectId: '00000000-0000-4000-8000-0000000000ff' }),
  );
  assert.equal(rejected(wrongProject).code, 'forbidden');

  const unknownInstance = await fx.service.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'x' } }, { instanceId: randomUUID() }),
  );
  assert.equal(rejected(unknownInstance).code, 'binding-expired');
});

test('每实例队列：并发命令串行执行，只有首个基线成立，磁盘不被写坏', async () => {
  const fx = await setup('cmd-queue-');
  const commands = Array.from({ length: 5 }, (_, index) =>
    fx.service.execute(
      OWNER,
      fx.envelope({
        type: 'add-nodes',
        nodes: [{ parentId: ROOT_NODE, order: index + 1, title: `并发 ${index}`, goal: 'g', completionCriteria: [] }],
      }),
    ),
  );
  const results = await Promise.all(commands);
  const committed = results.filter((result) => result.status === 'committed');
  const conflicts = results.filter((result) => result.status === 'rejected' && result.code === 'plan-conflict');
  assert.equal(committed.length, 1, JSON.stringify(results));
  assert.equal(conflicts.length, 4, JSON.stringify(results));

  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as { plan: { nodes: unknown[] } };
  assert.equal(doc.plan.nodes.length, 3, '只写入一条命令的结果，没有交错损坏');
});

test('发布失败结局：正文未写成不发布头；头结果未知返回待核对', async () => {
  const base = mkdtempSync(path.join(artifacts, 'cmd-publish-'));
  const fx = await setupRelative(base);

  const bodyFailure = new ProjectCommandService({
    ...fx.serviceDeps,
    hooks: {
      body: {
        beforeTempWrite: () => {
          throw new Error('injected-body-failure');
        },
      },
    },
  });
  const bodyResult = await bodyFailure.execute(
    OWNER,
    fx.envelope({
      type: 'append-record',
      kind: 'analysis-note',
      subjectNodeIds: [ROOT_NODE],
      summary: '不应发布',
      sources: [],
      body: '# 失败\n',
    }),
  );
  assert.equal(rejected(bodyResult).code, 'persistence-failed');
  const docAfterBodyFailure = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as { records: unknown[] };
  assert.equal(docAfterBodyFailure.records.length, 0, '正文失败时不得发布资料头');

  const headUnknown = new ProjectCommandService({
    ...fx.serviceDeps,
    hooks: {
      publish: {
        afterRename: () => {
          throw new Error('injected-head-unknown');
        },
      },
    },
  });
  const headResult = await headUnknown.execute(
    OWNER,
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '未知结果' } }),
  );
  assert.equal(headResult.status, 'pending-reconciliation', JSON.stringify(headResult));
  if (headResult.status === 'pending-reconciliation') {
    assert.equal(headResult.stage, 'head');
    assert.equal(headResult.operationId.length > 0, true);
  }
});

/** 在同一临时目录里再建一套服务，便于注入故障钩子。 */
interface RelativeFixture extends Fixture {
  serviceDeps: ConstructorParameters<typeof ProjectCommandService>[0];
}

async function setupRelative(base: string): Promise<RelativeFixture> {
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
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
  const serviceDeps: ConstructorParameters<typeof ProjectCommandService>[0] = {
    localRoot,
    store,
    files,
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
  };
  const service = new ProjectCommandService(serviceDeps);
  const planVersion = (): string =>
    (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId: registered.entry.instanceId,
    sourceEpoch: registered.entry.sourceGeneration,
    expectedPlanVersion: planVersion(),
    expectedPlanRevision: 0,
    command,
    ...overrides,
  });
  return { base, localRoot, source, instanceId: registered.entry.instanceId, service, store, planVersion, envelope, serviceDeps };
}
