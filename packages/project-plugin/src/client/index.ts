// R1 Client 诊断入口（tasks 2.4）：
// 1) 挂载生成的 conaDiagnostic Remote contribution（ctx.remote.$mount）；
// 2) 激活后自动经网关发起真实 Remote invocation 调 conaDiagnostic/probe，
//    结果与错误全部走 console 日志（前缀 [dsh-cona-project]），供宿主 webview
//    devtools 观察——探测经真实 carrier，不以本地调用伪造 invocation。
// 构建说明：本文件由 tsc 类型检查/编译，随后 esbuild 用 lib/typert.remote-client.js
// （generate-typert 产物）覆盖为 bundle，zod 与 protocol/remote-info 一并内联，
// 不依赖 dsh.client.inject。
import typertRemote from '../../lib/typert.remote-client.js'

/** 探针日志前缀，devtools 过滤用。 */
const PREFIX = '[dsh-cona-project]'

interface ConaRemoteResult {
  ok: boolean
  value?: unknown
  error?: unknown
}

interface ConaClientCtx {
  remote?: {
    $mount(contribution: unknown): Promise<() => Promise<void>>
    conaDiagnostic?: {
      probe(): Promise<ConaRemoteResult>
    }
  }
}

function log(message: string): void {
  const globalConsole = (globalThis as { console?: Console }).console
  globalConsole?.log(`${PREFIX} ${message}`)
}

/** 重试内联的 probe 调用：carrier 未就绪时常见首调失败，诊断期 3 次 × 2s。 */
async function probeWithRetry(remote: NonNullable<ConaClientCtx['remote']>): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await remote.conaDiagnostic?.probe()
      if (result === undefined) {
        log('probe: conaDiagnostic namespace not mounted')
        return
      }
      if (result.ok) {
        log(`probe ok (attempt ${attempt}): ${JSON.stringify(result.value)}`)
      } else {
        log(`probe remote-error (attempt ${attempt}): ${JSON.stringify(result.error)}`)
      }
      return
    } catch (error) {
      log(`probe threw (attempt ${attempt}): ${String(error)}`)
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }
}

/** Client 侧最小 apply：挂载 Remote 并自动探测；完整面板在第 5 段实现。 */
export async function apply(ctx: unknown): Promise<void> {
  log('client factory loaded')
  const client = ctx as ConaClientCtx
  if (client.remote === undefined) {
    log('remote service unavailable on client context')
    return
  }
  try {
    const dispose = await client.remote.$mount(typertRemote)
    log('remote contribution mounted (conaDiagnostic/probe)')
    void dispose
  } catch (error) {
    log(`remote mount failed: ${String(error)}`)
    return
  }
  await probeWithRetry(client.remote)
}
