#!/usr/bin/env node
// DSH-Cona 双语完整性门禁
//
// 用法：
//   node scripts/check-i18n.mjs            检查 i18n/docs-manifest.json 登记的全部成对文档
//   node scripts/check-i18n.mjs --selftest 反证：人为构造缺对/断链/漂移，门禁必须判红
//
// 存在理由：口径写在文档里而没人执行，英文版本就会悄悄停在旧口径上——读者以为它说的是当前事实，
// 比没有英文版更糟。所以"成对"由脚本判定，且 --selftest 保证门禁本身不是假绿。
//
// 本门禁只管**文档层**。产品字符串层（zh-CN / en-US 资源目录与批次归属）等 packages/ 有代码后
// 再接进来，口径见 i18n/README.md。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELFTEST = process.argv.includes('--selftest');
const LINK_MODE = process.argv.includes('--links');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHINESE_LABEL = '\u7b80\u4f53\u4e2d\u6587';

// 英文版本低于中文版四成字节 ⇒ 疑似只翻了一半（中文信息密度高，正常翻译会膨胀不会缩水这么多）
const MIN_RATIO = 0.4;

export const enOf = (zh) => zh.replace(/\.md$/, '.en.md');
export const zhOf = (en) => en.replace(/\.en\.md$/, '.md');

/** 去掉围栏代码块与行内代码后的正文，以及逐行的「是否在围栏内」标记。 */
function scan(text) {
  const stripped = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '').replace(/<!--[\s\S]*?-->/g, '');
  let inFence = false;
  const lines = text.split(/\r?\n/).map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    return { line, inFence };
  });
  return { stripped, lines };
}

