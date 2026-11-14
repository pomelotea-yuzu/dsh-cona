// 公开资料相对引用协议（design §4）：统一 `/` 分段，供其他 Agent 与独立实现复用。
// 纯字符串校验，不依赖 Node；不解析符号链接或真实文件系统。

export type RelativePathErrorCode =
  | 'path-empty'
  | 'path-not-string'
  | 'path-absolute'
  | 'path-backslash'
  | 'path-nul'
  | 'path-drive-letter'
  | 'path-empty-segment'
  | 'path-dot-segment'
  | 'path-encoded-escape';

export interface RelativePathError {
  code: RelativePathErrorCode;
  message: string;
}

export type RelativePathResult = { ok: true; segments: string[] } | { ok: false; error: RelativePathError };

function decodeOnce(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 校验公开资料中的相对引用。
 * 拒绝：非字符串／空、绝对路径、盘符、反斜杠、NUL、空段、`.` 与 `..` 段，
 * 以及解码后变成 `.`／`..`／含分隔符的编码绕过写法（如 `%2e%2e`）。
 */
export function validateRelativePath(value: unknown): RelativePathResult {
  if (typeof value !== 'string') {
    return { ok: false, error: { code: 'path-not-string', message: '相对引用必须是字符串' } };
  }
  if (value === '') {
    return { ok: false, error: { code: 'path-empty', message: '相对引用不得为空' } };
  }
  if (value.includes('\0')) {
    return { ok: false, error: { code: 'path-nul', message: '相对引用含 NUL 字符' } };
  }
  if (value.includes('\\')) {
    return { ok: false, error: { code: 'path-backslash', message: '相对引用只允许 `/` 分段，不接受反斜杠' } };
  }
  if (value.startsWith('/')) {
    return { ok: false, error: { code: 'path-absolute', message: '相对引用不得以 `/` 开头' } };
  }
  if (/^[A-Za-z]:/.test(value)) {
    return { ok: false, error: { code: 'path-drive-letter', message: '相对引用不得携带盘符' } };
  }

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '') {
      return { ok: false, error: { code: 'path-empty-segment', message: '相对引用不得含空段（连续的 `/`）' } };
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, error: { code: 'path-dot-segment', message: '相对引用不得含 `.` 或 `..` 段' } };
    }
    if (segment.includes('%')) {
      const decoded = decodeOnce(segment);
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
        return {
          ok: false,
          error: { code: 'path-encoded-escape', message: '相对引用含解码后越界的分段，拒绝编码绕过' },
        };
      }
      if (decoded !== segment) {
        return {
          ok: false,
          error: { code: 'path-encoded-escape', message: '相对引用不接受百分号编码，按字面 UTF-8 书写' },
        };
      }
    }
  }
  return { ok: true, segments };
}
