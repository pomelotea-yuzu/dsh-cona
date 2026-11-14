// R1 Client 入口（tasks 2.2 链路 + 5.2 面板）：
// 在侧栏注册“项目”面板入口，并在主区域 keyed slot 注册面板本体。
// 面板只经 `PanelTransport` 读写（当前为宿主 `/api` 载体），不直接碰文件。
// 构建脚本把它包成宿主 loader 所需的 closure factory。

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ConaPanelIcon } from './PanelIcon.js'
import { createHttpTransport } from './http-transport.js'
import { PanelController } from './panel-controller.js'
import { ProjectPanel } from './ProjectPanel.js'

export const name = 'dsh-cona-project.client'

/** `slots` 服务就绪后才注册；侧栏与主区域的槽位由 web 组合声明。 */
export const inject: readonly string[] = ['slots']

/** 面板 id：同时作为侧栏入口与主区域 keyed slot 的键。 */
const PANEL_ID = 'cona-project'

/** 注册面板入口与面板本体；控制器随插件生命周期存在。 */
export function apply(ctx: ClientContext): void {
  const controller = new PanelController({
    transport: createHttpTransport(),
    newOperationId: () => globalThis.crypto.randomUUID(),
  })

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ controller }),
      },
      ProjectPanel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: '项目',
      },
      ConaPanelIcon,
    ),
  )
}
