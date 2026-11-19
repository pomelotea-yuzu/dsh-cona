// R2 任务 2.1：按实例共享运行时（design §2「按实例装配」）。
//
// 边界：本模块只管理「instanceId → Promise<RuntimeResult>」的懒装配表，
// 以及注册表条目的可读性诊断。它不 import cordis、不读 invocation、不发明实例；
// 实例从本机注册表来，打开路径由调用方注入（复用 R1 的 openConfiguredInstance）。
// 这样每实例的应用服务（快照／命令／聊天／工作／队列）彼此隔离，
// 而 R1 配置实例的工具与宿主事件仍绑定它自己，不受浏览其他实例影响。

import type { RegistryEntry } from '../application/local-state.js';
import type { ConaProjectRuntime, RuntimeResult } from './project-service.js';

/** 概览列表中的单个实例行：可读或不可读诊断，二者互斥。 */
export type OverviewInstanceRow =
  | {
      instanceId: string;
      projectId: string;
      readable: true;
      sourceKind: string;
      /** 资料根显示路径（home 折叠），不暴露机器绝对路径。 */
      sourceDisplay: string;
      sourceEpoch: number;
    }
  | {
      instanceId: string;
      projectId: string;
      readable: false;
      code: string;
      message: string;
    };

export interface OpenInstanceInput {
  instanceId: string;
  projectId: string;
  sourceRoot: string;
  sourceEpoch: number;
}

/** 打开一个已登记实例的回调；复用 R1 的 bootstrap 装配。 */
export type OpenInstance = (input: OpenInstanceInput) => Promise<RuntimeResult>;

export interface InstanceRuntimeRegistryDeps {
  /** 列出本机注册表条目（已登记实例）。 */
  listEntries: () => Promise<RegistryEntry[]>;
  /** 按条目打开运行时；调用方保证资料根/实例身份由宿主核对。 */
  open: OpenInstance;
  /** 资料根显示路径（home 折叠）。 */
  describeLocation: (root: string) => string;
  /**
   * 配置实例（R1）已打开的 runtime getter；注册后由本表共享，
   * 使配置实例在概览与既有 conaProject Remote 之间是同一个运行时。
   */
  configured?: {
    instanceId: string;
    runtime: () => Promise<RuntimeResult>;
  };
}

/**
 * 按实例共享的运行时表。同一 instanceId 的并发请求共用同一个 promise；
 * 打开失败的结果也被记忆（与 R1 单 runtime 一致），刷新由显式 release 触发。
 */
export class InstanceRuntimeRegistry {
  private readonly runtimes = new Map<string, Promise<RuntimeResult>>();

  constructor(private readonly deps: InstanceRuntimeRegistryDeps) {
    const configured = deps.configured;
    if (configured !== undefined) {
      this.runtimes.set(configured.instanceId, configured.runtime());
    }
  }

  /** 取（或懒装配）指定实例的运行时；未登记实例由调用方先做准入，不在本层放行。 */
  runtime(instanceId: string): Promise<RuntimeResult> | undefined {
    return this.runtimes.get(instanceId);
  }

  /** 显式登记/覆盖一个实例的运行时（配置实例注入点）。 */
  register(instanceId: string, runtime: Promise<RuntimeResult>): void {
    if (!this.runtimes.has(instanceId)) this.runtimes.set(instanceId, runtime);
  }

  /** 按注册表条目懒打开：入口检查是否存在，再从 entry 派生打开输入。 */
  openEntry(entry: RegistryEntry): Promise<RuntimeResult> {
    const existing = this.runtimes.get(entry.instanceId);
    if (existing !== undefined) return existing;
    const opened = this.deps.open({
      instanceId: entry.instanceId,
      projectId: entry.projectId,
      sourceRoot: entry.sourceRoot,
      sourceEpoch: entry.sourceGeneration,
    });
    this.runtimes.set(entry.instanceId, opened);
    return opened;
  }

  /** 释放某实例的运行时（闲置回收/刷新）；配置实例的任何释放请求都被忽略。 */
  release(instanceId: string): boolean {
    if (this.deps.configured?.instanceId === instanceId) return false;
    return this.runtimes.delete(instanceId);
  }

  /**
   * 概览列表：本机已登记实例逐条标注可读/不可读。
   * 打开失败（资料不可读/身份不符）不隐藏条目，保留禁用行和诊断。
   */
  async overviewRows(): Promise<OverviewInstanceRow[]> {
    const entries = await this.deps.listEntries();
    const rows: OverviewInstanceRow[] = [];
    for (const entry of entries) {
      const result = await this.openEntry(entry);
      if (!result.ok) {
        rows.push({
          instanceId: entry.instanceId,
          projectId: entry.projectId,
          readable: false,
          code: result.code,
          message: result.message,
        });
        continue;
      }
      rows.push({
        instanceId: entry.instanceId,
        projectId: entry.projectId,
        readable: true,
        sourceKind: result.value.instance.sourceKind,
        sourceDisplay: this.deps.describeLocation(result.value.instance.sourceRoot),
        sourceEpoch: result.value.instance.sourceEpoch,
      });
    }
    return rows;
  }

  /** 按已登记实例 id 懒打开；未登记返回 undefined。定向读的按需装配入口。 */
  async openKnown(instanceId: string): Promise<RuntimeResult | undefined> {
    const existing = this.runtimes.get(instanceId);
    if (existing !== undefined) return existing;
    const entries = await this.deps.listEntries();
    const entry = entries.find((candidate) => candidate.instanceId === instanceId);
    return entry === undefined ? undefined : this.openEntry(entry);
  }

  /** 已登记实例 id 集合（供定向访问的准入判断）。 */
  async knownInstanceIds(): Promise<Set<string>> {
    const entries = await this.deps.listEntries();
    return new Set(entries.map((entry) => entry.instanceId));
  }
}

/** 仅用于类型收窄：判断 runtime 结果是否可用。 */
export function runtimeValue(result: RuntimeResult): ConaProjectRuntime | undefined {
  return result.ok ? result.value : undefined;
}
