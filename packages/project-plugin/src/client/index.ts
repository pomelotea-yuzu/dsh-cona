// R1 Client 最小 factory（tasks 2.2）：验证打包格式与加载链路；完整面板在第 5 段实现。
// 构建脚本把它包成宿主 loader 所需的 closure factory：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })
// external 通过 loader module table 的注入 require 解析（cordis DI 实体，无全局、无 import map）。

export const name = 'dsh-cona-project.client'

export const inject: readonly string[] = []

/** Client 侧最小 apply：记录加载成功，供 2.3 观察 Client 导航与加载链路。 */
export function apply(ctx: unknown): void {
  const globalConsole = (globalThis as { console?: Console }).console
  globalConsole?.log('[dsh-cona-project] client factory loaded')
  void ctx
}
