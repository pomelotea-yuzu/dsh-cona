// Git 子进程调用（只读用途）：Git 状态观察与私有根检查共用。
// 不封装任何写操作；超时与不可用统一表达为 errorCode。

import { execFileSync } from 'node:child_process';

export interface GitRun {
  ok: boolean;
  status: number | null;
  stdout: string;
  errorCode?: string;
}

export function runGit(
  bin: string,
  cwd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): GitRun {
  try {
    const stdout = execFileSync(bin, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    return { ok: true, status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; code?: string | number; signal?: string | null; killed?: boolean };
    const status = typeof err.status === 'number' ? err.status : null;
    return {
      ok: false,
      status,
      stdout: '',
      // 只有被杀掉（超时）才是探测失败；其余非零退出码按仓库状态解释。
      errorCode: err.killed === true ? 'ETIMEDOUT' : typeof err.code === 'string' ? err.code : undefined,
    };
  }
}
