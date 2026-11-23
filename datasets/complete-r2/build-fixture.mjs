// R2 收尾 0.2 · 可重复协作项目夹具生成脚本。
//
// 用法：
//   node datasets/complete-r2/build-fixture.mjs [--out artifacts/r2-final] [--reset] [--skip-selfcheck]
//
// 产出布局（默认 artifacts/r2-final/，不入库）：
//   repo/                 原始仓库（分支 main + feature/external），含 project/ 资料根与 demo-app/ 工件
//   copy-a/ copy-b/       两个独立 Git 工作副本（同名仓库 demo-app，不同规范绝对路径）
//   home-clean/           干净 DSH home（空目录，供 H 层 DSH_HOME 使用）
//   migrate/project|dsh|custom/   三个迁移目标（空目录）
//   negative/             越界工件负例（project-escape.json 必须校验失败）+ 仓库外目标文件
//   manifest.json         起始 commit、头文件与正文哈希、登记自检结果
//   selfcheck-local/      登记自检用的本机根（保留，可随 --reset 重建）
//
// 夹具 v1 资料根内容：两个根节点、带子项与内部／外部依赖的子树、一份成果（done 节点 +
// 成果记录）、一份 kind=verification 记录、可查工件（仓库引用 + observedHash）与一条
// [cona:resume] 接续摘要。旧校验器（packages/project-plugin cli/validate）必须通过原夹具。
//
// --reset：删除整个 --out 目录后重建。脚本幂等：同参数重复运行产出字节一致的夹具内容
// （Git commit 时间不同不影响 manifest 记录的哈希与结构）。

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { computePlanVersion } from '../../packages/project-plugin/lib/domain/index.js';

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = (bytes) => sha256Hex(bytes);

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { out: 'artifacts/r2-final', reset: false, skipSelfcheck: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--reset') out.reset = true;
    else if (argv[i] === '--skip-selfcheck') out.skipSelfcheck = true;
    else { console.error(`未知参数: ${argv[i]}`); process.exit(2); }
  }
  return out;
}

const options = parseArgs(process.argv);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.isAbsolute(options.out) ? options.out : path.resolve(repoRoot, options.out);

const PLUGIN_CLI = path.join(repoRoot, 'packages', 'project-plugin', 'lib', 'cli');
const GIT_ID = ['-c', 'user.name=fixture-bot', '-c', 'user.email=fixture-bot@example.invalid'];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

/** git commit 时把 -c 身份放在子命令前。 */
function runGitCommit(args, cwd) {
  return execFileSync('git', [...GIT_ID, 'commit', ...args], { cwd, encoding: 'utf8' }).trim();
}

async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(text, 'utf8'));
}

// ---------- 夹具常量（确定性 ID） ----------
const PROJECT_ID = '00000000-0000-4000-8000-00000000c201';
const REPO_DEMO_ID = '00000000-0000-4000-8000-00000000c205';
const N1 = '00000000-0000-4000-8000-00000000c211'; // 根1 产品设计
const N2 = '00000000-0000-4000-8000-00000000c212'; // 子项 交互稿
const N3 = '00000000-0000-4000-8000-00000000c213'; // 孙项 组件清单（成果）
const N4 = '00000000-0000-4000-8000-00000000c214'; // 根2 工程实现
const N5 = '00000000-0000-4000-8000-00000000c215'; // 子树根 实现主节点
const N6 = '00000000-0000-4000-8000-00000000c216'; // 子树子项 实现子项
const R_OUTCOME = '00000000-0000-4000-8000-00000000c221'; // 成果记录（analysis-note）
const R_VERIF = '00000000-0000-4000-8000-00000000c222';   // verification 记录
const R_RESUME = '00000000-0000-4000-8000-00000000c223';  // [cona:resume] 接续记录

const node = (id, parentId, order, title, goal, criteria, status) => ({
  id, parentId, order, title, goal, completionCriteria: criteria, status,
});

