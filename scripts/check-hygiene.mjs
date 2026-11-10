#!/usr/bin/env node
// DSH-Cona 仓库洁净度门禁
//
// 用法：
//   node scripts/check-hygiene.mjs            # 检查全部已跟踪文件（CI 用）
//   node scripts/check-hygiene.mjs --staged   # 单查暂存区有改动的文件
//   node scripts/check-hygiene.mjs --strict   # 把警告也判为失败
//   node scripts/check-hygiene.mjs --selftest # 隔离 Git 仓库反证测试
//
// --all 与 --staged 的正文、体积和豁免配置均以索引为准。
//
// 存在理由：.gitignore 是默认放行的，一个 `git add -f` 就能把 300MB 安装包写进历史，
// 而历史里的 blob 删不掉。所以拒绝必须由**脚本**执行，并且 pre-commit 与 CI 跑同一条。

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const MODE = args.includes('--staged') ? 'staged' : 'all';
const STRICT = args.includes('--strict');

const MAX_BYTES = 512 * 1024;
const WARN_BYTES = 256 * 1024;

// 出现即失败的路径片段：本仓认定的"垃圾场"与本机配置。
const FORBIDDEN_PATHS = [
  '.dsh-cona/', 'artifacts/', 'output/', 'node_modules/', 'dist/', 'out/', 'build/',
  'release/', '.tmp', '.pnpm-store/',
  '.workbuddy/', '.trae/', '.cursor/', '.claude/', '.vscode/', '.idea/', '.qoder/', 'CLAUDE.md',
  'docs/drafts/',
];
const FORBIDDEN_EXACT = ['.env', '.mcp.json'];
const FORBIDDEN_PREFIX = ['.env.'];
const FORBIDDEN_EXT = new Set([
  '.msi', '.exe', '.dll', '.node', '.pdb', '.lib', '.7z', '.rar', '.iso', '.zip',
  '.gz', '.tgz', '.tar', '.dmg', '.deb', '.rpm', '.AppImage', '.mp4', '.webm',
]);

