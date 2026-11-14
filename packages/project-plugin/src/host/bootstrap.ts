// Host 启动期资料源配置与实例打开（tasks 5.2，design §5）。
//
// 边界：本文件只把“用户在 profile 里明确配置的绝对路径”落实成一个可读实例；
// 不猜目录、不扫描磁盘找项目、不写公开资料头。位置仍是用户显式选择的结果，
// 面板只展示，不做位置迁移。

import path from 'node:path';
import { readSourceBaseline } from '../application/baseline.js';
import { LocalStateService, type RegistryEntry } from '../application/local-state.js';
import type { GitPrivateRootPort, LocalRootResolverPort, LocalStateStorePort, SourceFilesPort } from '../application/ports.js';
import type { Sha256Fn } from '../domain/types.js';

/** Host 插件配置（cordis `Config`）：全部为可选绝对路径，缺省即“未配置”。 */
export interface HostConfigInput {
  /** 公开资料根（含 project.json 的目录）。 */
  projectRoot?: string;
  /** 本机运行数据根；缺省 `<宿主 home>/data/dsh-cona/local`，由调用方解析后传入。 */
  localDataRoot?: string;
  /** 已登记实例；配置了但仍需与 projectRoot 一致。 */
  instanceId?: string;
}

export interface HostConfig {
  projectRoot?: string;
  localDataRoot?: string;
  instanceId?: string;
}

export interface ConfigIssue {
  code: string;
  message: string;
}

export type ConfigResult = { ok: true; config: HostConfig } | { ok: false; issues: ConfigIssue[] };

/** 校验配置形态：只接受绝对路径；空字符串视同未配置。不做存在性判断（打开时再查）。 */
export function resolveHostConfig(input: HostConfigInput): ConfigResult {
  const issues: ConfigIssue[] = [];
  const out: HostConfig = {};

  for (const key of ['projectRoot', 'localDataRoot'] as const) {
    const value = input[key];
    if (value === undefined || value.trim() === '') continue;
    if (!path.isAbsolute(value)) {
      issues.push({ code: 'cona-config-not-absolute', message: `${key} 必须是绝对路径：${value}` });
      continue;
    }
    out[key] = path.normalize(value);
  }
  if (input.instanceId !== undefined && input.instanceId.trim() !== '') {
    out.instanceId = input.instanceId.trim();
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config: out };
}

export interface BootstrapDeps {
  files: SourceFilesPort;
  localState: LocalStateService;
  store: LocalStateStorePort;
  sha256: Sha256Fn;
  clock: () => string;
  /** 配置了 projectRoot 但未给 localDataRoot 时由宿主解析默认本机根。 */
  defaultLocalRoot: () => Promise<string | undefined>;
  /** 资料根显示路径（home 折叠）。 */
  describeLocation: (root: string) => { displayPath: string };
}

export interface OpenedInstance {
  instanceId: string;
  projectId: string;
  sourceRoot: string;
  sourceKind: RegistryEntry['sourceKind'];
  sourceDisplay: string;
  sourceEpoch: number;
  localRoot: string;
  /** true 表示本次启动新建了登记；false 为复用既有实例。 */
  created: boolean;
  /** 本次启动建立的完整基线（刷新成功时非空）。 */
  baselineEstablished: boolean;
}

export type BootstrapResult =
  | { status: 'opened'; instance: OpenedInstance }
  | { status: 'not-configured'; message: string }
  | { status: 'failed'; code: string; message: string; issues?: { code: string; message: string }[] };

/**
 * 打开配置的资料源：校验公开资料 → 登记或复用实例 → 刷新完整基线。
 * 任一步失败都返回稳定码，不建立半可用实例，也不改动资料头。
 */