// ---------- 生成 v1 资料根 ----------
async function buildProjectRoot(projectDir) {
  const demoReadme = [
    '# demo-app 工件说明',
    '',
    '本文件是夹具仓库内的可查工件目标：公开记录的 sources 以',
    '`{ "repositoryId": ..., "relativePath": "demo-app/README.md", "observedHash": ... }` 引用本文件，',
    '接入方应在当前工作副本核对相对路径与哈希。',
    '',
    '夹具版本：r2-final v1（改动前基线）。',
    '',
  ].join('\n');
  const demoSource = 'export const demoVersion = "r2-final-v1";\n';
  const demoChecklist = [
    '# 组件清单（成果正文）',
    '',
    '- Button：完成',
    '- Input：完成',
    '- Modal：待实现',
    '',
  ].join('\n');

  await mkdir(path.join(projectDir, 'records'), { recursive: true });
  await writeText(path.join(projectDir, 'demo-app', 'README.md'), demoReadme);
  await writeText(path.join(projectDir, 'demo-app', 'src', 'index.js'), demoSource);
  await writeText(path.join(projectDir, 'demo-app', 'docs', 'checklist.md'), demoChecklist);

  const outcomeBody = [
    '# 成果：组件清单交付',
    '',
    '组件清单已写入 `demo-app/docs/checklist.md`，Button 与 Input 完成，Modal 待实现。',
    '',
    '## 记录信息',
    '',
    '- 记录 ID：`' + R_OUTCOME + '`',
    '- kind：`analysis-note`',
    '- 受检节点：`' + N3 + '`（组件清单）',
    '',
  ].join('\n');

  const planDraft = {
    schemaVersion: 1,
    project: {
      id: PROJECT_ID,
      title: 'R2 收尾协作夹具',
      goal: '为资料接入、树编辑、聊天接续与迁移实测提供改动前 v1 基线',
      constraints: ['保留原文', '公开摘要不含本机私有数据'],
      repositories: [{ id: REPO_DEMO_ID, label: 'demo-app' }],
    },
    plan: {
      nodes: [
        node(N1, null, 0, '产品设计', '形成可用设计资产', ['设计文档入库'], 'todo'),
        node(N2, N1, 0, '交互稿', '交互稿覆盖主流程', ['主流程有交互稿'], 'todo'),
        node(N3, N2, 0, '组件清单', '交付组件清单', ['清单写入 demo-app/docs/checklist.md'], 'done'),
        node(N4, null, 1, '工程实现', '按设计完成工程实现', ['实现与设计一致'], 'todo'),
        node(N5, N4, 0, '实现主节点', '完成主体实现', ['主体实现可运行'], 'todo'),
        node(N6, N5, 0, '实现子项', '完成子项实现', ['子项通过验证'], 'todo'),
      ],
      // 内部依赖：N6 requires N5（子树内）；外部依赖：N5 requires N2、N6 requires N3（跨根跨子树）。
      dependencies: [
        { nodeId: N6, requiresNodeId: N5 },
        { nodeId: N5, requiresNodeId: N2 },
        { nodeId: N6, requiresNodeId: N3 },
      ],
    },
    planVersion: '',
    records: [],
  };
  const { planVersion } = computePlanVersion(planDraft, sha256);

  const outcomeHash = sha256Hex(Buffer.from(outcomeBody, 'utf8'));
  const outcomePath = `records/${R_OUTCOME}/${outcomeHash}.md`;
  await writeText(path.join(projectDir, ...outcomePath.split('/')), outcomeBody);

  const verifBody = [
    '# 验证：组件清单受检通过',
    '',
    '- 受检对象：节点 `' + N3 + '`（组件清单）',
    '- 受检时版本：`' + planVersion + '`（受检时的 planVersion）',
    '- 结果：pass（外部观察：以仓库内工件为来源）',
    '- 范围：Button 与 Input 的清单条目与工件文件一致',
    '',
    '## 记录信息',
    '',
    '- 记录 ID：`' + R_VERIF + '`',
    '- kind：`verification`',
    '- 来源：`demo-app/docs/checklist.md`（仓库引用，外部观察）',
    '',
  ].join('\n');
  const verifHash = sha256Hex(Buffer.from(verifBody, 'utf8'));
  const verifPath = `records/${R_VERIF}/${verifHash}.md`;
  await writeText(path.join(projectDir, ...verifPath.split('/')), verifBody);

  const resumePayload = {
    version: 1,
    stoppedAt: '组件清单已交付，Button/Input 完成',
    nextStep: '启动工程实现主节点',
    nextStepKind: 'confirmed',
    savedAt: '2026-11-23T03:00:00.000Z',
    outcome: '组件清单交付完成',
    decisions: '沿用现有规划基线，不改公开协议',
    openIssues: 'Modal 组件待实现',
    verifications: [
      { status: 'pass', subjectId: N3, label: '组件清单受检通过' },
    ],
  };
  const resumeBody = [
    '<!-- cona:resume v1 -->',
    '',
    '```json',
    JSON.stringify(resumePayload, null, 2),
    '```',
    '',
    '## 接续摘要',
    '',
    '- 停点：' + resumePayload.stoppedAt,
    '- 下一步：' + resumePayload.nextStep + '（confirmed）',
    '- 成果：' + resumePayload.outcome,
    '- 决定：' + resumePayload.decisions,
    '- 未解决：' + resumePayload.openIssues,
    '',
  ].join('\n');
  const resumeHash = sha256Hex(Buffer.from(resumeBody, 'utf8'));
  const resumePath = `records/${R_RESUME}/${resumeHash}.md`;
  await writeText(path.join(projectDir, ...resumePath.split('/')), resumeBody);

  const doc = {
    ...planDraft,
    planVersion,
    records: [
      {
        id: R_OUTCOME,
        kind: 'analysis-note',
        subjectNodeIds: [N3],
        path: outcomePath,
        contentHash: `sha256:${outcomeHash}`,
        summary: '成果：组件清单交付',
        sources: [
          { repositoryId: REPO_DEMO_ID, relativePath: 'demo-app/docs/checklist.md', observedHash: `sha256:${sha256Hex(Buffer.from(demoChecklist, 'utf8'))}` },
        ],
      },
      {
        id: R_VERIF,
        kind: 'verification',
        subjectNodeIds: [N3],
        path: verifPath,
        contentHash: `sha256:${verifHash}`,
        summary: '验证：组件清单受检通过',
        sources: [
          { repositoryId: REPO_DEMO_ID, relativePath: 'demo-app/docs/checklist.md', observedHash: `sha256:${sha256Hex(Buffer.from(demoChecklist, 'utf8'))}` },
        ],
        verification: {
          status: 'pass',
          subject: { kind: 'node', id: N3 },
          subjectVersion: planVersion,
          scope: 'Button 与 Input 的清单条目与工件文件一致',
        },
      },
      {
        id: R_RESUME,
        kind: 'execution-note',
        subjectNodeIds: [N3, N5],
        path: resumePath,
        contentHash: `sha256:${resumeHash}`,
        summary: '[cona:resume] 组件清单已交付，下一步启动工程实现主节点',
        sources: [],
      },
    ],
  };

  await writeText(path.join(projectDir, 'project.json'), JSON.stringify(doc, null, 2) + '\n');

  const projectReadme = [
    '# R2 收尾协作夹具（公开资料）',
    '',
    '- 项目 ID：`' + PROJECT_ID + '`',
    '- 格式：公开资料 v1（`schemaVersion: 1`）',
    '- 仓库映射：`demo-app`（仓库声明 id `' + REPO_DEMO_ID + '`）→ 本仓库内 `demo-app/`',
    '- 接续：从记录索引尾部向前找第一条 `[cona:resume] ` 前缀的 `execution-note`',
    '- 校验：`node packages/project-plugin/lib/cli/validate.js check <本目录>`',
    '',
    '本目录是「改动前 v1 基线」。外部 Agent 修改 JSON 与 Markdown 后须复算指纹并保持校验通过。',
    '',
  ].join('\n');
  await writeText(path.join(projectDir, 'README.md'), projectReadme);

  return { doc, planVersion };
}

