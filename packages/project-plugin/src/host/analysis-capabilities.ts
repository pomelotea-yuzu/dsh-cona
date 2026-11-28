// 四个真实分析能力的注册与处理（tasks 5.1-5.4 / 第 4 组能力接线）。
//
// 由 AnalysisExecutionPort 在派发首条消息前调用 register：只在分析 Agent 自己的
// scope 注册；工具参数不携带身份，身份取真实 exec.agent.id 并与冻结记录比对。
// 读取预算、文件／验证记录凭证由本模块按分析运行累计，save_report 只接受这些
// 实际交付过的凭证作为事实引用。

import { ReadBudget, type AnalysisLimits, type ScopeSelection } from '../domain/analysis.js';
import type { ProjectDocument, Sha256Fn } from '../domain/types.js';
import type { AnalysisCapabilityPort } from '../application/ports.js';
import type { AnalysisRecord } from '../application/local-state.js';
import { analysisSelectionOf } from '../application/analysis-session.js';
import type { AnalysisScopeService, FileReadCredential } from '../application/analysis-scope.js';
import type { AnalysisVerificationService, VerificationIndexEntry, VerificationReadCredential } from '../application/analysis-verification.js';
import type { AnalysisReportService, ReportFactInput } from '../application/analysis-report.js';
import { ANALYSIS_TOOL_NAMES } from './analysis-guard.js';

export interface AnalysisCapabilityDeps {
  readonly scope: AnalysisScopeService;
  readonly verification: AnalysisVerificationService;
  readonly reports: AnalysisReportService;
  readonly baseline: () => Promise<
    { readonly ok: true; readonly doc: ProjectDocument } | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  readonly sha256: Sha256Fn;
  readonly limits: AnalysisLimits;
}

interface ToolRegistry {
  register(definition: AnalysisToolDefinition): () => void;
}

interface AgentWithTools {
  readonly ctx?: { readonly tools?: ToolRegistry };
}