export async function openConfiguredInstance(
  config: HostConfig,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  if (config.projectRoot === undefined || config.projectRoot.trim() === '') {
    return {
      status: 'not-configured',
      message: '未配置 projectRoot；在 profile 的插件配置里给出公开资料根绝对路径后重启宿主',
    };
  }
  const sourceRoot = config.projectRoot;
  const localRoot = config.localDataRoot ?? (await deps.defaultLocalRoot());
  if (localRoot === undefined) {
    return { status: 'failed', code: 'cona-local-root-missing', message: '无法确定本机运行数据根；请配置 localDataRoot' };
  }

  const baseline = await readSourceBaseline(deps.files, sourceRoot, deps.sha256, deps.clock);
  if (!baseline.ok) {
    return {
      status: 'failed',
      code: 'invalid-project',
      message: '配置的资料根不可读或不合法；未登记实例',
      issues: baseline.issues.map((issue) => ({ code: issue.code, message: issue.message })),
    };
  }

  const registered = await deps.localState.register({
    localDataRoot: localRoot,
    sourceRoot,
    sourceKind: 'custom',
    projectId: baseline.baseline.projectId,
  });
  if (!registered.ok) {
    return {
      status: 'failed',
      code: registered.issues[0]?.code ?? 'cona-register-failed',
      message: registered.issues.map((issue) => issue.message).join('；'),
      issues: registered.issues.map((issue) => ({ code: issue.code, message: issue.message })),
    };
  }
  if (config.instanceId !== undefined && registered.entry.instanceId !== config.instanceId) {
    return {
      status: 'failed',
      code: 'cona-instance-mismatch',
      message: `配置的实例 ${config.instanceId} 与资料根对应实例 ${registered.entry.instanceId} 不一致；未覆盖任何数据`,
    };
  }

  // 登记不写半截基线（3.2）；启动期只在缺少基线或磁盘已变化时显式刷新，
  // 避免每次启动都推进源代际（代际变化是订阅侧的替换边界）。
  const aggregate = await deps.store.readAggregate(localRoot, registered.entry.instanceId);
  const observation = aggregate?.lastObservation ?? null;
  const upToDate =
    observation !== null &&
    observation.headHash === baseline.baseline.headHash &&
    observation.planVersion === baseline.baseline.planVersion;
  let entry = registered.entry;
  let baselineEstablished = observation !== null;
  if (!upToDate) {
    const refreshed = await deps.localState.refresh({
      localDataRoot: localRoot,
      instanceId: registered.entry.instanceId,
      baseline: baseline.baseline,
    });
    if (!refreshed.ok) {
      return {
        status: 'failed',
        code: refreshed.issues[0]?.code ?? 'cona-refresh-failed',
        message: refreshed.issues.map((issue) => issue.message).join('；'),
        issues: refreshed.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      };
    }
    entry = refreshed.entry;
    baselineEstablished = true;
  }

  return {
    status: 'opened',
    instance: {
      instanceId: entry.instanceId,
      projectId: entry.projectId,
      sourceRoot,
      sourceKind: entry.sourceKind,
      sourceDisplay: deps.describeLocation(sourceRoot).displayPath,
      sourceEpoch: entry.sourceGeneration,
      localRoot,
      created: !registered.reused,
      baselineEstablished,
    },
  };
}

/** 依赖装配的输入：调用方提供具体适配器；本文件不直接 import Node 文件实现。 */
export interface HostWiring {
  files: SourceFilesPort;
  store: LocalStateStorePort;
  resolver: LocalRootResolverPort;
  git: GitPrivateRootPort;
  sha256: Sha256Fn;
  clock: () => string;
  newInstanceId: () => string;
  defaultLocalRoot: () => Promise<string | undefined>;
  describeLocation: (root: string) => { displayPath: string };
}

/** 用给定装配构造 LocalStateService（宿主与测试共用同一装配形状）。 */
export function createLocalStateService(wiring: HostWiring, notify?: ConstructorParameters<typeof LocalStateService>[0]['notify']): LocalStateService {
  return new LocalStateService({
    resolver: wiring.resolver,
    git: wiring.git,
    store: wiring.store,
    clock: wiring.clock,
    newInstanceId: wiring.newInstanceId,
    ...(notify === undefined ? {} : { notify }),
  });
}