// ---------- 越界工件负例 ----------
async function buildNegative(outDir) {
  const negativeDir = path.join(outDir, 'negative');
  await mkdir(negativeDir, { recursive: true });
  await writeText(path.join(negativeDir, 'outside-secret.md'), [
    '# 仓库外文件（越界目标）',
    '',
    '本文件位于夹具 out 根、资料根之外。negative/project-escape.json 用 `../outside-secret.md`',
    '引用它，独立校验必须以 `invalid-relative-path`（越界）拒绝。',
    '',
  ].join('\n'));
  const escapeDoc = {
    schemaVersion: 1,
    project: {
      id: PROJECT_ID,
      title: '越界引用负例',
      goal: '独立校验应拒绝本文件',
      constraints: [],
      repositories: [{ id: REPO_DEMO_ID, label: 'demo-app' }],
    },
    plan: { nodes: [], dependencies: [] },
    planVersion: 'sha256:' + '0'.repeat(64),
    records: [
      {
        id: '00000000-0000-4000-8000-00000000c299',
        kind: 'analysis-note',
        subjectNodeIds: [],
        path: 'records/00000000-0000-4000-8000-00000000c299/placeholder.md',
        contentHash: 'sha256:' + '1'.repeat(64),
        summary: '越界引用负例',
        sources: [{ repositoryId: REPO_DEMO_ID, relativePath: '../outside-secret.md' }],
      },
    ],
  };
  await writeText(path.join(negativeDir, 'project-escape.json'), JSON.stringify(escapeDoc, null, 2) + '\n');
}

