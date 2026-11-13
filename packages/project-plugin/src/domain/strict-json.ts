// v1-plan 协议 §1 严格 JSON 解析。
// 要求：拒绝重复键（按解码后字符串判断）、孤立代理字符、BOM 由调用方按字节拒绝、
// 数字按十进制词法的精确数学值核对（必须为 [-9007199254740991, 9007199254740991] 内整数，
// 不能先浮点舍入）、NaN/Infinity/尾随内容按 invalid-json 拒绝。
// 对象使用 null 原型，避免 "__proto__" 键污染；重复键在赋值前检测。

export type StrictJson =
  | null
  | boolean
  | number
  | string
  | StrictJson[]
  | { [key: string]: StrictJson };

export type StrictParseErrorCode =
  | 'invalid-json'
  | 'duplicate-key'
  | 'unpaired-surrogate'
  | 'non-integer'
  | 'unsafe-integer';

export interface StrictParseError {
  code: StrictParseErrorCode;
  position: number;
  message: string;
}

export type StrictParseResult =
  | { ok: true; value: StrictJson }
  | { ok: false; error: StrictParseError };

const SAFE_MAX = 9007199254740991n; // 2^53 - 1，区间 [-SAFE_MAX, SAFE_MAX]
const MAX_DEPTH = 1000;

class ParseFailure extends Error {
  constructor(
    public readonly code: StrictParseErrorCode,
    public readonly position: number,
    message: string,
  ) {
    super(message);
  }
}

interface Ctx {
  text: string;
  pos: number;
  depth: number;
}

function fail(ctx: Ctx, code: StrictParseErrorCode, message: string): never {
  throw new ParseFailure(code, ctx.pos, message);
}

function skipWs(ctx: Ctx): void {
  const text = ctx.text;
  while (ctx.pos < text.length) {
    const c = text.charCodeAt(ctx.pos);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      ctx.pos += 1;
    } else {
      break;
    }
  }
}

const HEX_VALUE = new Map<string, number>([
  ['0', 0], ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
  ['8', 8], ['9', 9], ['a', 10], ['b', 11], ['c', 12], ['d', 13], ['e', 14], ['f', 15],
  ['A', 10], ['B', 11], ['C', 12], ['D', 13], ['E', 14], ['F', 15],
]);

