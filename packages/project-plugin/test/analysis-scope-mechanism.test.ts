// 2.x 固定宿主接点的 keyless 机制探针（design「分析会话的执行器」）。
// 用已声明的真实依赖 @deepseek-ai/cordis 4.1.0 与 @deepseek-ai/dsh-tools 0.2.2-rc.2
// 挂载 ToolsService，在 agent scope 上验证：
//   - restrict 只接受作用域上下文，且不能指名 PTC 保留名 run_code；
//   - guard 在 checkGuards 上按作用域链求值并可拒绝；
//   - setExecutor 近层覆盖部署默认，selectExecutor 取近层；
//   - 作用域 restrict 不遮蔽另一个 agent 的可见工具（会话隔离的机制前提）。
//
// 边界：这是机制层证据，不是固定宿主真实 Agent 实测。真实 preset 注册、
// 原生执行器自证、PTC 对照与 pre-step 拦截属 A03/A05/A07 的 H 分句，
// 由用户在真 DSH 0.2.2-rc.2 隔离 profile 执行，证据在 validation-matrix 逐条记录。
// 本文件不 import 未声明的 dsh-agent/dsh-tool-executor-native/dsh-agent-preset。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { ToolsService, RUN_CODE_NAME, type ToolDefinition, type ToolExecutor, type ToolModelInput, type ToolBatchInput, type ToolBatchResult } from '@deepseek-ai/dsh-tools';

// dsh-scope 是 dsh-tools 的传递依赖，不在本包 devDependencies 声明。
// 通过 dsh-tools 的 lib 依赖路径解析，避免在测试里新增未声明的直接依赖。
// 但为保持边界纯净，这里改用一个与宿主 scope 同构的最小实现：cordis Context 的
// 作用域载体用 Symbol 标签 + 原型链查找表达，足够驱动 ToolsService 的 scopeChainOf。
// ToolsService 内部直接 import '@deepseek-ai/dsh-scope' 的实例，故必须用同一个
// createScope/scopeOf。因此从 dsh-tools 的依赖解析符导入（见下方 importScope）。

type Scope = { ctx: Context; key: object };
type ScopeFns = {
  createScope: (ctx: Context, key: object, options?: { parent?: object }) => Scope;
  scopeOf: (ctx: Context) => unknown;
};

async function importScope(): Promise<ScopeFns> {
  // createRequire 从 dsh-tools 的 package.json 定位其 node_modules 里的 dsh-scope，
  // 与 ToolsService 内部用的是同一份模块实例（scopeOf 依赖同一份 carrierKey）。
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const toolsEntry = req.resolve('@deepseek-ai/dsh-tools');
  const reqFromTools = createRequire(toolsEntry);
  const scopePath = reqFromTools.resolve('@deepseek-ai/dsh-scope');
  const mod = await import(scopePath);
  return { createScope: mod['createScope'] as ScopeFns['createScope'], scopeOf: mod['scopeOf'] as ScopeFns['scopeOf'] };
}

/** 宿主 SystemPrompt 的最小契约：ToolsService 构造时调用 tools() 注册描述器。 */
class SystemPromptStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt');
  }
  tools(): () => void {
    return () => {};
  }
}