interface AnalysisToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    additionalProperties: false;
    properties: Record<string, { type: string; description?: string; items?: { type: string }; enum?: string[] }>;
    required?: string[];
  };
  output: {
    schema: { type: 'object'; additionalProperties: boolean; properties: Record<string, { type: string; description?: string }>; required?: string[] };
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, exec: { agent?: { id?: unknown } }): Promise<Record<string, unknown>>;
}

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function rejected(code: string, message: string): Record<string, unknown> {
  return { status: 'rejected', code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function positiveInt(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function scopeLabel(scope: ScopeSelection): string {
  return scope.kind === 'root' ? '仓库根' : `${scope.kind === 'file' ? '文件' : '目录'} ${scope.path}`;
}

/**
 * 组装能力注册端口。每次 register 为一条分析运行创建独立的预算与凭证集合；
 * 同一 Session 重复注册由执行端口去重，本模块不做全局状态。
 */
export function createAnalysisCapabilityPort(deps: AnalysisCapabilityDeps): AnalysisCapabilityPort {
  return {
    async register({ agent, record }) {
      const registry = (agent as AgentWithTools)?.ctx?.tools;
      if (registry === undefined || typeof registry.register !== 'function') {
        return { ok: false, code: 'analysis-agent-tools-missing', message: '分析 Agent 没有 scoped tools 注册表' };
      }
      const verificationIndex = await deps.verification.captureIndex();
      const selections = analysisSelectionOf(record);
      const budget = new ReadBudget(deps.limits.readBytes);
      const delivered = { files: [] as FileReadCredential[], verifications: [] as VerificationReadCredential[] };
      const disposers: Array<() => void> = [];

      const sameSession = (exec: { agent?: { id?: unknown } }): boolean => {
        const id = exec.agent?.id;
        return typeof id === 'string' && id === record.sessionId;
      };

      const background: AnalysisToolDefinition = {
        name: ANALYSIS_TOOL_NAMES.background,
        description: 'Read the frozen analysis background: instance, repository, selected scope, plan baseline summary and captured verification-record index. No arguments; identity comes from the real tool context.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string' }, analysisId: { type: 'string' }, planVersion: { type: 'string' }, verificationIndex: { type: 'array' }, coverage: { type: 'object' } }, required: ['status'] }, render: (_args, value) => renderJson(value) },
        async execute(_args, exec) {
          if (!sameSession(exec)) return rejected('analysis-session-mismatch', '工具调用不属于该分析 Session');
          const baseline = await deps.baseline();
          if (!baseline.ok) return rejected(baseline.code, baseline.message);
          const statuses: Record<string, number> = {};
          for (const node of baseline.doc.plan.nodes) statuses[node.status] = (statuses[node.status] ?? 0) + 1;
          return {
            status: 'ok',
            analysisId: record.analysisId,
            instanceId: record.instanceId,
            repositoryId: record.repositoryId,
            scope: scopeLabel(record.scope),
            planVersion: record.planVersion,
            plan: { nodes: baseline.doc.plan.nodes.length, statuses, records: baseline.doc.records.length },
            observation: record.observation,
            verificationIndex: verificationIndex.map((entry) => ({
              recordId: entry.recordId,
              summary: entry.summary,
              subject: entry.subject,
              ...(entry.subjectVersion === undefined ? {} : { subjectVersion: entry.subjectVersion }),
            })),
            coverage: { complete: record.observation.complete, entries: record.observation.entries, issues: record.observation.issues },
          };
        },
      };

      const scopeFiles: AnalysisToolDefinition = {
        name: ANALYSIS_TOOL_NAMES.scopeFiles,
        description: 'List or read files inside the frozen analysis scope. action=list returns ordered entries, exclusions, issues and fingerprint; action=read returns delivered text plus a read credential (line range and hashes). Reads are bounded by the analysis read budget.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['list', 'read'], description: 'list or read' },
            path: { type: 'string', description: 'repo-relative file path for read' },
            startLine: { type: 'integer', description: '1-based first line' },
            maxLines: { type: 'integer', description: 'maximum delivered lines' },
          },
          required: ['action'],
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string' }, entries: { type: 'array' }, text: { type: 'string' }, credential: { type: 'object' } }, required: ['status'] }, render: (_args, value) => renderJson(value) },
        async execute(args, exec) {
          if (!sameSession(exec)) return rejected('analysis-session-mismatch', '工具调用不属于该分析 Session');
          if (!isRecord(args) || !onlyKeys(args, ['action', 'path', 'startLine', 'maxLines'])) return rejected('analysis-args-invalid', '参数必须只含 action/path/startLine/maxLines');
          const action = args['action'];
          if (action === 'list') {
            const observed = await deps.scope.observe(selections);
            if (observed.status === 'rejected') return rejected(observed.code, observed.message);
            return {
              status: 'ok',
              entries: observed.entries,
              exclusions: observed.exclusions,
              issues: observed.issues,
              truncated: observed.truncated,
              complete: observed.complete,
              fingerprint: observed.fingerprint,
              readBudgetRemaining: budget.remaining,
            };
          }
          if (action !== 'read') return rejected('analysis-args-invalid', 'action 必须是 list 或 read');
          if (typeof args['path'] !== 'string' || args['path'] === '') return rejected('analysis-args-invalid', 'read 需要 path');
          const startLine = positiveInt(args['startLine']);
          const maxLines = positiveInt(args['maxLines']);
          if (startLine === null || maxLines === null) return rejected('analysis-args-invalid', 'startLine/maxLines 必须是正整数');
          const read = await deps.scope.read(selections, {
            path: args['path'],
            ...(startLine === undefined ? {} : { startLine }),
            ...(maxLines === undefined ? {} : { maxLines }),
            budget,
          });
          if (read.status === 'rejected') return rejected(read.code, read.message);
          delivered.files.push(read.credential);
          return { status: 'ok', text: read.text, credential: read.credential, truncated: read.truncated, readBudgetRemaining: budget.remaining };
        },
      };

      const verificationTool: AnalysisToolDefinition = {
        name: ANALYSIS_TOOL_NAMES.verification,
        description: 'List the captured verification-record index or read one verification body by recordId. A read re-checks the current index and body hash, then returns text plus a credential; changed or missing records are rejected rather than replaced.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['list', 'read'], description: 'list or read' },
            recordId: { type: 'string', description: 'verification record id for read' },
            startLine: { type: 'integer' },
            maxLines: { type: 'integer' },
          },
          required: ['action'],
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string' }, records: { type: 'array' }, text: { type: 'string' }, credential: { type: 'object' } }, required: ['status'] }, render: (_args, value) => renderJson(value) },
        async execute(args, exec) {
          if (!sameSession(exec)) return rejected('analysis-session-mismatch', '工具调用不属于该分析 Session');
          if (!isRecord(args) || !onlyKeys(args, ['action', 'recordId', 'startLine', 'maxLines'])) return rejected('analysis-args-invalid', '参数必须只含 action/recordId/startLine/maxLines');
          const action = args['action'];
          if (action === 'list') return { status: 'ok', records: verificationIndex, readBudgetRemaining: budget.remaining };
          if (action !== 'read') return rejected('analysis-args-invalid', 'action 必须是 list 或 read');
          if (typeof args['recordId'] !== 'string' || args['recordId'] === '') return rejected('analysis-args-invalid', 'read 需要 recordId');
          const entry: VerificationIndexEntry | undefined = verificationIndex.find((item) => item.recordId === args['recordId']);
          if (entry === undefined) return rejected('analysis-verification-unknown', '记录不在启动时捕获的验证索引中');
          const startLine = positiveInt(args['startLine']);
          const maxLines = positiveInt(args['maxLines']);
          if (startLine === null || maxLines === null) return rejected('analysis-args-invalid', 'startLine/maxLines 必须是正整数');
          const read = await deps.verification.read(entry, {
            budget,
            ...(startLine === undefined ? {} : { startLine }),
            ...(maxLines === undefined ? {} : { maxLines }),
          });
          if (read.status === 'rejected') return rejected(read.code, read.message);
          delivered.verifications.push(read.credential);
          return { status: 'ok', text: read.text, credential: read.credential, truncated: read.truncated, readBudgetRemaining: budget.remaining };
        },
      };

      const saveReport: AnalysisToolDefinition = {
        name: ANALYSIS_TOOL_NAMES.saveReport,
        description: 'Save the one final analysis report for this run. Every fact must cite this run\'s delivered file reads, delivered verification reads, or the frozen plan background; citations are checked against the tool-side credentials. Same requestId with the same payload returns the saved report; a different payload or a second final report is rejected.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            requestId: { type: 'string', description: 'stable id for retry of the same save' },
            summary: { type: 'string' },
            facts: { type: 'array', description: 'facts with text and file/verification/plan citations' },
            inferences: { type: 'array', items: { type: 'string' } },
            suggestions: { type: 'array', items: { type: 'string' } },
          },
          required: ['requestId', 'summary', 'facts'],
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string' }, reportId: { type: 'string' }, coverage: { type: 'object' } }, required: ['status'] }, render: (_args, value) => renderJson(value) },
        async execute(args, exec) {
          if (!sameSession(exec)) return rejected('analysis-session-mismatch', '工具调用不属于该分析 Session');
          if (!isRecord(args) || !onlyKeys(args, ['requestId', 'summary', 'facts', 'inferences', 'suggestions'])) return rejected('analysis-args-invalid', '参数含未允许字段');
          if (typeof args['requestId'] !== 'string' || args['requestId'] === '') return rejected('analysis-args-invalid', 'requestId 必须是非空字符串');
          if (typeof args['summary'] !== 'string' || args['summary'].trim() === '') return rejected('analysis-args-invalid', 'summary 不能为空');
          if (!Array.isArray(args['facts'])) return rejected('analysis-args-invalid', 'facts 必须是数组');
          const inferences = args['inferences'] === undefined ? [] : args['inferences'];
          const suggestions = args['suggestions'] === undefined ? [] : args['suggestions'];
          if (!Array.isArray(inferences) || !inferences.every((item) => typeof item === 'string')) return rejected('analysis-args-invalid', 'inferences 必须是字符串数组');
          if (!Array.isArray(suggestions) || !suggestions.every((item) => typeof item === 'string')) return rejected('analysis-args-invalid', 'suggestions 必须是字符串数组');
          const facts: ReportFactInput[] = [];
          for (const raw of args['facts']) {
            if (!isRecord(raw) || !onlyKeys(raw, ['text', 'files', 'verifications', 'plan'])) return rejected('analysis-args-invalid', 'fact 含未允许字段');
            if (typeof raw['text'] !== 'string' || raw['text'].trim() === '') return rejected('analysis-args-invalid', 'fact.text 不能为空');
            const files = raw['files'] === undefined ? undefined : raw['files'];
            const verifications = raw['verifications'] === undefined ? undefined : raw['verifications'];
            if (files !== undefined) {
              if (!Array.isArray(files) || !files.every((item) => isRecord(item) && onlyKeys(item, ['path', 'startLine', 'endLine']) && typeof item['path'] === 'string')) {
                return rejected('analysis-args-invalid', 'fact.files 必须是 {path,startLine?,endLine?} 数组');
              }
            }
            if (verifications !== undefined) {
              if (!Array.isArray(verifications) || !verifications.every((item) => isRecord(item) && onlyKeys(item, ['recordId', 'startLine', 'endLine']) && typeof item['recordId'] === 'string')) {
                return rejected('analysis-args-invalid', 'fact.verifications 必须是 {recordId,startLine?,endLine?} 数组');
              }
            }
            if (raw['plan'] !== undefined && typeof raw['plan'] !== 'boolean') return rejected('analysis-args-invalid', 'fact.plan 必须是布尔值');
            facts.push({
              text: raw['text'],
              ...(files === undefined ? {} : { files: files as never }),
              ...(verifications === undefined ? {} : { verifications: verifications as never }),
              ...(raw['plan'] === undefined ? {} : { plan: raw['plan'] }),
            });
          }
          const saved = await deps.reports.save({
            analysisId: record.analysisId,
            sessionId: record.sessionId ?? '',
            requestId: args['requestId'],
            summary: args['summary'],
            facts,
            inferences,
            suggestions,
            evidence: { files: [...delivered.files], verifications: [...delivered.verifications] },
          });
          if (saved.status !== 'saved') {
            if (saved.status === 'unknown-state') return rejected(saved.code, saved.message);
            return rejected(saved.code, saved.message);
          }
          return { status: 'ok', reportId: saved.report.reportId, reused: saved.reused, coverage: saved.report.coverage };
        },
      };

      const definitions: AnalysisToolDefinition[] = [background, scopeFiles, verificationTool, saveReport];
      try {
        for (const definition of definitions) disposers.push(registry.register(definition));
      } catch (error) {
        for (const dispose of disposers) {
          try { dispose(); } catch { /* ignore */ }
        }
        return { ok: false, code: 'analysis-capability-register-failed', message: (error as Error).message };
      }
      return { ok: true };
    },
  };
}