const SECRET_RULES = [
  ['私钥块', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['OpenAI 形态 key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/],
  ['AWS AccessKeyId', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['赋值形态密钥', /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];

// 机器特定绝对路径：换台机器就失效，也是"本机配置被误提交"的典型指纹。文档不参与本项检查。
// 三端形态都收：Windows 盘符、macOS /Users/<name>、Linux /home/<name>。
const ABS_PATH = /\b[A-Za-z]:[\\/]{2}(?:Users|home|Program Files)\b|[A-Za-z]:\\\\Users\\\\|\/(?:Users|home)\/[A-Za-z0-9._-]+\//;

// 不变量 I12「便携优先 · 不写系统用户目录」的机器落点：产品代码里出现系统用户目录形态即判红。
// 三端都要拦（Win 用户目录 / macOS Library / Linux XDG），不能只按当前开发机平台查。
// 语义（"这是默认值还是用户显式选的"）脚本判不了，所以只拦最典型的写法，其余靠 review。
const SYSTEM_DIR_RULES = [
  ['Windows 环境变量目录', /%(?:APPDATA|LOCALAPPDATA|TEMP|TMP)%/],
  ['读取用户目录环境变量', /process\.env\.(?:APPDATA|LOCALAPPDATA|USERPROFILE|HOME|XDG_(?:CONFIG|DATA|CACHE|STATE)_HOME)\b/],
  ['Windows 用户目录', /[A-Za-z]:[\\/]{2}Users[\\/]/],
  ['macOS Library 目录', /(?:~\/|\/Users\/[^/\s]+\/)Library\/(?:Application Support|Preferences|Caches|Logs|Containers)/],
  ['macOS 系统临时目录', /\/private\/var\/folders\//],
  ['Linux XDG 用户目录', /~\/\.(?:config|local\/share|cache)\//],
  ['Electron 默认路径', /getPath\(\s*['"](?:userData|appData|temp|logs|cache)['"]\s*\)/],
  ['Node 主目录默认值', /os\.homedir\(\)\s*,\s*['"]\./],
  ['Node 系统临时目录默认值', /os\.tmpdir\(\)/],
];

const fails = [];
const warns = [];
const add = (bag, rule, detail, hint) => bag.push({ rule, detail, hint });

function git(gitArgs, opts = {}) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
}

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:[^/]*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // 不含 / 的模式按 .gitignore 语义匹配任意层级下的同名文件
  if (!glob.includes('/')) re = `(?:.*/)?${re}`;
  return new RegExp(`^${re}$`);
}

function readIndexBlob(sha) {
  return git(['cat-file', 'blob', sha], { encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'] });
}

function loadAllowlist() {
  const row = git(['ls-files', '-s', '-z', '--', '.git-hygiene-allowlist'])
    .split('\0').filter(Boolean).find((line) => line.split('\t')[0].endsWith(' 0'));
  if (!row) return [];
  const sha = row.split('\t')[0].split(' ')[1];
  const out = [];
  for (const raw of readIndexBlob(sha).toString('utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const hash = line.indexOf('#');
    const glob = (hash === -1 ? line : line.slice(0, hash)).trim();
    const note = hash === -1 ? '' : line.slice(hash + 1).trim();
    if (!glob) continue;
    if (!note) add(fails, '豁免无理由', `.git-hygiene-allowlist: ${glob}`, '豁免必须写一句话理由，否则等于没有审计线索');
    out.push({ glob, note, re: globToRe(glob), maxBytes: MAX_BYTES, used: false });
    const size = /(?:^|\s)size=(\d+)([KM])/i.exec(note);
    if (size) entry(out.length - 1).maxBytes = Number(size[1]) * (size[2].toUpperCase() === 'M' ? 1 << 20 : 1 << 10);
  }
  return out;
  function entry(i) { return out[i]; }
}

function findExemption(list, file) {
  return list.find((e) => e.re.test(file));
}

function collectFiles(root) {
  const nul = (s) => s.split('\0').filter(Boolean);
  const indexRows = nul(git(['ls-files', '-s', '-z']))
    .map((row) => {
      const [meta, p] = row.split('\t');
      const [mode, sha, stage] = meta.split(' ');
      return { file: p.replace(/\\/g, '/'), sha, stage, mode };
    })
    .filter((r) => r.stage === '0');

  if (MODE === 'all') return indexRows;

  const staged = new Set(nul(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']))
    .map((p) => p.replace(/\\/g, '/')));
  return indexRows.filter((r) => staged.has(r.file));
}

function sizesOf(rows) {
  if (rows.length === 0) return new Map();
  const out = git(['cat-file', '--batch-check=%(objectsize)'], { input: rows.map((r) => r.sha).join('\n') });
  const lines = out.split('\n');
  return new Map(rows.map((r, i) => [r.file, Number(lines[i]) >= 0 ? Number(lines[i]) : Number.NaN]));
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function main() {
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    console.error('✗ 不在 git 仓库内，无法执行洁净度门禁。');
    process.exit(1);
  }

  process.chdir(root);
  const allow = loadAllowlist();
  const rows = collectFiles(root);
  const sizes = sizesOf(rows);

  for (const { file, sha, mode } of rows) {
    // Git 在 macOS / Linux 会静默跳过没有执行位的 hook：Windows 上不依赖这个位，迁机后 pre-commit 门禁会形同未挂。
    if (/^\.githooks\//.test(file) && mode !== '100755') {
      add(fails, 'hook 缺可执行位', `${file}（${mode}）`, 'Git 在 macOS / Linux 会忽略非可执行 hook；chmod +x 后重新 git add，让索引记录 100755');
    }
    const ex = findExemption(allow, file);
    if (ex) ex.used = true;
    const base = path.posix.basename(file);
    const ext = path.extname(file);

    if (!ex) {
      const hitPath = FORBIDDEN_PATHS.find((p) => file.includes(p) || file === p.replace(/\/$/, ''));
      const hitExact = FORBIDDEN_EXACT.includes(base) || FORBIDDEN_PREFIX.some((p) => base.startsWith(p));
      if (hitExact) add(fails, '本机配置/凭据', file, '`.env*`、`.mcp.json` 一类永不入库；需要模板就提交 `.env.example`');
      else if (hitPath) add(fails, '垃圾场路径', file, '该文件属于本地产物或本机记忆，移到 docs/ 或 datasets/ 的正确位置，或留在 artifacts/ 与 .dsh-cona/');
      else if (FORBIDDEN_EXT.has(ext)) add(fails, '二进制/归档后缀', file, `${ext} 不入历史；先登记 .git-hygiene-allowlist 理由再 add -f`);
    }

    const bytes = sizes.get(file);
    const cap = ex ? ex.maxBytes : MAX_BYTES;
    if (Number.isFinite(bytes)) {
      if (bytes > cap) add(fails, '体积超限', `${file}（${(bytes / 1024 / 1024).toFixed(2)} MB > ${(cap / 1024 / 1024).toFixed(2)} MB）`, '拆分内容、改为可下载产物，或抬高豁免行的 size=');
      else if (bytes > WARN_BYTES && !ex) add(warns, '体积偏大', `${file}（${Math.round(bytes / 1024)} KB）`, '确认它真该进历史');
    }
    if (bytes === 0) add(warns, '空文件', file, '空占位请改用目录内一份说明性 README');

    if (ex || file.includes('/fixtures/')) continue;
    const buf = readIndexBlob(sha);
    if (buf.length > 2 << 20 || looksBinary(buf)) continue;
    const text = buf.toString('utf8');
    const isDoc = file.endsWith('.md');
    const isProductCode = /^(?:packages|apps)\//.test(file);

    // 凭据形态连文档一起查：README 里贴一个真 key 和历史里埋一个同样删不掉
    for (const [name, re] of SECRET_RULES) {
      if (re.test(text)) add(fails, '凭据形态', `${file}: ${name}`, '移除真实凭据；密钥只由用户在应用内填写，仓库里留占位符');
    }
    if (isDoc) continue; // 文档里写系统用户目录路径是正当讨论，路径类检查不看文档

    // 策略与模板文本存在的意义就是**禁止**这些路径（openspec 不变量、Issue 表单、门禁规则表自身）。
    // 对它们报警告只会训练贡献者忽略警告，所以本项跳过；凭据扫描仍然照查。
    const isPolicyText = /^(?:openspec\/|\.github\/|\.gitee\/|\.workflow\/|scripts\/check-hygiene\.mjs$)/.test(file);
    if (isPolicyText) continue;

    for (const [name, re] of SYSTEM_DIR_RULES) {
      const m = re.exec(text);
      if (!m) continue;
      const detail = `${file}: ${name} → ${m[0].slice(0, 32)}`;
      if (isProductCode) {
        add(fails, '系统用户目录', detail, '违反不变量 I12「便携优先 · 不写系统用户目录」：数据/缓存/临时文件必须落在数据根之下；不可写时报错并要求 --data-dir，禁止静默回落');
      } else {
        add(warns, '系统用户目录', detail, '确认这是测试夹具或脚本临时目录，不是产品默认路径');
      }
    }

    const absHit = ABS_PATH.exec(text);
    if (absHit) {
      const detail = `${file}: ${absHit[0]}`;
      if (/\.(json|ts|tsx|js|mjs|cjs|ya?ml)$/.test(file)) add(fails, '机器绝对路径', detail, '改用相对数据根的路径或运行时解析的目录');
      else add(warns, '机器绝对路径', detail, '示例路径请标注为本机示例');
    }
  }

  const checked = new Set(rows.map((r) => r.file));
  const ignoredTracked = git(['ls-files', '-i', '-c', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => checked.has(p) && !findExemption(allow, p));
  for (const file of ignoredTracked) {
    add(fails, '忽略却已跟踪', file, '.gitignore 说不要、历史里却留着：`git rm --cached <file>` 后重新提交');
  }

  // 只在 --all 下判定"豁免失效"：staged 模式里本次提交没碰到那个文件，不代表豁免是死的
  if (MODE === 'all') {
    for (const e of allow.filter((x) => !x.used)) {
      add(warns, '豁免失效', e.glob, '没有任何文件命中，删掉这行以免豁免清单变成考古现场');
    }
  }

  const report = (bag, mark) => {
    if (bag.length === 0) return;
    const byRule = new Map();
    for (const item of bag) {
      if (!byRule.has(item.rule)) byRule.set(item.rule, []);
      byRule.get(item.rule).push(item);
    }
    console.log(`\n${mark} ${bag.length} 项`);
    for (const [rule, items] of byRule) {
      console.log(`\n  【${rule}】`);
      for (const it of items.slice(0, 20)) console.log(`    - ${it.detail}\n      ↳ ${it.hint}`);
      if (items.length > 20) console.log(`    … 另有 ${items.length - 20} 项同类`);
    }
  };

  console.log(`DSH-Cona 洁净度门禁 · 模式 ${MODE} · 待查文件 ${rows.length} 个`);
  report(fails, '✗ 失败');
  report(warns, '! 警告');

  const failed = fails.length > 0 || (STRICT && warns.length > 0);
  console.log(`\n结论：失败 ${fails.length} / 警告 ${warns.length}${STRICT ? '（--strict：警告计入失败）' : ''} ⇒ ${failed ? '不放行' : '放行'}`);
  process.exit(failed ? 1 : 0);
}

function selftest() {
  const script = fileURLToPath(import.meta.url);
  const root = git(['rev-parse', '--show-toplevel'], { cwd: path.dirname(script) }).trim();
  const artifacts = path.join(root, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const sandbox = mkdtempSync(path.join(artifacts, 'hygiene-selftest-'));
  // 隔离调用方的索引、工作树与 Git 配置环境；所有临时写入留在 artifacts。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    TMP: sandbox, TEMP: sandbox, TMPDIR: sandbox,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sandbox, 'no-global-config'),
  });
  const privateHeader = ['-----BEGIN ', 'PRIVATE', ' KEY-----'].join('');
  const synthetic = `${privateHeader}\nsynthetic-only\n`;
  const safe = 'safe fixture\n';
  const cases = [
    { name: '暂存凭据后清理工作区', file: 'sample.txt', rule: '凭据形态',
      setup: ({ stage, write }) => { stage('sample.txt', synthetic); write('sample.txt', safe); } },
    { name: '暂存凭据后删除工作区', file: 'sample.txt', rule: '凭据形态',
      setup: ({ stage, remove }) => { stage('sample.txt', synthetic); remove('sample.txt'); } },
    { name: '索引安全而工作区含凭据',
      setup: ({ stage, write }) => { stage('sample.txt', safe); write('sample.txt', synthetic); } },
    { name: '未暂存的新豁免不能放行', file: 'output/sample.txt', rule: '垃圾场路径',
      setup: ({ stage, write }) => {
        stage('output/sample.txt', safe);
        write('.git-hygiene-allowlist', 'output/** # 合成夹具豁免\n');
      } },
    { name: '未暂存的豁免修改不能放行', file: 'output/sample.txt', rule: '垃圾场路径',
      setup: ({ stage, write }) => {
        stage('.git-hygiene-allowlist', '# 索引中没有豁免\n');
        stage('output/sample.txt', safe);
        write('.git-hygiene-allowlist', 'output/** # 合成夹具豁免\n');
      } },
    { name: '已暂存的豁免不受工作区删除影响',
      setup: ({ stage, remove }) => {
        stage('.git-hygiene-allowlist', 'output/** # 合成夹具豁免\n');
        stage('output/sample.txt', safe);
        remove('.git-hygiene-allowlist');
      } },
    { name: '垃圾场路径反例', file: 'output/sample.txt', rule: '垃圾场路径',
      setup: ({ stage }) => stage('output/sample.txt', safe) },
    { name: 'macOS 系统用户目录反例', file: 'packages/core/data-dir.ts', rule: '系统用户目录',
      setup: ({ stage }) => stage('packages/core/data-dir.ts', "const dir = '~/Library/Application Support/DSH-Cona';\n") },
    { name: 'Linux XDG 目录反例', file: 'packages/core/xdg.ts', rule: '系统用户目录',
      setup: ({ stage }) => stage('packages/core/xdg.ts', "const dir = '~/.config/dsh-cona';\n") },
    { name: 'POSIX 机器绝对路径反例', file: 'config.json', rule: '机器绝对路径',
      setup: ({ stage }) => stage('config.json', '{"dataDir":"/Users/someone/Developer/dsh-cona/.dsh-cona"}\n') },
    { name: 'hook 缺可执行位反例', file: '.githooks/pre-commit', rule: 'hook 缺可执行位',
      setup: ({ stage }) => stage('.githooks/pre-commit', '#!/bin/sh\nexit 0\n') },
    { name: '归档后缀反例', file: 'sample.zip', rule: '二进制/归档后缀',
      setup: ({ stage }) => stage('sample.zip', safe) },
    { name: '索引体积反例', file: 'large.txt', rule: '体积超限',
      setup: ({ stage, write }) => { stage('large.txt', 'x'.repeat(MAX_BYTES + 1)); write('large.txt', safe); } },
    { name: '工作区体积不影响安全索引',
      setup: ({ stage, write }) => { stage('sample.txt', safe); write('sample.txt', 'x'.repeat(MAX_BYTES + 1)); } },
    { name: '忽略却已跟踪反例', file: 'ignored.txt', rule: '忽略却已跟踪',
      setup: ({ stage }) => { stage('.gitignore', 'ignored.txt\n'); stage('ignored.txt', safe); } },
    { name: '索引中豁免无理由反例', file: '.git-hygiene-allowlist', rule: '豁免无理由',
      setup: ({ stage, write }) => {
        stage('.git-hygiene-allowlist', 'sample.txt\n');
        stage('sample.txt', safe);
        write('.git-hygiene-allowlist', 'sample.txt # 工作区补理由无效\n');
      } },
  ];
  let passed = 0;
  try {
    for (const [i, test] of cases.entries()) {
      const cwd = path.join(sandbox, `case-${i}`);
      mkdirSync(cwd);
      const fixtureGit = (gitArgs) => git(gitArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      fixtureGit(['init', '--quiet', '--template=']);
      const write = (file, text) => {
        const target = path.join(cwd, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, text);
      };
      test.setup({
        write,
        stage: (file, text) => { write(file, text); fixtureGit(['add', '-f', '--', file]); },
        remove: (file) => unlinkSync(path.join(cwd, file)),
      });
      for (const mode of ['--all', '--staged']) {
        const result = spawnSync(process.execPath, [script, mode], {
          cwd, env, encoding: 'utf8', maxBuffer: 4 << 20,
        });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        const expected = test.rule ? 1 : 0;
        if (result.error || result.signal || result.status !== expected
          || (test.rule && (!output.includes(`【${test.rule}】`) || !output.includes(test.file)))
          || output.includes(privateHeader.slice(0, 16)) || output.includes('synthetic-only')) {
          // 不转印子进程输出，避免测试失败时泄漏命中的正文。
          throw new Error(`${test.name} ${mode} 未通过（退出码 ${result.status}，预期 ${expected}）`);
        }
        passed += 1;
      }
      console.log(`自测通过：${test.name}（--all / --staged）`);
    }
    console.log(`洁净度门禁自测通过：${passed} 项（真实 Git 子进程）`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

try {
  if (args.includes('--selftest')) selftest();
  else main();
} catch (error) {
  // Git 读取失败必须拒绝；普通检查不输出子进程可能携带的正文。
  console.error(args.includes('--selftest')
    ? `洁净度门禁自测失败：${error.message}`
    : '洁净度门禁执行失败：无法读取索引或 Git 数据，不放行。');
  process.exitCode = 1;
}
