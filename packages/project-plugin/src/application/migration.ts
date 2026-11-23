// 事务化迁移与启动定位（tasks 1.4–1.5，design §1「迁移、排他与恢复」）。
// 同一实例在项目目录／DSH 数据目录／自定义目录之间迁移：冻结清单 → 目标侧候选
// 复制与逐字节核对 → 防覆盖装入 → target-ready → 单次登记替换完成「唯一切换点」
// → 聚合同步 → 回执 committed。中断可恢复：switched 只补聚合与回执；未切换可
// 继续（幂等重复制）或取消（只清理有所有权证据且内容核对过的候选／装入目标）。
// 边界：本文件只编排语义；路径拼接（candidatePathFor）、文件操作与锁由注入依赖落实。

import type { BaselineResult, SourceBaseline } from './baseline.js';
import type { LocalIssue, LocalRootResolverPort, LocalStateStorePort } from './ports.js';
import {
  isMigrationOpen,
  migrationsOf,
  planLocalRoot,
  type InstanceAggregate,
  type LocalRootRequest,
  type LocalRootView,
  type MigrationManifest,
  type MigrationManifestFile,
  type MigrationRecord,
  type MigrationReceipt,
  type MigrationStatus,
  type Registry,
  type RegistryEntry,
} from './local-state.js';
import type { LocationKind } from './location.js';
import type { Sha256Fn } from '../domain/types.js';

/** 候选目录内的所有权标记；装入（rename）前删除，不进入公开资料。 */
export const MIGRATION_MARKER_NAME = 'cona-migration.json';
export const MIGRATION_HEAD_PATH = 'project.json';

/** 目标检查结果：只描述磁盘现状。 */
export interface TargetInspection {
  exists: boolean;
  isDirectory: boolean;
  /** 第一层条目；不存在时为空数组。 */
  entries: string[];
}

