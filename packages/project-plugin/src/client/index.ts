// Client 入口（R1 5.2 面板 + R2 2.2 顶部概览）：
// - 侧栏「项目」入口 + 主区域 `main` keyed 面板（R1 既有树编辑器）；
// - 窗口顶部 shell.overlay「项目」按钮 + 向下展开的多实例概览（R2）。
// 树面板通过委托控制器显示概览当前选中实例；草稿/选择/代际按实例隔离。
// 构建脚本把它包成宿主 loader 所需的 closure factory。

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ConaPanelIcon } from './PanelIcon.js'
import { NS, dictionaries } from './locales.js'
import { createHttpTransport } from './http-transport.js'
import { ProjectPanel } from './ProjectPanel.js'
import { ProjectTopBar } from './ProjectTopBar.js'
import {
  ProjectOverviewController,
  DelegatingPanelController,
  type OverviewListResult,
} from './project-overview-controller.js'
import type { PanelTransport } from './api.js'

export const name = 'dsh-cona-project.client'

/** `slots` 服务就绪后注册；顶部入口另需 `layout` 以导航到既有树面板。 */
export const inject: readonly string[] = ['slots', 'locale', 'layout']

/** 面板 id：同时作为侧栏入口与主区域 keyed slot 的键。 */
const PANEL_ID = 'cona-project'

/** 读取 owner 概览实例列表（conaOverview/instances）。 */
async function listInstances(): Promise<OverviewListResult> {
  const response = await fetch('/api/conaOverview/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `cona-overview-${globalThis.crypto.randomUUID()}`,
      method: 'conaOverview/instances',
      payload: { args: {} },
    }),
  })
  if (!response.ok) return { status: 'rejected', code: 'transport-http', message: `HTTP ${response.status}` }
  const body = await response.json() as {
    result?: { ok: true; value: OverviewListResult } | { ok: false; error: { code: string; message: string } }
  }
  if (body.result === undefined) return { status: 'rejected', code: 'transport-parse', message: '响应缺少结果' }
  if (!body.result.ok) {
    return { status: 'rejected', code: body.result.error.code, message: body.result.error.message }
  }
  return body.result.value
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-cona-project: dictionaries')
  const t = ctx.locale.bind(NS)
  const newOperationId = (): string => globalThis.crypto.randomUUID()

  const overview = new ProjectOverviewController({
    listInstances,
    // 所有实例（含配置实例）统一走 conaOverview：它按 instanceId 路由并覆盖已登记实例。
    // 若误用 conaProject，请求会落到配置实例，浏览 B 时错误显示 A 的资料。
    transportFor: (instanceId): PanelTransport =>
      createHttpTransport({ namespace: 'conaOverview', instanceId }),
    newOperationId,
  })
  const delegate = new DelegatingPanelController(overview)
  ctx.effect(() => () => delegate.dispose(), 'dsh-cona-project: overview delegate')

  // 既有 R1 树面板：注入委托控制器，显示概览当前选中实例。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ controller: delegate }) },
      ProjectPanel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS, label: () => t('panel') },
      ConaPanelIcon,
    ),
  )

  // 顶部窗口级入口：按钮 + 折叠概览（design §1）。
  const onEnterTree = async (instanceId: string): Promise<void> => {
    if (!overview.select(instanceId)) return
    const controller = overview.panelController(instanceId)
    await controller.open()
    // 1.1 探针约束：selectPanel 检查实时 main 注册表；面板在 apply 早期已注册，
    // 用微任务让本轮 slots 注册/commit 完成再导航，避免 "main panel not registered"。
    await Promise.resolve()
    const panelId = PANEL_ID as Parameters<typeof ctx.layout.selectPanel>[0]
    ctx.layout.selectPanel(panelId)
  }
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'cona-project-top',
        locale: NS,
        inject: () => ({ controller: overview, onEnterTree }),
      },
      ProjectTopBar,
    ),
  )
}
