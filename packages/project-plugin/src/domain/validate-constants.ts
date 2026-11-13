// 领域常量（供 transforms 等避免与 validate.ts 相互引用放大循环）。UUID 形态与协议一致。
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
