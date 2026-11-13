// UTF-8 编码：v1-plan 协议要求 canonical 字节为 UTF-8、无 BOM、无末尾换行。
// domain 层不依赖 Node/TextEncoder，此实现按 Unicode 标量逐点编码。
// 输入必须已是 Unicode 标量序列（strict-json 已拒绝孤立代理字符）；
// 直接调用时遇到孤立代理会抛出，避免静默替换字符改变散列。

export class Utf8EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Utf8EncodeError';
  }
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) {
      throw new Utf8EncodeError('空码点');
    }
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new Utf8EncodeError('孤立代理字符无法编码为 UTF-8');
    }
    if (cp <= 0x7f) {
      out.push(cp);
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}