/** 迁移文件操作端口（adapters/fs/migration-files.ts 实现；测试可注入假实现）。 */
export interface MigrationFilesPort {
  inspect(targetRoot: string): Promise<TargetInspection>;
  ensureDir(dir: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
  /** 删除根内相对路径文件（所有权标记）。 */
  removeFile(root: string, relativePath: string): Promise<void>;
  renameDir(from: string, to: string): Promise<void>;
  /** 范围校验读取根内文件；不存在时 null。 */
  readFile(
    root: string,
    relativePath: string,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string } | null>;
  /** 写入根内相对路径（自动建父目录）；路径来自协议清单，仍拒绝目录穿越。 */
  writeFile(targetRoot: string, relativePath: string, bytes: Uint8Array): Promise<void>;
  /** 递归列出根内全部文件的相对路径（协议路径形态）；根不存在时 null；含 symlink 时抛错。 */
  listFiles(root: string): Promise<string[] | null>;
}

/** 迁移需要的存储端口子集；隔离只在恢复遇不一致时保留接口位。 */
export type MigrationStorePort = Pick<
  LocalStateStorePort,
  'readRegistry' | 'writeRegistry' | 'readAggregate' | 'writeAggregate' | 'replaceAggregateChecked' | 'withLock' | 'quarantine'
>;

export interface MigrationDeps {
  store: MigrationStorePort;
  resolver: LocalRootResolverPort;
  readBaseline: (root: string) => Promise<BaselineResult>;
  files: MigrationFilesPort;
  /** 候选目录命名：目标侧独占建立；实现须保证同目标同操作 id 的名字稳定。 */
  candidatePathFor: (toRoot: string, operationId: string) => string;
  sha256: Sha256Fn;
  clock: () => string;
  newOperationId: () => string;
  newOwnershipToken: () => string;
}

/** 故障注入钩子（仅 1.5 测试使用；生产调用不传）。抛错＝在当前持久状态后中断。 */
export interface MigrationHooks {
  /** prepared 已持久化、尚未复制。 */
  afterPrepared?: () => Promise<void>;
  /** 每写入一个清单文件后调用（参数＝已复制文件数）。 */
  duringCopy?: (copiedCount: number) => Promise<void>;
  /** 候选已装入目标并逐字节核对、target-ready 尚未写入。 */
  afterInstall?: () => Promise<void>;
  /** target-ready 已持久化、定位尚未切换。 */
  afterTargetReady?: () => Promise<void>;
  /** switched 已持久化（唯一切换点已过）、聚合与回执尚未保存。 */
  afterSwitch?: () => Promise<void>;
}

export interface MigrateRequest extends LocalRootRequest {
  instanceId: string;
  /** 目标资料根（绝对路径；调用方负责规范化）。 */
  toRoot: string;
  toKind: LocationKind;
  /** 幂等恢复：同操作号重入时返回当前持久状态，不新开操作。 */
  operationId?: string;
}

export interface RecoverRequest extends LocalRootRequest {
  operationId: string;
  /** 原请求摘要：继续／取消都必须与登记的 requestDigest 一致。 */
  confirmDigest: string;
  instanceId?: string;
}

export interface StartupRequest extends LocalRootRequest {
  /** 启动配置仍指向的资料根。 */
  configuredRoot: string;
}

export type MigrationOutcome =
  | { ok: true; root: LocalRootView; entry: RegistryEntry; record: MigrationRecord; aggregate?: InstanceAggregate }
  | { ok: false; root?: LocalRootView; issues: LocalIssue[]; record?: MigrationRecord };

export type StartupLocationResult =
  | {
      ok: true;
      root: LocalRootView;
      configuredRoot: string;
      effectiveRoot: string;
      instanceId: string;
      migrated: boolean;
    }
  | { ok: false; root?: LocalRootView; issues: LocalIssue[] };

export interface MigrationPreviewResult {
  ok: true;
  root: LocalRootView;
  entry: RegistryEntry;
  from: { root: string; kind: LocationKind; generation: number };
  to: { root: string; kind: LocationKind };
  /** 来源当前格式（planVersion／头哈希／记录数）；读不到时 null，诊断进 checks。 */
  source: { planVersion: string; headHash: string; recordCount: number } | null;
  target: TargetInspection;
  /** 本机引用：迁移确认前需要处理的聊天、工作意图／运行与回执。 */
  references: {
    conversations: number;
    activeWorkIntents: string[];
    activeWorkRuns: string[];
    operations: number;
    repositoryMaps: number;
  };
  /** 冲突／占用诊断；预览不阻塞，确认（migrate）会拒绝。 */
  checks: LocalIssue[];
  openMigration?: { operationId: string; status: MigrationStatus; requestDigest: string; toRoot: string };
}

class MigrationInterrupted extends Error {
  constructor(
    public readonly record: MigrationRecord,
    public readonly issues: LocalIssue[],
  ) {
    super(issues[0]?.message ?? '迁移被中断');
    this.name = 'MigrationInterrupted';
  }
}

function issue(code: string, message: string, path?: string): LocalIssue {
  return path === undefined ? { code, message } : { code, message, path };
}

const utf8 = new TextEncoder();

/** 冻结清单：头 + 全部引用正文（按协议路径排序），清单哈希覆盖全部条目。 */
function manifestFrom(baseline: SourceBaseline, sha256: Sha256Fn): MigrationManifest {
  const files: MigrationManifestFile[] = [
    { path: MIGRATION_HEAD_PATH, hash: baseline.headHash },
    ...baseline.records.map((record) => ({ path: record.path, hash: record.observedHash })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = files.map((file) => `${file.path} ${file.hash}`).join('\n');
  return { headHash: baseline.headHash, files, filesHash: 'sha256:' + sha256(utf8.encode(canonical)) };
}

function migrationDigest(
  input: {
    instanceId: string;
    projectId: string;
    fromRoot: string;
    expectedGeneration: number;
    toRoot: string;
    toKind: string;
  },
  sha256: Sha256Fn,
): string {
  const canonical = JSON.stringify({
    instanceId: input.instanceId,
    projectId: input.projectId,
    from: { root: input.fromRoot, expectedGeneration: input.expectedGeneration },
    to: { root: input.toRoot, kind: input.toKind },
  });
  return 'sha256:' + sha256(utf8.encode(canonical));
}

export class MigrationService {
  private readonly deps: MigrationDeps;

  constructor(deps: MigrationDeps) {
    this.deps = deps;
  }

  /** 迁移预览（只读）：列出原根、目标、格式与本机引用；冲突进 checks 不阻塞预览。 */
  async preview(
    request: LocalRootRequest & { instanceId: string; toRoot: string; toKind: LocationKind },
  ): Promise<MigrationPreviewResult | { ok: false; issues: LocalIssue[] }> {
    try {
      const planned = this.plan(request);
      if (!planned.ok) return planned;
      const registry = await this.deps.store.readRegistry(planned.root.root);
      const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
      if (entry === undefined) {
        return {
          ok: false,
          issues: [issue('registry-instance-not-found', `本机注册表中没有实例 ${request.instanceId}`, planned.root.root)],
        };
      }
      const aggregate = await this.deps.store.readAggregate(planned.root.root, entry.instanceId);
      if (aggregate === null) {
        return {
          ok: false,
          issues: [issue('registry-aggregate-missing', '注册表指向的实例聚合缺失；不自动重建', planned.root.root)],
        };
      }
      const toRoot = request.toRoot;
      const checks: LocalIssue[] = [
        ...this.targetChecks(registry, entry, toRoot),
        ...this.workChecks(aggregate),
      ];

      let source: MigrationPreviewResult['source'] = null;
      const sourceBaseline = await this.deps.readBaseline(entry.sourceRoot);
      if (sourceBaseline.ok) {
        source = {
          planVersion: sourceBaseline.baseline.planVersion,
          headHash: sourceBaseline.baseline.headHash,
          recordCount: sourceBaseline.baseline.records.length,
        };
      } else {
        checks.push(...sourceBaseline.issues.map((item) => issue(item.code, item.message, item.path)));
      }
      const open = migrationsOf(registry).find(
        (item) => item.instanceId === entry.instanceId && isMigrationOpen(item.status),
      );
      return {
        ok: true,
        root: planned.root,
        entry,
        from: { root: entry.sourceRoot, kind: entry.sourceKind, generation: entry.sourceGeneration },
        to: { root: toRoot, kind: request.toKind },
        source,
        target: await this.deps.files.inspect(toRoot),
        references: {
          conversations: aggregate.conversations.links.length,
          activeWorkIntents: aggregate.workIntents
            .filter((item) => item.status === 'pending' || item.status === 'awaiting-message' || item.status === 'active')
            .map((item) => item.workIntentId),
          activeWorkRuns: aggregate.workRuns.filter((item) => item.status === 'active').map((item) => item.workRunId),
          operations: aggregate.operations.length,
          repositoryMaps: aggregate.repositoryMaps?.length ?? 0,
        },
        checks,
        ...(open === undefined
          ? {}
          : {
              openMigration: {
                operationId: open.operationId,
                status: open.status,
                requestDigest: open.requestDigest,
                toRoot: open.to.root,
              },
            }),
      };
    } catch (error) {
      return { ok: false, issues: [issue('migration-preview-failed', (error as Error).message)] };
    }
  }

  /**
   * 事务化迁移：prepared → 复制装入 → target-ready → switched（唯一切换点）→ 聚合 → committed。
   * 全程持有本机根写锁；中断时记录停留在所处状态，恢复走 recover。
   */
  async migrate(request: MigrateRequest, hooks: MigrationHooks = {}): Promise<MigrationOutcome> {
    try {
      const planned = this.plan(request);
      if (!planned.ok) return planned;
      const locked = await this.deps.store.withLock(planned.root.root, async () => {
        try {
          return await this.migrateLocked(planned.root, request, hooks);
        } catch (error) {
          // withLock 会把未知异常包装成 local-state-failed；中断类型必须原样冒泡到锁外。
          if (error instanceof MigrationInterrupted) {
            return { interrupted: true as const, record: error.record, issues: error.issues };
          }
          throw error;
        }
      });
      if (locked.ok === false) return { ok: false, root: planned.root, issues: locked.issues };
      const probed = locked.value as { interrupted?: unknown; record?: MigrationRecord; issues?: LocalIssue[] };
      if (probed.interrupted === true) {
        return { ok: false, root: planned.root, issues: probed.issues ?? [], record: probed.record };
      }
      return locked.value as MigrationOutcome;
    } catch (error) {
      if (error instanceof MigrationInterrupted) {
        return { ok: false, issues: error.issues, record: error.record };
      }
      return { ok: false, issues: [issue('migration-failed', (error as Error).message)] };
    }
  }

  /** 重启恢复：核对登记、候选与目标实际字节后继续、补齐或报告待核对。 */
  async recover(request: RecoverRequest, hooks: MigrationHooks = {}): Promise<MigrationOutcome> {
    try {
      const planned = this.plan(request);
      if (!planned.ok) return planned;
      const locked = await this.deps.store.withLock(planned.root.root, async () => {
        try {
          return await this.recoverLocked(planned.root, request, hooks);
        } catch (error) {
          if (error instanceof MigrationInterrupted) {
            return { interrupted: true as const, record: error.record, issues: error.issues };
          }
          throw error;
        }
      });
      if (locked.ok === false) return { ok: false, root: planned.root, issues: locked.issues };
      const probed = locked.value as { interrupted?: unknown; record?: MigrationRecord; issues?: LocalIssue[] };
      if (probed.interrupted === true) {
        return { ok: false, root: planned.root, issues: probed.issues ?? [], record: probed.record };
      }
      return locked.value as MigrationOutcome;
    } catch (error) {
      if (error instanceof MigrationInterrupted) {
        return { ok: false, issues: error.issues, record: error.record };
      }
      return { ok: false, issues: [issue('migration-failed', (error as Error).message)] };
    }
  }

  /** 取消未切换的迁移：只清理有所有权证据且内容核对过的候选／装入目标。 */
  async cancel(request: RecoverRequest): Promise<MigrationOutcome> {
    try {
      const planned = this.plan(request);
      if (!planned.ok) return planned;
      const locked = await this.deps.store.withLock(planned.root.root, async () =>
        this.cancelLocked(planned.root, request),
      );
      if (locked.ok === false) return { ok: false, root: planned.root, issues: locked.issues };
      return locked.value;
    } catch (error) {
      return { ok: false, issues: [issue('migration-failed', (error as Error).message)] };
    }
  }

  /** 启动定位：配置仍指向旧根时解析到已登记实例的有效定位；歧义要求显式选择。 */
  async resolveStartup(request: StartupRequest): Promise<StartupLocationResult> {
    try {
      const planned = this.plan(request);
      if (!planned.ok) return planned;
      const registry = await this.deps.store.readRegistry(planned.root.root);
      const configured = request.configuredRoot;
      // 先查已确认迁移：旧根已登记为另一独立实例时要求按实例显式选择，不静默解析。
      const migrated = migrationsOf(registry).find(
        (item) => item.status === 'committed' && item.from.root === configured,
      );
      if (migrated !== undefined) {
        const entry = registry.instances.find((item) => item.instanceId === migrated.instanceId);
        if (entry === undefined) {
          return {
            ok: false,
            root: planned.root,
            issues: [
              issue('startup-record-orphan', `迁移记录指向实例 ${migrated.instanceId}，但注册表没有该实例`, configured),
            ],
          };
        }
        const other = registry.instances.find(
          (item) => item.instanceId !== entry.instanceId && item.sourceRoot === configured,
        );
        if (other !== undefined) {
          return {
            ok: false,
            root: planned.root,
            issues: [
              issue(
                'startup-location-ambiguous',
                `旧根已登记为独立实例 ${other.instanceId}；迁移实例 ${entry.instanceId} 现在位于 ${entry.sourceRoot}。按实例显式选择`,
                configured,
              ),
            ],
          };
        }
        return {
          ok: true,
          root: planned.root,
          configuredRoot: configured,
          effectiveRoot: entry.sourceRoot,
          instanceId: entry.instanceId,
          migrated: true,
        };
      }
      const direct = registry.instances.find((entry) => entry.sourceRoot === configured);
      if (direct !== undefined) {
        return {
          ok: true,
          root: planned.root,
          configuredRoot: configured,
          effectiveRoot: direct.sourceRoot,
          instanceId: direct.instanceId,
          migrated: false,
        };
      }
      return {
        ok: false,
        root: planned.root,
        issues: [issue('startup-location-unknown', '配置的资料根没有对应的已登记实例或已确认迁移', configured)],
      };
    } catch (error) {
      return { ok: false, issues: [issue('startup-resolve-failed', (error as Error).message)] };
    }
  }

  /** 迁移记录只读列表（诊断与恢复入口）。 */
  async listMigrations(
    request: LocalRootRequest,
  ): Promise<{ ok: true; root: LocalRootView; migrations: MigrationRecord[] } | { ok: false; issues: LocalIssue[] }> {
    try {
      const planned = this.plan(request);
      if (!planned.ok) return planned;
      const registry = await this.deps.store.readRegistry(planned.root.root);
      return { ok: true, root: planned.root, migrations: migrationsOf(registry) };
    } catch (error) {
      return { ok: false, issues: [issue('migration-list-failed', (error as Error).message)] };
    }
  }

  // ---------- 锁内实现 ----------

  private async migrateLocked(
    root: LocalRootView,
    request: MigrateRequest,
    hooks: MigrationHooks,
  ): Promise<MigrationOutcome> {
    const rootPath = root.root;
    const registry = await this.deps.store.readRegistry(rootPath);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) {
      return { ok: false, issues: [issue('registry-instance-not-found', `本机注册表中没有实例 ${request.instanceId}`, rootPath)] };
    }
    const aggregate = await this.deps.store.readAggregate(rootPath, entry.instanceId);
    if (aggregate === null) {
      return { ok: false, issues: [issue('registry-aggregate-missing', '注册表指向的实例聚合缺失；不自动重建', rootPath)] };
    }

    const open = migrationsOf(registry).find(
      (item) => item.instanceId === entry.instanceId && isMigrationOpen(item.status),
    );
    if (open !== undefined) {
      if (request.operationId === open.operationId) {
        // 幂等恢复：同操作号重入返回当前持久状态，不新开操作。
        return { ok: true, root, entry, record: open };
      }
      return {
        ok: false,
        issues: [
          issue(
            'migration-in-progress',
            `实例已有进行中的迁移 ${open.operationId}（状态 ${open.status}）；先恢复或显式取消，不并行开新迁移`,
            open.to.root,
          ),
        ],
        record: open,
      };
    }

    const toRoot = request.toRoot;
    const checks = [...this.targetChecks(registry, entry, toRoot), ...this.workChecks(aggregate)];
    if (checks.length > 0) return { ok: false, issues: checks };
    // prepared 之前就拒绝不可用目标：非目录或非空（装入前后都防止覆盖既有目标）。
    const targetInfo = await this.deps.files.inspect(toRoot);
    if (targetInfo.exists && !targetInfo.isDirectory) {
      return { ok: false, issues: [issue('migration-target-not-directory', '目标位置存在但不是目录；不覆盖', toRoot)] };
    }
    if (targetInfo.exists && targetInfo.entries.length > 0) {
      return { ok: false, issues: [issue('migration-target-not-empty', '目标目录非空；装入前后都防止覆盖既有目标', toRoot)] };
    }

    // 冻结请求与源清单（prepared 前最后一次读源）。
    const baseline = await this.deps.readBaseline(entry.sourceRoot);
    if (!baseline.ok) return { ok: false, issues: baseline.issues };
    const manifest = manifestFrom(baseline.baseline, this.deps.sha256);

    const now = this.deps.clock();
    const operationId = request.operationId ?? this.deps.newOperationId();
    const record: MigrationRecord = {
      operationId,
      requestDigest: migrationDigest(
        {
          instanceId: entry.instanceId,
          projectId: entry.projectId,
          fromRoot: entry.sourceRoot,
          expectedGeneration: entry.sourceGeneration,
          toRoot,
          toKind: request.toKind,
        },
        this.deps.sha256,
      ),
      instanceId: entry.instanceId,
      projectId: entry.projectId,
      from: { root: entry.sourceRoot, kind: entry.sourceKind, expectedGeneration: entry.sourceGeneration },
      to: { root: toRoot, kind: request.toKind },
      newGeneration: entry.sourceGeneration + 1,
      candidate: {
        path: this.deps.candidatePathFor(toRoot, operationId),
        ownershipToken: this.deps.newOwnershipToken(),
      },
      manifest,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    const preparedRegistry: Registry = {
      schemaVersion: 2,
      instances: registry.instances,
      migrations: [...migrationsOf(registry), record],
    };
    // 首笔迁移在此原子升级 schema 2，完整保留既有登记项。
    await this.deps.store.writeRegistry(rootPath, preparedRegistry);
    await this.runHook(hooks.afterPrepared, record);

    // 复制与装入：target-ready 之前候选与目标都已逐字节核对。
    const copyIssue = await this.copyCandidate(record, hooks);
    if (copyIssue !== null) throw new MigrationInterrupted(record, [copyIssue]);
    const installIssue = await this.installTarget(record);
    if (installIssue !== null) throw new MigrationInterrupted(record, [installIssue]);
    await this.runHook(hooks.afterInstall, record);

    const readyRecord: MigrationRecord = { ...record, status: 'target-ready', updatedAt: this.deps.clock() };
    await this.deps.store.writeRegistry(rootPath, replaceMigration(preparedRegistry, readyRecord));
    await this.runHook(hooks.afterTargetReady, record);

    return this.switchAndCommit(root, preparedRegistry, entry, aggregate, readyRecord, hooks);
  }

  private async recoverLocked(
    root: LocalRootView,
    request: RecoverRequest,
    hooks: MigrationHooks,
  ): Promise<MigrationOutcome> {
    const rootPath = root.root;
    const registry = await this.deps.store.readRegistry(rootPath);
    const record = migrationsOf(registry).find((item) => item.operationId === request.operationId);
    if (record === undefined) {
      return { ok: false, issues: [issue('migration-not-found', `注册表没有迁移操作 ${request.operationId}`, rootPath)] };
    }
    if (request.instanceId !== undefined && record.instanceId !== request.instanceId) {
      return {
        ok: false,
        issues: [issue('migration-instance-mismatch', `迁移 ${record.operationId} 属于实例 ${record.instanceId}`)],
        record,
      };
    }
    if (request.confirmDigest !== record.requestDigest) {
      return {
        ok: false,
        issues: [issue('migration-confirm-mismatch', '确认摘要与登记的原请求摘要不一致；用原操作的 requestDigest 确认')],
        record,
      };
    }
    if (record.status === 'committed' || record.status === 'canceled') {
      // 终态：重复恢复按原登记返回（原回执），不产生新结果。
      return { ok: true, root, entry: requireEntry(registry, record), record };
    }
    const aggregate = await this.deps.store.readAggregate(rootPath, record.instanceId);
    if (aggregate === null) {
      return { ok: false, issues: [issue('registry-aggregate-missing', '注册表指向的实例聚合缺失；不自动重建', rootPath)] };
    }

    if (record.status === 'switched') {
      // 切换后只补齐聚合与原回执；不允许取消。
      return this.switchAndCommit(root, registry, requireEntry(registry, record), aggregate, record, hooks, true);
    }

    // 未切换（prepared／target-ready）：旧根仍有效才继续。
    const baseline = await this.deps.readBaseline(record.from.root);
    if (!baseline.ok) {
      return {
        ok: false,
        issues: [
          issue(
            'migration-source-unreadable',
            `迁移来源 ${record.from.root} 不可读或未通过校验；保留现场，先核对旧根`,
            record.from.root,
          ),
        ],
        record,
      };
    }
    const current = manifestFrom(baseline.baseline, this.deps.sha256);
    if (current.filesHash !== record.manifest.filesHash) {
      return {
        ok: false,
        issues: [
          issue(
            'migration-source-changed',
            '旧根内容与冻结清单不一致；不自动继续，人工核对后取消或重建迁移',
            record.from.root,
          ),
        ],
        record,
      };
    }

    // 目标现状：absent → 走复制装入；installed → 清理候选残留；conflict → 待核对。
    const targetState = await this.targetState(record);
    if (targetState === 'conflict') {
      return {
        ok: false,
        issues: [
          issue('migration-target-conflict', '目标已存在且与冻结清单不一致；不覆盖既有目标，人工核对', record.to.root),
        ],
        record,
      };
    }
    if (targetState === 'absent') {
      const copyIssue = await this.copyCandidate(record, hooks);
      if (copyIssue !== null) throw new MigrationInterrupted(record, [copyIssue]);
      const installIssue = await this.installTarget(record);
      if (installIssue !== null) throw new MigrationInterrupted(record, [installIssue]);
    } else {
      // 目标已装入：候选（若残留）已有所有权证据与内容核对，冗余即清理。
      const candidateFiles = await this.deps.files.listFiles(record.candidate.path);
      if (candidateFiles !== null && this.unexpectedCandidateFiles(record, candidateFiles).length === 0) {
        await this.deps.files.removeDir(record.candidate.path);
      }
    }
    await this.runHook(hooks.afterInstall, record);

    const readyRecord: MigrationRecord = { ...record, status: 'target-ready', updatedAt: this.deps.clock() };
    await this.deps.store.writeRegistry(rootPath, replaceMigration(registry, readyRecord));
    await this.runHook(hooks.afterTargetReady, record);
    return this.switchAndCommit(root, registry, requireEntry(registry, readyRecord), aggregate, readyRecord, hooks);
  }

  private async cancelLocked(root: LocalRootView, request: RecoverRequest): Promise<MigrationOutcome> {
    const rootPath = root.root;
    const registry = await this.deps.store.readRegistry(rootPath);
    const record = migrationsOf(registry).find((item) => item.operationId === request.operationId);
    if (record === undefined) {
      return { ok: false, issues: [issue('migration-not-found', `注册表没有迁移操作 ${request.operationId}`, rootPath)] };
    }
    if (request.confirmDigest !== record.requestDigest) {
      return {
        ok: false,
        issues: [issue('migration-confirm-mismatch', '确认摘要与登记的原请求摘要不一致；用原操作的 requestDigest 确认')],
        record,
      };
    }
    if (record.status === 'committed' || record.status === 'switched') {
      return {
        ok: false,
        issues: [
          issue(
            'migration-already-switched',
            '迁移已切换（唯一切换点已过）；只能补齐回执，不能取消，旧根保留原样',
            record.to.root,
          ),
        ],
        record,
      };
    }
    if (record.status === 'canceled') {
      return { ok: true, root, entry: requireEntry(registry, record), record };
    }

    const removed: string[] = [];
    // 候选：所有权证据（目录名由本操作构造）+ 内容核对（⊆ 冻结清单）才清理。
    const candidateFiles = await this.deps.files.listFiles(record.candidate.path);
    if (candidateFiles !== null) {
      const unexpected = this.unexpectedCandidateFiles(record, candidateFiles);
      if (unexpected.length > 0) {
        return {
          ok: false,
          issues: [
            issue(
              'migration-candidate-unverified',
              `候选目录含清单之外的内容（${unexpected.slice(0, 3).join('、')}）；不清理，人工核对`,
              record.candidate.path,
            ),
          ],
          record,
        };
      }
      await this.deps.files.removeDir(record.candidate.path);
      removed.push(record.candidate.path);
    }
    // 装入目标：逐字节核对等于冻结清单才清理（证明是本操作复制的内容）。
    const targetFiles = await this.deps.files.listFiles(record.to.root);
    if (targetFiles !== null) {
      const manifestPaths = new Set(record.manifest.files.map((file) => file.path));
      if (targetFiles.some((item) => !manifestPaths.has(item))) {
        return {
          ok: false,
          issues: [issue('migration-target-conflict', '目标含非本次复制的内容；不清理，人工核对', record.to.root)],
          record,
        };
      }
      const mismatch = await this.verifyTree(record.to.root, record.manifest, record.to.root);
      if (mismatch !== null) return { ok: false, issues: [mismatch], record };
      await this.deps.files.removeDir(record.to.root);
      removed.push(record.to.root);
    }

    const now = this.deps.clock();
    const canceled: MigrationRecord = {
      ...record,
      status: 'canceled',
      cancel: { at: now, removed },
      updatedAt: now,
    };
    // 取消后保留 schema 2（旧读者停写），登记项不变、来源代际不推进。
    await this.deps.store.writeRegistry(rootPath, replaceMigration(registry, canceled));
    return { ok: true, root, entry: requireEntry(registry, canceled), record: canceled };
  }

  // ---------- 共享步骤 ----------

  private async copyCandidate(record: MigrationRecord, hooks: MigrationHooks): Promise<LocalIssue | null> {
    await this.deps.files.ensureDir(record.candidate.path);
    const existing = await this.deps.files.listFiles(record.candidate.path);
    if (existing !== null) {
      const unexpected = this.unexpectedCandidateFiles(record, existing);
      if (unexpected.length > 0) {
        return issue(
          'migration-candidate-unverified',
          `候选目录含清单之外的内容（${unexpected.slice(0, 3).join('、')}）；不覆盖，人工核对`,
          record.candidate.path,
        );
      }
    }
    // 所有权标记先落盘：中断后凭 operationId 目录名 + 标记证明归属。
    await this.deps.files.writeFile(
      record.candidate.path,
      MIGRATION_MARKER_NAME,
      utf8.encode(
        JSON.stringify(
          {
            operationId: record.operationId,
            ownershipToken: record.candidate.ownershipToken,
            manifestFilesHash: record.manifest.filesHash,
            createdAt: this.deps.clock(),
          },
          null,
          2,
        ) + '\n',
      ),
    );
    for (let index = 0; index < record.manifest.files.length; index += 1) {
      const file = record.manifest.files[index] as MigrationManifestFile;
      const source = await this.deps.files.readFile(record.from.root, file.path);
      if (source === null) {
        return issue('migration-source-unreadable', `复制时来源文件缺失：${file.path}`, file.path);
      }
      if (!source.ok) {
        return issue('migration-source-unreadable', `复制时来源文件不可读：${file.path}（${source.message}）`, file.path);
      }
      await this.deps.files.writeFile(record.candidate.path, file.path, source.bytes);
      await this.runHook(hooks.duringCopy, record, index + 1);
    }
    // 逐字节校验候选（冻结清单逐项核对）。
    const mismatch = await this.verifyTree(record.candidate.path, record.manifest, record.candidate.path);
    if (mismatch !== null) return mismatch;
    // 装入前删除标记：公开资料根内不留迁移痕迹。
    await this.deps.files.removeFile(record.candidate.path, MIGRATION_MARKER_NAME);
    return null;
  }

  private async installTarget(record: MigrationRecord): Promise<LocalIssue | null> {
    const info = await this.deps.files.inspect(record.to.root);
    if (info.exists && !info.isDirectory) {
      return issue('migration-target-not-directory', '目标位置存在但不是目录；不覆盖', record.to.root);
    }
    if (info.exists && info.entries.length > 0) {
      return issue('migration-target-not-empty', '目标目录非空；装入前后都防止覆盖既有目标', record.to.root);
    }
    try {
      await this.deps.files.renameDir(record.candidate.path, record.to.root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        return issue('migration-target-not-empty', '装入时目标已非空；候选保留，人工核对', record.to.root);
      }
      return issue('migration-install-failed', `装入失败：${(error as Error).message}`, record.to.root);
    }
    // 装入后逐字节复核目标。
    const mismatch = await this.verifyTree(record.to.root, record.manifest, record.to.root);
    if (mismatch !== null) return mismatch;
    return null;
  }

  /** switched → 聚合同步 → 回执 → committed；resumeReceipt 表示补齐已切换的操作。 */
  private async switchAndCommit(
    root: LocalRootView,
    registry: Registry,
    entry: RegistryEntry,
    aggregate: InstanceAggregate,
    record: MigrationRecord,
    hooks: MigrationHooks,
    resumeReceipt = false,
  ): Promise<MigrationOutcome> {
    const rootPath = root.root;
    if (!resumeReceipt && entry.sourceGeneration !== record.from.expectedGeneration) {
      return {
        ok: false,
        issues: [
          issue(
            'migration-generation-changed',
            `来源代际已推进（${record.from.expectedGeneration} → ${entry.sourceGeneration}）；不按过期意图切换，重新预览`,
            record.from.root,
          ),
        ],
        record,
      };
    }
    const now = this.deps.clock();
    const switchedRecord: MigrationRecord = { ...record, status: 'switched', updatedAt: now };
    const nextEntry: RegistryEntry = {
      ...entry,
      sourceRoot: record.to.root,
      sourceKind: record.to.kind,
      sourceGeneration: record.newGeneration,
      updatedAt: now,
    };
    // 唯一切换点：活动根、源代际与迁移状态在同一次登记原子替换中改变。
    await this.deps.store.writeRegistry(rootPath, {
      schemaVersion: 2,
      instances: registry.instances.map((item) => (item.instanceId === entry.instanceId ? nextEntry : item)),
      migrations: replaceRecordList(migrationsOf(registry), switchedRecord),
    });
    await this.runHook(hooks.afterSwitch, switchedRecord);

    const nextAggregate: InstanceAggregate = {
      ...aggregate,
      source: { root: record.to.root, kind: record.to.kind, generation: record.newGeneration },
      revisions: { ...aggregate.revisions, state: aggregate.revisions.state + 1 },
    };
    const saved = await this.deps.store.replaceAggregateChecked(rootPath, nextAggregate);
    if (saved.status !== 'saved') {
      return {
        ok: false,
        issues: [
          issue(
            saved.status === 'not-saved' ? 'local-state-write-failed' : 'unknown-state',
            `切换已完成、聚合未确认（${saved.stage}）：${saved.detail ?? '本机状态未保存'}；恢复补齐，不重放复制`,
            record.to.root,
          ),
        ],
        record: switchedRecord,
      };
    }
    const receipt: MigrationReceipt = {
      operationId: record.operationId,
      committedAt: this.deps.clock(),
      sourceGeneration: record.newGeneration,
      effectiveRoot: record.to.root,
    };
    const committed: MigrationRecord = {
      ...switchedRecord,
      status: 'committed',
      receipt,
      updatedAt: this.deps.clock(),
    };
    const refreshed = await this.deps.store.readRegistry(rootPath);
    await this.deps.store.writeRegistry(rootPath, {
      schemaVersion: 2,
      instances: refreshed.instances,
      migrations: replaceRecordList(migrationsOf(refreshed), committed),
    });
    return { ok: true, root, entry: nextEntry, record: committed, aggregate: nextAggregate };
  }

  // ---------- 检查与工具 ----------

  private plan(request: LocalRootRequest): { ok: true; root: LocalRootView } | { ok: false; issues: LocalIssue[] } {
    const planned = planLocalRoot(request);
    if (!planned.ok) return planned;
    return this.deps.resolver.resolveLocal(planned.plan);
  }

  private targetChecks(registry: Registry, entry: RegistryEntry, toRoot: string): LocalIssue[] {
    const issues: LocalIssue[] = [];
    const relation = this.deps.resolver.relation(toRoot, entry.sourceRoot);
    if (relation !== 'disjoint') {
      issues.push(issue('migration-overlap', '目标与来源相同或互相包含；要求互不相关', toRoot));
    }
    for (const other of registry.instances) {
      if (other.instanceId === entry.instanceId) continue;
      if (other.sourceRoot === toRoot) {
        issues.push(issue('migration-target-occupied', `目标已登记为实例 ${other.instanceId} 的资料根`, toRoot));
      }
    }
    for (const migration of migrationsOf(registry)) {
      if (migration.instanceId === entry.instanceId) continue;
      if (isMigrationOpen(migration.status) && migration.to.root === toRoot) {
        issues.push(
          issue(
            'migration-target-occupied',
            `目标被实例 ${migration.instanceId} 的未结束迁移 ${migration.operationId} 占用`,
            toRoot,
          ),
        );
      }
    }
    return issues;
  }

  private workChecks(aggregate: InstanceAggregate): LocalIssue[] {
    const intents = aggregate.workIntents
      .filter((item) => item.status === 'pending' || item.status === 'awaiting-message' || item.status === 'active')
      .map((item) => item.workIntentId);
    const runs = aggregate.workRuns.filter((item) => item.status === 'active').map((item) => item.workRunId);
    const issues: LocalIssue[] = [];
    if (intents.length > 0) {
      issues.push(
        issue('migration-work-pending', `存在未结束的工作意图（${intents.join('、')}）；先停止或完成再迁移`, aggregate.instanceId),
      );
    }
    if (runs.length > 0) {
      issues.push(issue('migration-work-pending', `存在活动 WorkRun（${runs.join('、')}）；先停止再迁移`, aggregate.instanceId));
    }
    return issues;
  }

  private unexpectedCandidateFiles(record: MigrationRecord, files: string[]): string[] {
    const allowed = new Set<string>([MIGRATION_MARKER_NAME, ...record.manifest.files.map((file) => file.path)]);
    return files.filter((file) => !allowed.has(file));
  }

  /** 目标现状：absent（未装入）／installed（已装入且逐字节核对通过）／conflict（不一致）。 */
  private async targetState(record: MigrationRecord): Promise<'absent' | 'installed' | 'conflict'> {
    const files = await this.deps.files.listFiles(record.to.root);
    if (files === null) return 'absent';
    const manifestPaths = new Set(record.manifest.files.map((file) => file.path));
    if (files.some((item) => !manifestPaths.has(item))) return 'conflict';
    const mismatch = await this.verifyTree(record.to.root, record.manifest, record.to.root);
    return mismatch === null ? 'installed' : 'conflict';
  }

  /** 故障注入 hook 调用：抛错一律包装成 MigrationInterrupted（携带当前持久状态）。 */
  private async runHook<T extends unknown[]>(
    hook: ((...args: T) => Promise<void>) | undefined,
    record: MigrationRecord,
    ...args: T
  ): Promise<void> {
    if (hook === undefined) return;
    try {
      await hook(...args);
    } catch (error) {
      throw new MigrationInterrupted(record, [
        issue('migration-interrupted', `注入中断：${(error as Error).message}`),
      ]);
    }
  }

  /** 逐字节核对树内清单文件：缺失或哈希失配都返回诊断。 */
  private async verifyTree(root: string, manifest: MigrationManifest, pathForIssue: string): Promise<LocalIssue | null> {
    for (const file of manifest.files) {
      const bytes = await this.deps.files.readFile(root, file.path);
      if (bytes === null) {
        return issue('migration-verify-missing', `核对时文件缺失：${file.path}`, pathForIssue);
      }
      if (!bytes.ok) {
        return issue('migration-verify-unreadable', `核对时文件不可读：${file.path}（${bytes.message}）`, pathForIssue);
      }
      if ('sha256:' + this.deps.sha256(bytes.bytes) !== file.hash) {
        return issue('migration-verify-mismatch', `文件字节与冻结清单不一致：${file.path}`, pathForIssue);
      }
    }
    return null;
  }
}

function replaceRecordList(records: MigrationRecord[], next: MigrationRecord): MigrationRecord[] {
  return records.map((item) => (item.operationId === next.operationId ? next : item));
}

function replaceMigration(registry: Registry, next: MigrationRecord): Registry {
  return {
    schemaVersion: 2,
    instances: registry.instances,
    migrations: replaceRecordList(migrationsOf(registry), next),
  };
}

function requireEntry(registry: Registry, record: MigrationRecord): RegistryEntry {
  const entry = registry.instances.find((item) => item.instanceId === record.instanceId);
  if (entry === undefined) {
    throw new Error(`迁移记录指向的实例 ${record.instanceId} 不在注册表中`);
  }
  return entry;
}
