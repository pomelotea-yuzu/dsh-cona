// 内置流程预设的领域类型、描述校验与随包实例（R2 项目树编辑与流程拼接，tasks 1.2）。
// 本文件属于 src/domain：不依赖 Node、React、Cordis。预设键为本地字符串，
// 与项目节点 ID 分开；实例化时由应用层分配真实项目节点 ID（见 transforms.instantiateTemplate）。

import type { ValidationIssue } from './types.js';

/** 预设正文语言：与宿主 UI 语言独立；其他宿主语言回退 en。 */
export const PRESET_CONTENT_LOCALES = ['zh-CN', 'en'] as const;
export type PresetContentLocale = (typeof PRESET_CONTENT_LOCALES)[number];

/** 预设固定来源。 */
export const PRESET_SOURCE = 'builtin' as const;
export type PresetSource = typeof PRESET_SOURCE;

/** 模板节点的本地键（小写连字符字符串），仅在本次实例化内映射父子与依赖。 */
export interface PresetNodeRef {
  key: string;
  parentKey: string | null;
  order: number;
}

/** 模板内依赖，两端均为本地键。 */
export interface PresetDependencyRef {
  nodeKey: string;
  requiresKey: string;
}

/** 单个节点在某种正文语言下的正文。 */
export interface PresetNodeText {
  title: string;
  goal: string;
  completionCriteria: string[];
}

/** 预设在某种语言下的展示信息。 */
export interface PresetContent {
  title: string;
  description: string;
}

/**
 * 版本化预设描述。ID 与版本精确匹配，任一正文或结构改动均使用新版本。
 * text 覆盖全部 nodes 键 × 全部 contentLocales；dependencies 两端指向 nodes 键。
 */
export interface PresetDescriptor {
  id: string;
  version: number;
  source: PresetSource;
  contentLocales: readonly PresetContentLocale[];
  content: Record<PresetContentLocale, PresetContent>;
  nodes: readonly PresetNodeRef[];
  text: Record<PresetContentLocale, Record<string, PresetNodeText>>;
  dependencies: readonly PresetDependencyRef[];
}

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const KEY_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * 随包校验预设描述：ID/版本/来源形态、内容语言集合、单根、唯一键、
 * 有效父级、同级连续顺序、父子无环、依赖端点与环，以及各语言结构与键集合一致。
 * 返回空数组表示有效。
 */