function headings2(text) {
  const { lines } = scan(text);
  return lines.filter(({ line, inFence }) => !inFence && /^##\s+\S/.test(line)).map(({ line }) => line.slice(3).trim());
}

function linkEntries(text) {
  const { stripped } = scan(text);
  const md = [...stripped.matchAll(/\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)]
    .map((m) => ({ href: m[2] ?? m[3], label: m[1] }));
  const html = [...stripped.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], label: m[2].replace(/<[^>]*>/g, '').trim() }));
  const attributes = [...stripped.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map((m) => ({ href: m[1] }));
  const references = [...stripped.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map((m) => ({ href: m[1] ?? m[2] }));
  return [...md, ...html, ...attributes, ...references];
}

const links = (text) => [...new Set(linkEntries(text).map((entry) => entry.href))];
const fenceCount = (text) => Math.floor((text.match(/^\s*(?:```|~~~)/gm) || []).length / 2);
const isExternal = (href) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);

function localTarget(root, file, href) {
  const target = decodeURIComponent(href.split(/[?#]/)[0]);
  return target.startsWith('/') ? path.resolve(root, `.${target}`) : path.resolve(root, path.posix.dirname(file), target);
}

/**
 * git 可用时只看已跟踪文件（避免把 artifacts/ 的临时副本算成孤儿）；
 * 仓库尚未 `git init` 时退化成文件系统扫描，同样跳过垃圾场。
 */
function listFiles(root, predicate) {
  if (existsSync(path.join(root, '.git'))) {
    try {
      return execFileSync('git', ['ls-files', '-z'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'))
        .filter((p) => existsSync(path.join(root, p)) && predicate(p));
    } catch {}
  }
  const skip = new Set(['.git', 'node_modules', 'artifacts', 'output', '.dsh-cona', '.pnpm-store', 'dist', '.qoder', '.workbuddy', '.claude', '.cursor', '.trae', '.vscode']);
  const out = [];
  const walk = (rel) => {
    for (const entry of readDirSafe(path.join(root, rel))) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && p !== 'docs/drafts') walk(p);
      } else if (predicate(p)) out.push(p);
    }
  };
  walk('');
  return out;
}

function readDirSafe(abs) {
  try { return readdirSync(abs, { withFileTypes: true }); } catch { return []; }
}

export function validateLinks(root, files = listFiles(root, (file) => file.endsWith('.md'))) {
  const errors = [];
  for (const file of files) {
    for (const href of links(readFileSync(path.join(root, file), 'utf8'))) {
      if (isExternal(href)) continue;
      try {
        if (!existsSync(localTarget(root, file, href))) errors.push({ code: 'BROKEN_LINK', where: file, message: `相对链接解析不到文件：${href}` });
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        errors.push({ code: 'INVALID_LINK', where: file, message: `链接编码无效：${href}` });
      }
    }
  }
  return errors;
}

export function validateDocs(root, docs) {
  const errors = [];
  const add = (code, where, message) => errors.push({ code, where, message });
  const registered = new Set(docs);

  for (const zh of docs) {
    const en = enOf(zh);
    const zhPath = path.join(root, zh);
    const enPath = path.join(root, en);

    if (!existsSync(zhPath)) { add('ZH_MISSING', zh, '登记表里的中文原文不存在'); continue; }
    if (!existsSync(enPath)) { add('TWIN_MISSING', zh, `缺英文双胞胎 ${en}；成对文档必须同轮提交`); continue; }

    const zhText = readFileSync(zhPath, 'utf8');
    const enText = readFileSync(enPath, 'utf8');

    if (!/^\s*#\s+\S/m.test(zhText)) add('NO_TITLE', zh, '没有一级标题');
    if (!/^\s*#\s+\S/m.test(enText)) add('NO_TITLE', en, '没有一级标题');

    for (const [file, text, target, label] of [[zh, zhText, en, 'English'], [en, enText, zh, CHINESE_LABEL]]) {
      const entries = linkEntries(text).filter((entry) => {
        if (isExternal(entry.href)) return false;
        try { return localTarget(root, file, entry.href) === path.resolve(root, target); } catch { return false; }
      });
      if (!entries.length) add('NO_LANG_LINK', file, `正文没有指向 ${target} 的语言入口`);
      else if (!entries.some((entry) => entry.label === label)) add('LANG_LABEL', file, `语言入口应标为 ${label}`);
    }

    // 结构对齐
    const zhH = headings2(zhText);
    const enH = headings2(enText);
    if (zhH.length !== enH.length) {
      add('HEADING_DRIFT', en, `二级标题 ${enH.length} 个 vs 中文 ${zhH.length} 个 ⇒ 有段落没跟着翻`);
    }
    if (fenceCount(zhText) !== fenceCount(enText)) {
      add('CODE_BLOCK_DRIFT', en, `围栏代码块 ${fenceCount(enText)} 组 vs 中文 ${fenceCount(zhText)} 组`);
    }

    // 体积漂移
    const ratio = Buffer.byteLength(enText) / Math.max(1, Buffer.byteLength(zhText));
    if (ratio < MIN_RATIO) add('THIN_TWIN', en, `英文仅为中文的 ${(ratio * 100).toFixed(0)}% ⇒ 疑似节译或漏段`);

    errors.push(...validateLinks(root, [zh, en]));
  }

  for (const en of listFiles(root, (p) => p.endsWith('.en.md'))) {
    if (!registered.has(zhOf(en))) {
      add('TWIN_UNREGISTERED', en, '当前英文版本未登记进 docs-manifest.json；内部旧译本应移到本地归档');
    }
  }

  return errors;
}

// ── 反证自测：每条规则必须能判红，否则门禁是假绿 ────────────────
function writeFixture(into, p, body) {
  const abs = path.join(into, p);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function selftest() {
  const artifacts = path.join(ROOT, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(path.join(artifacts, 'dsh-cona-i18n-'));
  const write = (p, body) => writeFixture(dir, p, body);
  const failures = [];
  let negatives = 0;
  const expect = (name, docs, code, errs = validateDocs(dir, docs)) => {
    negatives += 1;
    if (!errs.some((e) => e.code === code)) failures.push(`反例未判红：${name}（期望 ${code}）`);
  };

  write('a.md', '# 标题 A\n\n[English](a.en.md)\n\n## 一\n\n内容\n');
  write('a.en.md', '# Title A\n\n[简体中文](a.md)\n\n## One\n\nContent long enough to look proportionate.\n');
  write('b.md', '# 标题 B\n\n[English](b.en.md)\n\n## 一\n\n内容\n');
  write('c.md', '# 标题 C\n\n[English](c.en.md)\n\n内容见 [缺失目标](missing.md)\n');
  write('c.en.md', '# Title C\n\n[简体中文](c.md)\n\n内容指向缺失\n');
  write('d.md', '# 标题 D\n\n[English](d.en.md)\n\n## 一\n\n## 二\n\n内容比较长一些\n');
  write('d.en.md', '# Title D\n\n[简体中文](d.md)\n\n## One\n\nShort.\n');
  write('nolang.md', '# 标题 N\n\n内容\n');
  write('nolang.en.md', '# Title N\n\nContent that is clearly longer than the source would suggest\n');
  write('orphan.en.md', '# Orphan\n\n[中文](orphan.md)\n');

  expect('缺英文双胞胎', ['b.md'], 'TWIN_MISSING');
  expect('中文原文不存在', ['nope.md'], 'ZH_MISSING');
  expect('相对链接断', ['c.md'], 'BROKEN_LINK');
  expect('标题数漂移', ['d.md'], 'HEADING_DRIFT');
  expect('语言入口缺失', ['nolang.md'], 'NO_LANG_LINK');
  expect('英文孤儿未登记', ['orphan.md'], 'TWIN_UNREGISTERED');
  write('label.md', '# Label\n\n[English](label.en.md)\n');
  write('label.en.md', '# Label\n\n[English](label.md)\n');
  expect('语言入口标反', ['label.md'], 'LANG_LABEL');
  write('docs/internal.md', '# Internal\n\n[Missing](missing.md)\n');
  expect('内部中文断链', [], 'BROKEN_LINK', validateLinks(dir, ['docs/internal.md']));
  write('root.md', '# Root\n\n[Missing](/missing.md)\n');
  expect('根路径断链', [], 'BROKEN_LINK', validateLinks(dir, ['root.md']));
  write('reference.md', '# Reference\n\n[Missing][ref]\n\n[ref]: missing.md\n');
  expect('引用式断链', [], 'BROKEN_LINK', validateLinks(dir, ['reference.md']));

  const ok = validateDocs(dir, ['a.md']);
  // 正例必须用干净目录：同目录里其他反例的孤儿英文会合法地判红，混在一起等于自测失真
  const clean = mkdtempSync(path.join(artifacts, 'dsh-cona-i18n-ok-'));
  writeFixture(clean, 'a.md', '# 标题 A\n\n[English](a.en.md)\n\n## 一\n\n内容\n');
  writeFixture(clean, 'a.en.md', '# Title A\n\n[简体中文](a.md)\n\n## One\n\nContent long enough to look proportionate.\n');
  writeFixture(clean, 'internal.md', '# Internal document\n\n[Root](/a.md)\n\n[Space](space%20name.md)\n\n~~~md\n[Example](missing.md)\n~~~\n');
  writeFixture(clean, 'space name.md', '# Space\n');
  writeFixture(clean, 'docs/drafts/archive/old.en.md', '# Archived translation\n\n[Missing](missing.md)\n');
  const okClean = [...validateDocs(clean, ['a.md']), ...validateLinks(clean)];
  if (ok.length && !ok.every((e) => e.code === 'TWIN_UNREGISTERED')) {
    failures.push(`正例被误判：a.md ⇒ ${ok.map((e) => `${e.code}:${e.where}`).join(', ')}`);
  }
  if (okClean.length) {
    failures.push(`干净正例被误判 ⇒ ${okClean.map((e) => `${e.code}:${e.where}`).join(', ')}`);
  }

  rmSync(dir, { recursive: true, force: true });
  rmSync(clean, { recursive: true, force: true });
  if (failures.length) {
    for (const f of failures) console.error(`[check-i18n] --selftest FAIL: ${f}`);
    process.exit(1);
  }
  console.log(`[check-i18n] --selftest 通过（${negatives} 个反例 + 1 个正例）`);
  process.exit(0);
}

function main() {
  if (LINK_MODE) {
    // 从已封存的 Cona 原样迁入的档案保持原貌：其中的相对链接指向旧仓库未迁移的
    // architecture / research / archive 文件，改链会破坏原文，故不参与本仓断链判定。
    // 清单与 docs/README.md「从 Cona 原样迁移」一致，新增迁移文件时同步登记。
    const LEGACY_VERBATIM = new Set([
      'docs/product/product-decisions.md',
      'docs/development/project-status.md',
      'openspec/specs/workspace-recovery-prototype/spec.md',
    ]);
    const files = listFiles(ROOT, (file) => file.endsWith('.md') && !LEGACY_VERBATIM.has(file));
    const errors = validateLinks(ROOT, files);
    console.log(`DSH-Cona 文档链接门禁 · ${files.length} 篇文档`);
    for (const error of errors) console.error(`${error.code} · ${error.where} · ${error.message}`);
    console.log(`结论：问题 ${errors.length} ⇒ ${errors.length ? '不放行' : '放行'}`);
    process.exit(errors.length ? 1 : 0);
  }
  const manifestPath = path.join(ROOT, 'i18n', 'docs-manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('✗ 缺 i18n/docs-manifest.json：双语门禁没有登记表就等于不存在。');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const docs = (manifest.docs ?? []).map((d) => (typeof d === 'string' ? d : d.zh));
  const errors = validateDocs(ROOT, docs);

  console.log(`DSH-Cona 双语门禁 · 登记 ${docs.length} 篇对外成对文档`);
  for (const code of [...new Set(errors.map((e) => e.code))]) {
    console.log(`\n✗ 【${code}】`);
    for (const e of errors.filter((x) => x.code === code)) console.log(`  - ${e.where}\n    ↳ ${e.message}`);
  }
  console.log(`\n结论：问题 ${errors.length} ⇒ ${errors.length ? '不放行' : '放行'}`);
  process.exit(errors.length ? 1 : 0);
}

if (SELFTEST) selftest(); else main();
