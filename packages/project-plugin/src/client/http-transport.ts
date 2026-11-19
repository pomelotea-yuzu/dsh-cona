// 面板的 HTTP 传输（5.2）：走宿主既有的 `/api/<namespace>/<method>` 载体。
//
// 线格式（2026-11-14 隔离 profile 实测）：
//   POST /api/conaProject/snapshot
//   { "type": "client-request", "rpcId": "…", "method": "conaProject/snapshot",
//     "payload": { "args": { "request": { … } } } }
// `payload.args` 必须是一个 plain object，字段名与 Host 方法参数名一致。
//
// 边界：本文件只做线协议编解码与错误归一；不做业务判断，也不缓存快照。
// 换成宿主生成的 Remote 代理时，只需另写一个实现 `PanelTransport` 的模块。

import type {
  CommandResult, ConaProjectStatus, ExecuteRequest, FollowEventBatch, FollowHandle, PanelTransport, SnapshotResult,
} from './api.js';

interface ServerResponse<T> {
  type: 'server-response';
  rpcId: string;
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
}

export interface HttpTransportOptions {
  /** 默认 `/api`（与页面同源，Cookie 由浏览器自动带上）。 */
  base?: string;
  /**
   * Remote 命名空间。默认 `conaProject`（R1 配置实例，契约不含 instanceId）；
   * 概览按实例读写用 `conaOverview`（request 带 instanceId）。
   */
  namespace?: string;
  /**
   * 绑定实例 id。仅用于 `conaOverview` 命名空间：所有请求自动带上它，
   * 使 PanelController 无需感知实例。`conaProject` 命名空间忽略此值。
   */
  instanceId?: string;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  /** rpcId 生成；默认递增计数。 */
  rpcId?: () => string;
  timeoutMs?: number;
}

/** 传输层错误：区分“宿主拒绝”（带稳定码）与“网络/解析失败”。 */
export class TransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export function createHttpTransport(options: HttpTransportOptions = {}): PanelTransport {
  const base = options.base ?? '/api'
  const namespace = options.namespace ?? 'conaProject'
  const method = (name: string): string => `${namespace}/${name}`
  // conaOverview 的每个方法都以 request.instanceId 定向；conaProject 契约不含该字段。
  const bound = options.namespace === 'conaOverview' && options.instanceId !== undefined
    ? { instanceId: options.instanceId }
    : {};
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let counter = 0;
  const nextRpcId = options.rpcId ?? (() => `cona-panel-${(counter += 1)}`);

  async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'client-request',
          rpcId: nextRpcId(),
          method,
          payload: { args },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new TransportError('transport-failed', `请求失败：${(error as Error).message}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!response.ok) throw new TransportError('transport-http', `宿主返回 HTTP ${response.status}`);
    let body: ServerResponse<T>;
    try {
      body = (await response.json()) as ServerResponse<T>;
    } catch (error) {
      throw new TransportError('transport-parse', `响应不是合法 JSON：${(error as Error).message}`);
    }
    if (body.type !== 'server-response' || body.result === undefined) {
      throw new TransportError('transport-parse', '响应缺少 server-response 结果');
    }
    if (body.result.ok === false) throw new TransportError(body.result.error.code, body.result.error.message);
    return body.result.value;
  }

  // conaProject/status 无参（line 166 of project-service），conaOverview/status 带 request。
  const statusArgs = options.namespace === 'conaOverview' ? { request: bound } : {};
  return {
    status: () => call<ConaProjectStatus>(method('status'), statusArgs),
    snapshot: (request) => call<SnapshotResult>(method('snapshot'), { request: { ...request, ...bound } }),
    execute: (request: ExecuteRequest) => call<CommandResult>(method('execute'), { request: { ...request, ...bound } }),
    follow: (request) => call<{ status: 'following'; value: FollowHandle } | { status: 'rejected'; code: string; message: string }>(method('follow'), { request: { ...request, ...bound } }),
    followEvents: (request) => call<FollowEventBatch>(method('followEvents'), { request }),
    followClose: (request) => call<{ closed: boolean }>(method('followClose'), { request }),
  };
}