const SIMPLE_ESCAPES = new Map<string, string>([
  ['"', '"'], ['\\', '\\'], ['/', '/'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'],
]);

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** 追加一个 UTF-16 码元并维护代理对配对状态。孤立代理按协议拒绝。 */
function appendUnit(out: string[], pendingHigh: number, unit: number, ctx: Ctx): number {
  if (pendingHigh !== -1) {
    if (isLowSurrogate(unit)) {
      out.push(String.fromCharCode(pendingHigh, unit));
      return -1;
    }
    fail(ctx, 'unpaired-surrogate', '孤立的高代理字符');
  }
  if (isHighSurrogate(unit)) {
    return unit;
  }
  if (isLowSurrogate(unit)) {
    fail(ctx, 'unpaired-surrogate', '孤立的低代理字符');
  }
  out.push(String.fromCharCode(unit));
  return -1;
}

function parseString(ctx: Ctx): string {
  const text = ctx.text;
  // 进入时 text[ctx.pos] === '"'
  ctx.pos += 1;
  const out: string[] = [];
  let pendingHigh = -1;
  while (ctx.pos < text.length) {
    const c = text.charCodeAt(ctx.pos);
    if (c === 0x22) {
      if (pendingHigh !== -1) {
        fail(ctx, 'unpaired-surrogate', '字符串以孤立的高代理字符结尾');
      }
      ctx.pos += 1;
      return out.join('');
    }
    if (c === 0x5c) {
      ctx.pos += 1;
      const esc = text[ctx.pos];
      if (esc === undefined) {
        fail(ctx, 'invalid-json', '转义符后无字符');
      }
      if (esc === 'u') {
        ctx.pos += 1;
        let unit = 0;
        for (let i = 0; i < 4; i += 1) {
          const digit = HEX_VALUE.get(text[ctx.pos] ?? '');
          if (digit === undefined) {
            fail(ctx, 'invalid-json', '\\u 转义需要四个十六进制位');
          }
          unit = unit * 16 + digit;
          ctx.pos += 1;
        }
        pendingHigh = appendUnit(out, pendingHigh, unit, ctx);
      } else {
        const literal = SIMPLE_ESCAPES.get(esc);
        if (literal === undefined) {
          fail(ctx, 'invalid-json', `非法转义 \\${esc}`);
        }
        if (pendingHigh !== -1) {
          fail(ctx, 'unpaired-surrogate', '高代理字符后被转义符中断');
        }
        out.push(literal);
        ctx.pos += 1;
      }
      continue;
    }
    if (c < 0x20) {
      fail(ctx, 'invalid-json', '字符串内出现未转义控制字符');
    }
    pendingHigh = appendUnit(out, pendingHigh, c, ctx);
    ctx.pos += 1;
  }
  fail(ctx, 'invalid-json', '字符串未闭合');
}

function parseNumber(ctx: Ctx): number {
  const text = ctx.text;
  const start = ctx.pos;
  let i = ctx.pos;
  let negative = false;
  if (text[i] === '-') {
    negative = true;
    i += 1;
  }
  // 整数部分：0 或 [1-9][0-9]*
  const intStart = i;
  const firstCode = i < text.length ? text.charCodeAt(i) : NaN;
  if (firstCode === 0x30) {
    i += 1;
  } else if (firstCode >= 0x31 && firstCode <= 0x39) {
    i += 1;
    while (i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) {
      i += 1;
    }
  } else {
    fail(ctx, 'invalid-json', '非法数字');
  }
  const intPart = text.slice(intStart, i);
  let fracPart = '';
  if (i < text.length && text.charCodeAt(i) === 0x2e) {
    i += 1;
    const fracStart = i;
    while (i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) {
      i += 1;
    }
    if (i === fracStart) {
      fail(ctx, 'invalid-json', '小数点后必须有数字');
    }
    fracPart = text.slice(fracStart, i);
  }
  let expValue = 0;
  if (i < text.length && (text.charCodeAt(i) === 0x65 || text.charCodeAt(i) === 0x45)) {
    i += 1;
    let expSign = 1;
    const signCode = i < text.length ? text.charCodeAt(i) : NaN;
    if (signCode === 0x2b || signCode === 0x2d) {
      if (signCode === 0x2d) expSign = -1;
      i += 1;
    }
    const expStart = i;
    while (i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) {
      i += 1;
    }
    if (i === expStart) {
      fail(ctx, 'invalid-json', '指数部分必须有数字');
    }
    const expDigits = text.slice(expStart, i);
    if (expDigits.length > 6) {
      // 指数量级过大：有效数字非零时必然超出安全区间或必然带小数。
      expValue = expSign > 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
    } else {
      expValue = expSign * Number(expDigits);
    }
  }
  ctx.pos = i;
  void start;

  // 精确数学值核对（协议 §1）。
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(digits)) {
    // 零与负零统一输出 0。
    return 0;
  }
  const effLen = digits.length;
  const scale = expValue - fracPart.length;
  if (effLen + scale > 17) {
    fail(ctx, 'unsafe-integer', '数字绝对值超出安全整数区间');
  }
  if (effLen + scale < -1) {
    fail(ctx, 'non-integer', '数字不是整数');
  }
  let magnitude = BigInt(digits);
  if (scale >= 0) {
    magnitude *= 10n ** BigInt(scale);
  } else {
    const div = 10n ** BigInt(-scale);
    if (magnitude % div !== 0n) {
      fail(ctx, 'non-integer', '数字不是整数');
    }
    magnitude /= div;
  }
  if (magnitude > SAFE_MAX) {
    fail(ctx, 'unsafe-integer', '数字绝对值超出安全整数区间');
  }
  const value = Number(magnitude);
  return negative ? -value : value;
}