// ---------- Git 布局 ----------
function buildGitLayout(projectDir) {
  run('git', ['init', '-b', 'main', '.'], projectDir);
  run('git', ['add', '.'], projectDir);
  runGitCommit(['-m', 'fixture: 改动前 v1 基线'], projectDir);
  const mainHead = run('git', ['rev-parse', 'HEAD'], projectDir);

  run('git', ['checkout', '-b', 'feature/external'], projectDir);
  writeTextSync(path.join(projectDir, 'demo-app', 'NOTES.md'), [
    '# 外部 Agent 改动分支',
    '',
    'feature/external 用于 1.2／1.3 的外部变更接纳与合并实测：外部 Agent 仅凭公开 README',
    '在本分支修改 JSON 与 Markdown、复算指纹、用 Git 合并。',
    '',
    '本分支初始只追加代码工件与说明，不动 project.json（外部资料改动在 1.2 实测时构造）。',
    '',
  ].join('\n'));
  run('git', ['add', '.'], projectDir);
  runGitCommit(['-m', 'fixture: 外部改动分支初始材料'], projectDir);
  const externalHead = run('git', ['rev-parse', 'HEAD'], projectDir);
  run('git', ['checkout', 'main'], projectDir);
  return { mainHead, externalHead };
}

function writeTextSync(file, text) {
  const fs = require('node:fs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(text, 'utf8'));
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ---------- 校验与登记自检 ----------
function validateRoot(projectDir) {
  const stdout = run('node', [path.join(PLUGIN_CLI, 'validate.js'), 'check', projectDir], repoRoot);
  return JSON.parse(stdout);
}

function registerCopy(localRoot, projectDir, copyName) {
  run('node', [
    path.join(PLUGIN_CLI, 'local.js'), 'register',
    '--local-root', localRoot,
    '--source', projectDir,
    '--project-id', PROJECT_ID,
    '--kind', 'project-directory',
  ], repoRoot);
  return JSON.parse(run('node', [
    path.join(PLUGIN_CLI, 'local.js'), 'list', '--local-root', localRoot,
  ], repoRoot));
}

// ---------- 主流程 ----------
async function main() {
  if (options.reset) {
    await rm(outDir, { recursive: true, force: true });
  } else {
    await rm(outDir, { recursive: true, force: true });
  }

  const repoDir = path.join(outDir, 'repo');
  const projectDir = path.join(repoDir, 'project');
  await mkdir(projectDir, { recursive: true });

  const { doc, planVersion } = await buildProjectRoot(projectDir);
  await buildNegative(outDir);
  const heads = buildGitLayout(repoDir);

  // 两个独立工作副本：同名仓库 demo-app，不同规范绝对路径。
  const copyA = path.join(outDir, 'copy-a');
  const copyB = path.join(outDir, 'copy-b');
  run('git', ['clone', repoDir, copyA], outDir);
  run('git', ['clone', repoDir, copyB], outDir);
  run('git', ['-C', copyA, 'remote', 'set-url', 'origin', repoDir], copyA);
  run('git', ['-C', copyB, 'remote', 'set-url', 'origin', repoDir], copyB);

  // 干净 DSH home 与三个迁移目标。
  await mkdir(path.join(outDir, 'home-clean'), { recursive: true });
  for (const target of ['project', 'dsh', 'custom']) {
    await mkdir(path.join(outDir, 'migrate', target), { recursive: true });
  }

  // 自检：旧校验器 + 两副本登记（同项目、不同实例）。
  let selfcheck = { skipped: true };
  if (!options.skipSelfcheck) {
    const validation = validateRoot(projectDir);
    if (!validation.ok) {
      console.error('旧校验器未通过原夹具：', JSON.stringify(validation));
      process.exit(1);
    }
    // check-file 对非法文件退出码 1，这里预期失败并从输出解析 JSON。
    let escapeCheck;
    try {
      const stdout = run('node', [
        path.join(PLUGIN_CLI, 'validate.js'), 'check-file', path.join(outDir, 'negative', 'project-escape.json'),
      ], repoRoot);
      escapeCheck = JSON.parse(stdout);
    } catch (error) {
      const output = (error.output ?? []).map(String).join('');
      escapeCheck = JSON.parse(output.slice(output.indexOf('{')));
    }
    if (escapeCheck.ok !== false || !JSON.stringify(escapeCheck).includes('invalid-relative-path')) {
      console.error('越界负例未被拒绝：', JSON.stringify(escapeCheck));
      process.exit(1);
    }

    const localRoot = path.join(outDir, 'selfcheck-local');
    await mkdir(localRoot, { recursive: true });
    registerCopy(localRoot, copyA, 'copy-a');
    registerCopy(localRoot, copyB, 'copy-b');
    const registry = JSON.parse(run('node', [
      path.join(PLUGIN_CLI, 'local.js'), 'list', '--local-root', localRoot,
    ], repoRoot));
    const entries = registry.instances ?? registry.entries ?? registry;
    const entryA = entries.find((e) => e.sourceRoot === copyA);
    const entryB = entries.find((e) => e.sourceRoot === copyB);
    const sameProject = entryA && entryB && entryA.projectId === entryB.projectId;
    const differentInstances = entryA && entryB && entryA.instanceId !== entryB.instanceId;
    if (!sameProject || !differentInstances) {
      console.error('两副本登记结果不符合预期：', JSON.stringify(entries));
      process.exit(1);
    }
    selfcheck = {
      skipped: false,
      validation: { ok: validation.ok },
      escapeRejected: true,
      copies: { a: entryA, b: entryB },
      sameProjectId: sameProject,
      differentInstanceIds: differentInstances,
    };
  }

  // manifest：起始 commit、头文件与正文哈希。
  const projectJsonPath = path.join(projectDir, 'project.json');
  const projectJsonBytes = await readFile(projectJsonPath);
  const recordHashes = doc.records.map((r) => ({ id: r.id, kind: r.kind, path: r.path, contentHash: r.contentHash }));

  const manifest = {
    generatedAt: new Date().toISOString(),
    script: 'datasets/complete-r2/build-fixture.mjs',
    projectId: PROJECT_ID,
    repositoryLabel: 'demo-app',
    repositoryId: REPO_DEMO_ID,
    layout: {
      repo: repoDir,
      projectRoot: projectDir,
      copyA, copyB,
      homeClean: path.join(outDir, 'home-clean'),
      migrateTargets: {
        project: path.join(outDir, 'migrate', 'project'),
        dsh: path.join(outDir, 'migrate', 'dsh'),
        custom: path.join(outDir, 'migrate', 'custom'),
      },
      negative: path.join(outDir, 'negative'),
      selfcheckLocal: path.join(outDir, 'selfcheck-local'),
    },
    git: {
      branches: { main: 'main', external: 'feature/external' },
      startingCommits: heads,
    },
    hashes: {
      projectJson: `sha256:${sha256Hex(projectJsonBytes)}`,
      planVersion,
      records: recordHashes,
      checkableArtifacts: [
        { repositoryId: REPO_DEMO_ID, relativePath: 'demo-app/docs/checklist.md', observedHash: `sha256:${sha256Hex(await readFile(path.join(projectDir, 'demo-app', 'docs', 'checklist.md')))}` },
      ],
    },
    fixtureContent: {
      rootNodes: [N1, N4],
      subtree: { nodes: [N5, N6], internalDependency: { nodeId: N6, requiresNodeId: N5 }, externalDependencies: [{ nodeId: N5, requiresNodeId: N2 }, { nodeId: N6, requiresNodeId: N3 }] },
      outcome: { node: N3, record: R_OUTCOME },
      verificationRecord: R_VERIF,
      resumeRecord: R_RESUME,
      escapeNegative: 'negative/project-escape.json（独立校验必须拒绝）',
    },
    selfcheck,
  };
  await writeText(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(JSON.stringify({ ok: true, outDir, planVersion, startingCommits: heads, selfcheck }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
