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

import type { CommandResult, ConaProjectStatus, ExecuteRequest, PanelTransport, SnapshotResult } from './api.js';

interface ServerResponse<T> {
  type: 'server-response';
  rpcId: string;
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
}

export interface HttpTransportOptions {
  /** 默认 `/api`（与页面同源，Cookie 由浏览器自动带上）。 */
  base?: string;
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
  const base = options.base ?? '/api';
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

  return {
    status: () => call<ConaProjectStatus>('conaProject/status', {}),
    snapshot: (request) => call<SnapshotResult>('conaProject/snapshot', { request }),
    execute: (request: ExecuteRequest) => call<CommandResult>('conaProject/execute', { request }),
  };
}