function parseValue(ctx: Ctx): StrictJson {
  ctx.depth += 1;
  if (ctx.depth > MAX_DEPTH) {
    fail(ctx, 'invalid-json', '嵌套深度超限');
  }
  skipWs(ctx);
  const c = ctx.text[ctx.pos];
  let value: StrictJson;
  if (c === '{') {
    value = parseObject(ctx);
  } else if (c === '[') {
    value = parseArray(ctx);
  } else if (c === '"') {
    value = parseString(ctx);
  } else if (c === 't') {
    expectLiteral(ctx, 'true');
    value = true;
  } else if (c === 'f') {
    expectLiteral(ctx, 'false');
    value = false;
  } else if (c === 'n') {
    expectLiteral(ctx, 'null');
    value = null;
  } else if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
    value = parseNumber(ctx);
  } else {
    fail(ctx, 'invalid-json', '非法 JSON 值');
  }
  ctx.depth -= 1;
  return value;
}

function expectLiteral(ctx: Ctx, literal: 'true' | 'false' | 'null'): void {
  const at = ctx.text.slice(ctx.pos, ctx.pos + literal.length);
  if (at !== literal) {
    fail(ctx, 'invalid-json', `非法字面量，期望 ${literal}`);
  }
  ctx.pos += literal.length;
}

function parseObject(ctx: Ctx): { [key: string]: StrictJson } {
  const text = ctx.text;
  ctx.pos += 1; // '{'
  const obj: { [key: string]: StrictJson } = Object.create(null) as { [key: string]: StrictJson };
  const seen = new Set<string>();
  skipWs(ctx);
  if (text[ctx.pos] === '}') {
    ctx.pos += 1;
    return obj;
  }
  while (true) {
    skipWs(ctx);
    if (text[ctx.pos] !== '"') {
      fail(ctx, 'invalid-json', '对象键必须是字符串');
    }
    const key = parseString(ctx);
    if (seen.has(key)) {
      fail(ctx, 'duplicate-key', `重复对象键：${JSON.stringify(key)}`);
    }
    seen.add(key);
    skipWs(ctx);
    if (text[ctx.pos] !== ':') {
      fail(ctx, 'invalid-json', '对象键后必须是冒号');
    }
    ctx.pos += 1;
    const value = parseValue(ctx);
    obj[key] = value;
    skipWs(ctx);
    const next = text[ctx.pos];
    if (next === ',') {
      ctx.pos += 1;
      continue;
    }
    if (next === '}') {
      ctx.pos += 1;
      return obj;
    }
    fail(ctx, 'invalid-json', '对象成员后必须是逗号或右花括号');
  }
}

function parseArray(ctx: Ctx): StrictJson[] {
  const text = ctx.text;
  ctx.pos += 1; // '['
  const arr: StrictJson[] = [];
  skipWs(ctx);
  if (text[ctx.pos] === ']') {
    ctx.pos += 1;
    return arr;
  }
  while (true) {
    const value = parseValue(ctx);
    arr.push(value);
    skipWs(ctx);
    const next = text[ctx.pos];
    if (next === ',') {
      ctx.pos += 1;
      continue;
    }
    if (next === ']') {
      ctx.pos += 1;
      return arr;
    }
    fail(ctx, 'invalid-json', '数组元素后必须是逗号或右中括号');
  }
}

/**
 * 严格解析一段已按 UTF-8（无 BOM、fatal 解码）得到的 JSON 文本。
 * BOM 检测与非法 UTF-8 拒绝在字节层完成（Node 适配器 / CLI 负责）。
 */
export function strictParse(text: string): StrictParseResult {
  const ctx: Ctx = { text, pos: 0, depth: 0 };
  try {
    const value = parseValue(ctx);
    skipWs(ctx);
    if (ctx.pos !== text.length) {
      fail(ctx, 'invalid-json', 'JSON 值之后存在多余内容');
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { ok: false, error: { code: error.code, position: error.position, message: error.message } };
    }
    throw error;
  }
}