export function validatePreset(preset: PresetDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message?: string): void => {
    issues.push(message === undefined ? { code, path } : { code, path, message });
  };

  if (typeof preset.id !== 'string' || !ID_RE.test(preset.id)) {
    add('invalid-preset-id', '/id', '预设 ID 必须是稳定的小写连字符字符串');
  }
  if (!Number.isSafeInteger(preset.version) || preset.version < 1) {
    add('invalid-preset-version', '/version', '预设版本必须是正安全整数');
  }
  if (preset.source !== PRESET_SOURCE) {
    add('invalid-source', '/source', '随包预设来源必须为 builtin');
  }

  const locales = preset.contentLocales;
  const sameLocales =
    Array.isArray(locales) &&
    locales.length === PRESET_CONTENT_LOCALES.length &&
    PRESET_CONTENT_LOCALES.every((loc) => locales.includes(loc));
  if (!sameLocales) {
    add('invalid-content-locales', '/contentLocales', '必须声明 zh-CN 与 en 两种正文语言');
  }

  if (!Array.isArray(preset.nodes) || preset.nodes.length === 0) {
    add('empty-nodes', '/nodes', '预设至少需要一个节点');
    return issues;
  }

  const keys = new Set<string>();
  for (const [index, n] of preset.nodes.entries()) {
    const path = `/nodes/${index}`;
    if (!KEY_RE.test(n.key)) {
      add('invalid-key', `${path}/key`, '节点键必须是小写连字符字符串');
    } else if (keys.has(n.key)) {
      add('duplicate-key', `${path}/key`, `节点键 ${n.key} 重复`);
    }
    keys.add(n.key);
    if (!Number.isSafeInteger(n.order) || n.order < 0) {
      add('invalid-order', `${path}/order`, 'order 必须是非负安全整数');
    }
  }

  const roots = preset.nodes.filter((n) => n.parentKey === null);
  if (roots.length !== 1) {
    add('root-count', '/nodes', '预设必须是单根子树');
  }
  for (const [index, n] of preset.nodes.entries()) {
    if (n.parentKey !== null && !keys.has(n.parentKey)) {
      add('invalid-parent', `/nodes/${index}/parentKey`, `父键 ${n.parentKey} 不存在`);
    }
    if (n.parentKey === n.key) {
      add('parent-cycle', `/nodes/${index}/parentKey`, '节点不能以自身为父');
    }
  }

  // 同级连续顺序（按 parentKey 分组）。
  const ordersByParent = new Map<string | null, number[]>();
  for (const n of preset.nodes) {
    if (!Number.isSafeInteger(n.order) || n.order < 0) continue;
    const list = ordersByParent.get(n.parentKey) ?? [];
    list.push(n.order);
    ordersByParent.set(n.parentKey, list);
  }
  for (const list of ordersByParent.values()) {
    [...list].sort((a, b) => a - b).forEach((value, index) => {
      if (value !== index) {
        add('sibling-order-gap', '/nodes', '同级 order 必须从 0 连续');
      }
    });
  }

  // 父子环：从每个节点向上走 parentKey 链。
  const parentOf = new Map<string, string | null>();
  for (const n of preset.nodes) parentOf.set(n.key, n.parentKey);
  for (const start of keys) {
    const visited = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        add('parent-cycle', '/nodes', '父子关系存在环');
        break;
      }
      visited.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  // 依赖：两端存在、不自依赖、不重复、无环。
  const seenDeps = new Set<string>();
  for (const [index, edge] of preset.dependencies.entries()) {
    const path = `/dependencies/${index}`;
    if (!keys.has(edge.nodeKey) || !keys.has(edge.requiresKey)) {
      add('dependency-node-not-found', path, '依赖端点不存在');
      continue;
    }
    if (edge.nodeKey === edge.requiresKey) {
      add('self-dependency', path, '节点不能依赖自身');
    }
    const key = `${edge.nodeKey}->${edge.requiresKey}`;
    if (seenDeps.has(key)) {
      add('duplicate-dependency', path, '有向依赖重复');
    }
    seenDeps.add(key);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const edge of preset.dependencies) {
    const list = adjacency.get(edge.requiresKey) ?? [];
    list.push(edge.nodeKey);
    adjacency.set(edge.requiresKey, list);
  }
  const reported = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      if ((color.get(next) ?? WHITE) === GRAY && !reported.has(next)) {
        add('dependency-cycle', '/dependencies', '依赖存在环');
        reported.add(next);
      } else if ((color.get(next) ?? WHITE) === WHITE) {
        visit(next);
      }
    }
    color.set(id, BLACK);
  };
  for (const key of keys) {
    if ((color.get(key) ?? WHITE) === WHITE) visit(key);
  }

  // 各语言结构与键集合一致：text 必须覆盖全部节点键且不多不少。
  const expectedKeys = [...keys].sort();
  for (const locale of PRESET_CONTENT_LOCALES) {
    const block = preset.text[locale];
    if (block === undefined || typeof block !== 'object') {
      add('locale-structure-mismatch', `/text/${locale}`, `缺少 ${locale} 正文`);
      continue;
    }
    const actual = Object.keys(block).sort();
    if (actual.length !== expectedKeys.length || actual.some((k, i) => k !== expectedKeys[i])) {
      add('locale-structure-mismatch', `/text/${locale}`, `${locale} 正文键与节点键不一致`);
    }
    for (const key of keys) {
      const t = block[key];
      if (t === undefined || typeof t.title !== 'string' || t.title === '' ||
          typeof t.goal !== 'string' || t.goal === '' ||
          !Array.isArray(t.completionCriteria)) {
        add('invalid-node-text', `/text/${locale}/${key}`, '节点正文必须有标题、目标与完成条件数组');
      }
    }
    const c = preset.content[locale];
    if (c === undefined || typeof c.title !== 'string' || c.title === '' ||
        typeof c.description !== 'string' || c.description === '') {
      add('invalid-content', `/content/${locale}`, '预设展示信息必须有标题与说明');
    }
  }

  return issues;
}

/** 随包「功能开发」预设 v1：根下明确目标与验收条件 → 实现 → 验证，后两项分别依赖前一项。 */
export const FEATURE_DEVELOPMENT_PRESET: PresetDescriptor = {
  id: 'feature-development',
  version: 1,
  source: PRESET_SOURCE,
  contentLocales: [...PRESET_CONTENT_LOCALES],
  content: {
    'zh-CN': { title: '功能开发', description: '从明确目标到实现与验证的代码开发流程' },
    en: { title: 'Feature Development', description: 'A code development flow from goals to implementation and verification' },
  },
  nodes: [
    { key: 'root', parentKey: null, order: 0 },
    { key: 'define', parentKey: 'root', order: 0 },
    { key: 'implement', parentKey: 'root', order: 1 },
    { key: 'verify', parentKey: 'root', order: 2 },
  ],
  text: {
    'zh-CN': {
      root: { title: '功能开发', goal: '交付一个可验证的功能', completionCriteria: [] },
      define: { title: '明确目标与验收条件', goal: '写清功能目标与可验收条件', completionCriteria: ['目标与验收条件已记录'] },
      implement: { title: '实现', goal: '按目标完成实现', completionCriteria: ['实现已完成'] },
      verify: { title: '验证', goal: '对实现进行验证并留存证据', completionCriteria: ['验证结论已记录'] },
    },
    en: {
      root: { title: 'Feature Development', goal: 'Deliver a verifiable feature', completionCriteria: [] },
      define: { title: 'Define Goals and Acceptance', goal: 'Write down goals and acceptance criteria', completionCriteria: ['Goals and criteria recorded'] },
      implement: { title: 'Implement', goal: 'Implement against the goals', completionCriteria: ['Implementation complete'] },
      verify: { title: 'Verify', goal: 'Verify the implementation and keep evidence', completionCriteria: ['Verification result recorded'] },
    },
  },
  dependencies: [
    { nodeKey: 'implement', requiresKey: 'define' },
    { nodeKey: 'verify', requiresKey: 'implement' },
  ],
};
