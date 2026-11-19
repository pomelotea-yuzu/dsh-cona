// R2 任务 2.1：owner-only Remote 准入判据（design §2「授权」）。
//
// 与 R1 `conaProject` 完全相同的判据：宿主真实 invocation、peer principal=owner、
// principalOf 为空。抽出共享实现是为了让新增 owner 概览入口与既有 Remote 用同一把尺子，
// 不因新入口放宽或收紧。缺 invocation 不降级为进程内 owner，业务参数不当身份。

import type { Context } from '@deepseek-ai/cordis'
import { principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type { TrustedContext } from '../application/command-service.js'

/** owner Remote 入口传给应用层的可信主体（与 R1 conaProject 一致）。 */
export const OWNER_CONTEXT: TrustedContext = { kind: 'remote-owner' }

export type OwnerDenial = { status: 'rejected'; code: string; message: string } | null;

/** 从 ctx.invocation 判定 owner 准入；拒绝原因稳定且不泄露内部状态。 */
export function denyNonOwner(ctx: Context): OwnerDenial {
  const invocation: RemoteInvocation | undefined = ctx.invocation
  if (invocation === undefined) {
    return { status: 'rejected', code: 'forbidden', message: '缺少宿主生成的 Remote invocation；不降级为进程内 owner' }
  }
  if (invocation.peer.principal.kind !== 'owner') {
    return { status: 'rejected', code: 'forbidden', message: '该 Remote 入口只允许 owner 主体' }
  }
  if (principalOf(invocation) !== undefined) {
    return { status: 'rejected', code: 'forbidden', message: 'principalOf 非空；该入口只接受 owner 直接调用' }
  }
  return null
}
