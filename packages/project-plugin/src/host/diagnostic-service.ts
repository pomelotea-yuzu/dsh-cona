// R1 最小诊断插件（tasks 2.4）：在真实宿主中分开实测
// 1) Remote invocation + owner/non-owner principal；
// 2) 无 invocation 的真实 ToolRunContext（agent / callId / signal）。
// 探针只读上下文并返回结构化结果，不写文件、不做授权判断（授权语义在第 4/6 段实现）。

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conaDiagnostic: ConaDiagnosticService
  }
}

export interface ConaProbeResult {
  /** 本次调用是否携带宿主生成的 Remote invocation。 */
  hasInvocation: boolean;
  /** principalOf 结果：owner 与无 invocation 时为 undefined。 */
  principalOfResult: Principal | undefined;
  /** invocation.peer.principal 原样（含 kind），用于区分 owner 与空值。 */
  peerPrincipal: Principal | undefined;
  /** invocation.service 标识（若存在）。 */
  service: unknown;
  /** 宿主进程信息，用于核对二进制与版本。 */
  runtime: {
    nodeVersion: string;
  };
}

/** 诊断 Remote 服务：探针方法只读当前调用上下文。 */
export class ConaDiagnosticService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'conaDiagnostic')
  }

  /** 探测当前 Remote 调用的 invocation 与 principal；无 invocation 时全部字段为空值形态。 */
  @Remote('probe')
  probe(): ConaProbeResult {
    const invocation: RemoteInvocation | undefined = this.ctx.invocation
    return {
      hasInvocation: invocation !== undefined,
      principalOfResult: principalOf(invocation),
      peerPrincipal: invocation?.peer.principal,
      service: invocation === undefined ? undefined : invocation.service,
      runtime: {
        nodeVersion: process.version,
      },
    }
  }
}