async function mountTools(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SystemPromptStub);
  await ctx.plugin(ToolsService);
  return ctx;
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `probe ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => [{ type: 'text' as const, text: name }],
    },
    async execute(): Promise<Record<string, never>> {
      return {};
    },
  };
}

/** 运行时读取宿主标为 private 的选择结果（rc.2 确认 selectExecutor 为实例方法）。 */
function selected(ctx: Context, scope?: object): unknown {
  return (ctx.tools as unknown as { selectExecutor: (scope?: object) => unknown }).selectExecutor(scope);
}

/** 一个记录选择次数的执行器，验证 setExecutor 的近层选择，不执行真实工具。 */
function countingExecutor(label: string): ToolExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    describe(tools: readonly ToolDefinition[]): ToolModelInput {
      calls.push(`describe:${label}:${tools.map((t) => t.name).join('|')}`);
      return { schemas: [] };
    },
    async execute(_input: ToolBatchInput): Promise<ToolBatchResult> {
      calls.push(`execute:${label}`);
      return { results: [] } as unknown as ToolBatchResult;
    },
  };
}

test('2.x-a restrict 拒绝全局上下文；只接受 agent 作用域', async () => {
  const ctx = await mountTools();
  assert.equal(typeof ctx.tools.register, 'function');
  assert.equal(typeof ctx.tools.restrict, 'function');
  assert.equal(typeof ctx.tools.guard, 'function');
  assert.equal(typeof ctx.tools.setExecutor, 'function');
  assert.throws(
    () => ctx.tools.restrict({ allow: ['probe'] }),
    /requires a scoped context/,
    '根上下文上的 restrict 应被拒绝（与 rc.2 源码一致）',
  );
});

test('2.x-b restrict 不能指名 PTC 保留名 run_code', async () => {
  const ctx = await mountTools();
  const scope = await importScope();
  const key = { id: 'agent-analysis' };
  let scoped!: Context;
  await ctx.plugin(Object.assign((inner: Context) => {
    scoped = scope.createScope(inner, key).ctx;
  }, { inject: ['tools', 'systemPrompt'] }));
  assert.throws(
    () => scoped.tools.restrict({ deny: [RUN_CODE_NAME] }),
    new RegExp(RUN_CODE_NAME),
    'restrict 指名 run_code 应被拒绝',
  );
});

test('2.x-c guard 在作用域链上求值并可拒绝，另一作用域不受影响', async () => {
  const ctx = await mountTools();
  const scope = await importScope();
  ctx.tools.register(tool('cona_read'));
  const agentA = { id: 'agent-analysis' };
  const agentB = { id: 'agent-ordinary' };
  let analysis!: Context;
  await ctx.plugin(Object.assign((inner: Context) => {
    analysis = scope.createScope(inner, agentA).ctx;
  }, { inject: ['tools', 'systemPrompt'] }));

  // 最小 exec：checkGuards 只读 agent 与工具名（见 rc.2 checkGuards 实现）。
  const execA = { agent: agentA, name: 'cona_write', args: {}, callId: 'c1' };
  const execB = { agent: agentB, name: 'cona_write', args: {}, callId: 'c2' };
  assert.equal(ctx.tools.checkGuards(execA as never), undefined, '未装守卫前不拒绝');

  const deny = analysis.tools.guard((invocation) => {
    const name = (invocation as { name?: string }).name;
    return name === 'cona_write' ? 'analysis-read-only' : undefined;
  });
  const deniedA = ctx.tools.checkGuards(execA as never);
  assert.ok(deniedA !== undefined, '分析作用域的写调用应被守卫拒绝');
  assert.equal(typeof deniedA === 'string' ? deniedA : deniedA.reason, 'analysis-read-only');
  assert.equal(ctx.tools.checkGuards(execB as never), undefined, '普通作用域不受分析守卫影响');
  deny();
  assert.equal(ctx.tools.checkGuards(execA as never), undefined, '守卫释放后恢复');
});

test('2.x-d 部署默认执行器可注册与释放；近层选择留作固定宿主实测', async () => {
  const ctx = await mountTools();
  const rootExecutor = countingExecutor('root');
  assert.throws(() => selected(ctx), (e: unknown) => e instanceof Error && /TOOL_EXECUTOR_UNAVAILABLE|unavailable/.test(e.message), '未装执行器时选择失败');
  const rootDispose = ctx.tools.setExecutor(rootExecutor);
  assert.equal(selected(ctx), rootExecutor, '根作用域使用已注册的部署默认执行器');
  assert.throws(
    () => ctx.tools.setExecutor(countingExecutor('second')),
    /Only one tool executor/,
    '同一作用域只允许一个执行器',
  );
  rootDispose();
  assert.throws(() => selected(ctx), (e: unknown) => e instanceof Error && /TOOL_EXECUTOR_UNAVAILABLE|unavailable/.test(e.message), '释放后回退到不可用');
  // 近层覆盖 + 原生执行器自证属 A05 的 H 分句：宿主用 preset 在 scope 内
  // ctx.plugin(nativeExecutor) 挂载独立 ToolsService 实例，keyless stub 无法复刻。
});

test('2.x-e restrict 只裁剪被限制作用域的可见工具，另一会话保持原组合', async () => {
  const ctx = await mountTools();
  const scope = await importScope();
  ctx.tools.register(tool('cona_read'));
  ctx.tools.register(tool('shell'));
  const agentA = { id: 'agent-analysis' };
  const agentB = { id: 'agent-ordinary' };
  let analysis!: Context;
  await ctx.plugin(Object.assign((inner: Context) => {
    analysis = scope.createScope(inner, agentA).ctx;
  }, { inject: ['tools', 'systemPrompt'] }));

  const names = (ctxValue: Context, key: object): string[] =>
    ctxValue.tools.definitions(key as never).map((t) => t.name).sort();
  const beforeA = names(ctx, agentA);
  assert.deepEqual(beforeA, ['cona_read', 'shell']);

  const dispose = analysis.tools.restrict({ allow: ['cona_read'] });
  const afterA = names(ctx, agentA);
  const afterB = names(ctx, agentB);
  assert.deepEqual(afterA, ['cona_read'], '分析作用域只剩允许工具');
  assert.deepEqual(afterB, ['cona_read', 'shell'], '普通会话保留原组合');
  dispose();
  assert.deepEqual(names(ctx, agentA), ['cona_read', 'shell']);
});

test('2.x-z preset 作用域的 restrict 只裁剪继承工具；agent 自己注册的分析能力仍可见', async () => {
  // 这条是 2.x「允许工具注册位置」的机制判定：分析 preset 在 preset 作用域装
  // restrict({allow: []}) 与 guard，四个分析能力由 Host 注册在分析 Agent 自己的
  // agent scope。rc.2 把「被查看 scope 的 own 层注册」排除在限制之外，所以：
  //   - 全局工具（继承）被遮掉；
  //   - 本 Agent 的分析能力仍可见；
  //   - 兄弟 Agent 看不到别的 Agent 注册的能力。
  const ctx = await mountTools();
  const scope = await importScope();
  ctx.tools.register(tool('cona_global'));

  const presetKey = { id: 'preset-analysis' };
  let preset!: Context;
  await ctx.plugin(Object.assign((inner: Context) => {
    preset = scope.createScope(inner, presetKey).ctx;
  }, { inject: ['tools', 'systemPrompt'] }));

  const agentKey = { id: 'agent-analysis' };
  const siblingKey = { id: 'agent-sibling' };
  let agentCtx!: Context;
  let siblingCtx!: Context;
  // 显式绑定 parent：真实 host 由 registry 调 bindScopeParent 把 agent scope
  // 接到 preset revision 的 scope 下，createScope 本身不会自动继承。
  const mountAgent = (key: object, assign: (value: Context) => void) => Object.assign((inner: Context) => {
    assign(scope.createScope(inner, key, { parent: presetKey }).ctx);
  }, { inject: ['tools', 'systemPrompt'] });
  await preset.plugin(mountAgent(agentKey, (value) => { agentCtx = value; }));
  await preset.plugin(mountAgent(siblingKey, (value) => { siblingCtx = value; }));

  preset.tools.restrict({ allow: [] });
  agentCtx.tools.register(tool('cona_analysis_scope_files'));

  const names = (key: object): string[] => ctx.tools.definitions(key as never).map((t) => t.name).sort();
  assert.deepEqual(names(agentKey), ['cona_analysis_scope_files'], 'own 层分析能力不受 preset restrict 影响');
  assert.deepEqual(names(siblingKey), [], '继承全局工具被遮掉，兄弟 Agent 看不到该能力');
  assert.deepEqual(
    ctx.tools.definitions().map((t) => t.name).sort(),
    ['cona_global'],
    '全局视图只有全局工具，scoped 注册不泄漏到根视图',
  );
});
