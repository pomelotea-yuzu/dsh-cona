// 资料位置（tasks 3.1，design §2）：三种位置共用同一公开格式。
// application 层只判定位置种类、必填基准与相对分段；平台路径拼接与文件系统访问由 adapters 落实。
// 位置选择是用户明确输入，不在此做“发现仓库后自动切换”。

import { UUID_RE } from '../domain/validate-constants.js';

export type LocationKind = 'project-directory' | 'dsh-data' | 'custom';

/** 位置种类白名单；未知种类按不支持拒绝，不降级成默认位置。 */
export const LOCATION_KINDS: readonly LocationKind[] = ['project-directory', 'dsh-data', 'custom'];

/** 项目目录资料的固定子目录名（design §2）；`.dsh-cona/` 只是本仓实验落点，不是公开格式名。 */
export const PROJECT_DATA_DIRNAME = '.dsh-cona-project';

/** DSH 数据目录资料的项目分段（相对宿主 home）。 */
export const DSH_DATA_SEGMENTS: readonly string[] = ['data', 'dsh-cona', 'projects'];

export type LocationBase = 'code-root' | 'dsh-home' | 'custom-root';

/** 用户的位置选择与该种类所需的基准目录。 */
export interface LocationRequest {
  kind: LocationKind;
  /** project-directory：代码工作副本根（可尚未存在，用于无代码目录以外的场景）。 */
  codeRoot?: string;
  /** dsh-data：宿主 home；缺省时由宿主适配器注入 `dshHomePath()`。 */
  dshHome?: string;
  /** custom：用户明确选择的资料根。 */
  customRoot?: string;
}

/** 定位计划：基准路径 + 相对分段，不含平台分隔符。 */
export interface LocationPlan {
  kind: LocationKind;
  base: LocationBase;
  basePath: string;
  segments: readonly string[];
}

export interface LocationIssue {
  code: string;
  message: string;
}

export type LocationPlanResult = { ok: true; plan: LocationPlan } | { ok: false; issues: LocationIssue[] };

function isLocationKind(value: string): value is LocationKind {
  return (LOCATION_KINDS as readonly string[]).includes(value);
}

/**
 * 把位置请求转成定位计划。`projectId` 只有 dsh-data 需要（目录按项目 id 分段）；
 * 接入既有资料时不需要项目 id，也不据此新建目录。
 */
export function planLocation(request: LocationRequest, projectId?: string): LocationPlanResult {
  const issues: LocationIssue[] = [];
  if (!isLocationKind(request.kind)) {
    return {
      ok: false,
      issues: [{ code: 'location-kind-unknown', message: `未知资料位置种类：${String(request.kind)}` }],
    };
  }

  const baseOf = (kind: LocationKind): { base: LocationBase; basePath: string | undefined } => {
    if (kind === 'project-directory') return { base: 'code-root', basePath: request.codeRoot };
    if (kind === 'dsh-data') return { base: 'dsh-home', basePath: request.dshHome };
    return { base: 'custom-root', basePath: request.customRoot };
  };
  const { base, basePath } = baseOf(request.kind);
  if (typeof basePath !== 'string' || basePath.trim() === '') {
    issues.push({
      code: 'location-base-missing',
      message:
        base === 'code-root'
          ? '项目目录位置需要代码工作副本根'
          : base === 'dsh-home'
            ? 'DSH 数据目录位置需要宿主 home'
            : '自定义位置需要用户选择的资料根',
    });
    return { ok: false, issues };
  }

  if (request.kind === 'project-directory') {
    return { ok: true, plan: { kind: request.kind, base, basePath, segments: [PROJECT_DATA_DIRNAME] } };
  }
  if (request.kind === 'dsh-data') {
    if (projectId === undefined || !UUID_RE.test(projectId)) {
      issues.push({ code: 'location-project-id-required', message: 'DSH 数据目录位置需要合法的项目 id（UUID v4）' });
      return { ok: false, issues };
    }
    return { ok: true, plan: { kind: request.kind, base, basePath, segments: [...DSH_DATA_SEGMENTS, projectId] } };
  }
  // custom：用户选定的资料根本身就是协议入口，不再追加子目录。
  return { ok: true, plan: { kind: request.kind, base, basePath, segments: [] } };
}
