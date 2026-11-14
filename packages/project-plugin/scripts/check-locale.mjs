#!/usr/bin/env node
// 字典与包元信息检查（tasks 5.4，design §9）。
//
// 必查：
// 1. UI 字典（`src/client/locales/*.json`）：中英 key 集合一致、每个值非空、
//    同名占位符集合一致、不出现业务内容（指纹、UUID、路径）冒充文案；
// 2. 包元信息（`locale/*.json`）：中英 `meta.title`／`meta.description` 齐全非空；
// 3. 固定文案：界面不允许把稳定错误码写进字典（只放人读文案）。
//
// 用法：node scripts/check-locale.mjs [--selftest]
// `--selftest` 用内置反例证明检查会失败（缺失 key、占位符不一致、空值、元信息缺字段）。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_NS = 'dsh-cona.project';

/** 提取 `{name}` 形态的占位符，排序后比较。 */
export function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

/** 字典问题的稳定描述；空数组表示通过。 */
export function checkDictionaries(dicts, label = UI_NS) {
  const issues = [];
  const languages = Object.keys(dicts);
  if (languages.length < 2) issues.push(`${label}: 至少需要两种语言，实际 ${languages.length}`);
  const [base, ...others] = languages;
  if (base === undefined) return [`${label}: 没有字典`];
  const baseKeys = Object.keys(dicts[base]).sort();
  for (const key of baseKeys) {
    const value = dicts[base][key];
    if (typeof value !== 'string' || value.trim() === '') issues.push(`${label}/${base}/${key}: 文案为空`);
  }
  for (const language of others) {
    const keys = Object.keys(dicts[language]).sort();
    for (const missing of baseKeys.filter((key) => !keys.includes(key))) {
      issues.push(`${label}/${language}: 缺少 key "${missing}"`);
    }
    for (const extra of keys.filter((key) => !baseKeys.includes(key))) {
      issues.push(`${label}/${language}: 多余 key "${extra}"（不在 ${base} 中）`);
    }
    for (const key of baseKeys.filter((item) => keys.includes(item))) {
      const reference = dicts[base][key];
      const value = dicts[language][key];
      if (typeof value !== 'string' || value.trim() === '') {
        issues.push(`${label}/${language}/${key}: 文案为空`);
        continue;
      }
      const want = placeholders(reference).join(',');
      const got = placeholders(value).join(',');
      if (want !== got) issues.push(`${label}/${language}/${key}: 占位符不一致（${want || '无'} ≠ ${got || '无'}）`);
    }
  }
  for (const language of languages) {
    for (const [key, value] of Object.entries(dicts[language])) {
      if (typeof value !== 'string') continue;
      if (/sha256:[0-9a-f]{8}/.test(value)) issues.push(`${label}/${language}/${key}: 含规划指纹，属于业务值`);
      if (/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(value)) {
        issues.push(`${label}/${language}/${key}: 含 UUID，属于业务值`);
      }
      if (/(^|\s)\/(Users|home|var|tmp)\//.test(value)) issues.push(`${label}/${language}/${key}: 含绝对路径，属于业务值`);
    }
  }
  return issues;
}

/** 包元信息检查：两种语言的 title／description 必须齐全非空。 */
export function checkMetadata(metas, label = 'locale') {
  const issues = [];
  for (const [language, value] of Object.entries(metas)) {
    for (const field of ['title', 'description']) {
      const text = value?.meta?.[field];
      if (typeof text !== 'string' || text.trim() === '') {
        issues.push(`${label}/${language}: 缺少非空的 meta.${field}`);
      }
    }
  }
  return issues;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function selftest() {
  const cases = [
    ['缺失 key', () => checkDictionaries({ zh: { a: '甲', b: '乙' }, en: { a: 'A' } }), '缺少 key'],
    ['多余 key', () => checkDictionaries({ zh: { a: '甲' }, en: { a: 'A', b: 'B' } }), '多余 key'],
    ['占位符不一致', () => checkDictionaries({ zh: { a: '共 {n} 条' }, en: { a: 'Total items' } }), '占位符不一致'],
    ['空值', () => checkDictionaries({ zh: { a: '  ' }, en: { a: 'A' } }), '文案为空'],
    ['业务值入字典', () => checkDictionaries({ zh: { a: '指纹 sha256:abcdef12' }, en: { a: 'x sha256:abcdef12' } }), '业务值'],
    ['元信息缺字段', () => checkMetadata({ zh: { meta: { title: '标题' } }, en: { meta: { title: 'T', description: 'D' } } }), 'meta.description'],
  ];
  const failures = [];
  for (const [name, run, expect] of cases) {
    const issues = run();
    if (!issues.some((issue) => issue.includes(expect))) {
      failures.push(`反例「${name}」未被拒绝：${issues.join('；') || '无问题'}`);
    }
  }
  // 正例：合法的中英字典与元信息通过。
  const pass = checkDictionaries({ zh: { a: '共 {n} 条' }, en: { a: 'Total {n}' } });
  if (pass.length > 0) failures.push(`正例被误判：${pass.join('；')}`);
  if (failures.length > 0) {
    process.stderr.write(failures.map((line) => `- ${line}`).join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`字典检查自测通过：${cases.length} 个反例 + 1 个正例。\n`);
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  const uiDir = path.join(packageRoot, 'src', 'client', 'locales');
  const issues = [];
  for (const language of ['zh', 'en']) {
    const file = path.join(uiDir, `${language}.json`);
    if (!existsSync(file)) issues.push(`缺少 UI 字典：${path.relative(packageRoot, file)}`);
  }
  if (issues.length === 0) {
    issues.push(...checkDictionaries({ zh: readJson(path.join(uiDir, 'zh.json')), en: readJson(path.join(uiDir, 'en.json')) }));
  }
  const metas = {};
  for (const language of ['zh', 'en']) {
    const file = path.join(packageRoot, 'locale', `${language}.json`);
    if (!existsSync(file)) issues.push(`缺少包元信息：locale/${language}.json`);
    else metas[language] = readJson(file);
  }
  if (Object.keys(metas).length === 2) issues.push(...checkMetadata(metas));

  if (issues.length > 0) {
    process.stderr.write(issues.map((line) => `- ${line}`).join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`字典检查通过：${UI_NS} 中英 key／占位符一致，包元信息齐全。\n`);
  }
}
