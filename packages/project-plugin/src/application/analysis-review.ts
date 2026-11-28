// 从历史报告复盘（tasks 6.3）：重新预览当前范围，再经与首次分析相同的发起通路
// 建立新 analysisId 与真实 Session；旧报告与旧绑定保持独立，规划与建议不自动应用。
//
// 边界：本文件只编排报告读取、范围预览与 Session 启动；不直接触碰宿主或文件系统。

import type { AnalysisRecord, AnalysisReportRecord } from './local-state.js';
import type { ScopeSelection } from '../domain/analysis.js';
import { ANALYSIS_TERMINAL_STATUSES, type AnalysisOutcome, type StartAnalysisRequest, type StartAnalysisValue } from './analysis-session.js';
import type { AnalysisPreviewResult, AnalysisScopeService } from './analysis-scope.js';

/** 报告读取端口：按实例隔离；测试可注入假实现。 */
export interface AnalysisReportLookupPort {
  get(reportId: string): Promise<
    | { readonly status: 'ok'; readonly report: AnalysisReportRecord }
    | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  >;
}

/** 分析 Session 端口：读取原记录并用首次分析同一通路启动。 */
export interface AnalysisReviewSessionPort {
  get(analysisId: string): Promise<
    | { readonly status: 'ok'; readonly analysis: AnalysisRecord }
    | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  >;
  start(request: StartAnalysisRequest): Promise<AnalysisOutcome<StartAnalysisValue>>;
}

export interface AnalysisReviewServiceDeps {
  readonly reports: AnalysisReportLookupPort;
  readonly sessions: AnalysisReviewSessionPort;
  readonly scope: AnalysisScopeService;
}

/** 复盘预览：原报告身份 + 当前同一范围的重新观察。 */
export interface ReanalyzePreview {
  readonly reportId: string;
  readonly previousAnalysisId: string;
  readonly repositoryId: string;
  readonly scope: ScopeSelection;
  readonly preview: AnalysisPreviewResult;
}

export interface ReanalyzeRequest {
  /** 本次复盘的启动操作号；与首轮相同，重试回到同一条新分析。 */
  readonly operationId: string;
  readonly reportId: string;
  /** 当前选定的仓库；缺省沿用原报告。 */
  readonly repositoryId?: string;
  /** 当前确认的范围；缺省沿用原报告。 */
  readonly scope?: ScopeSelection;
  readonly expectedFingerprint?: string;
  readonly expectedPlanVersion?: string;
}

export interface ReanalyzeValue extends StartAnalysisValue {
  readonly sourceReportId: string;
  /** 新记录指向的原分析；旧报告不被替换。 */
  readonly previousAnalysisId: string;
}

export type ReanalyzePreviewResult =
  | { readonly status: 'ok'; readonly value: ReanalyzePreview }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string };

export class AnalysisReviewService {
  constructor(private readonly deps: AnalysisReviewServiceDeps) {}

  /**
   * 复盘前重新确认范围：用原报告的仓库与范围做一次当前预览，
   * 不创建分析、不发送消息。预览失败保留原因，由 UI 让用户改选或取消。
   */
  async preview(
    reportId: string,
    options: { readonly repositoryId?: string; readonly scope?: ScopeSelection } = {},
  ): Promise<ReanalyzePreviewResult> {
    if (typeof reportId !== 'string' || reportId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 reportId' };
    }
    const detail = await this.deps.reports.get(reportId);
    if (detail.status !== 'ok') return { status: 'rejected', code: detail.code, message: detail.message };
    const report = detail.report;
    const repositoryId = options.repositoryId ?? report.repositoryId;
    const scope = options.scope ?? report.scope;
    const preview = await this.deps.scope.preview({ repositoryId, scope });
    return {
      status: 'ok',
      value: {
        reportId: report.reportId,
        previousAnalysisId: report.analysisId,
        repositoryId,
        scope,
        preview,
      },
    };
  }

  /**
   * 从历史报告复盘：原分析必须已结束；新分析沿用同一发起通路，
   * 使用当前代码观察与规划基线，登记新的 analysisId 和真实 Session。
   */
  async reanalyze(request: ReanalyzeRequest): Promise<AnalysisOutcome<ReanalyzeValue>> {
    if (typeof request?.operationId !== 'string' || request.operationId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 operationId' };
    }
    if (typeof request.reportId !== 'string' || request.reportId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 reportId' };
    }
    const detail = await this.deps.reports.get(request.reportId);
    if (detail.status !== 'ok') return { status: 'rejected', code: detail.code, message: detail.message };
    const report = detail.report;
    const source = await this.deps.sessions.get(report.analysisId);
    if (source.status !== 'ok') return { status: 'rejected', code: source.code, message: source.message };
    if (!ANALYSIS_TERMINAL_STATUSES.includes(source.analysis.status)) {
      return {
        status: 'rejected',
        code: 'analysis-source-active',
        message: '原分析尚未结束；报告完成后才能从该报告复盘',
      };
    }
    const started = await this.deps.sessions.start({
      operationId: request.operationId,
      repositoryId: request.repositoryId ?? report.repositoryId,
      scope: request.scope ?? report.scope,
      ...(request.expectedFingerprint === undefined ? {} : { expectedFingerprint: request.expectedFingerprint }),
      ...(request.expectedPlanVersion === undefined ? {} : { expectedPlanVersion: request.expectedPlanVersion }),
      previousAnalysisId: report.analysisId,
    });
    if (started.status !== 'committed') return started;
    // 启动操作号可能与首轮分析或别处复用：只有确实指向「从该报告发起」的新记录才算复盘。
    if (started.value.analysis.previousAnalysisId !== report.analysisId) {
      return {
        status: 'rejected',
        code: 'review-operation-conflict',
        message: '该启动操作号已属于另一条分析；复盘必须使用新的操作号',
      };
    }
    return {
      status: 'committed',
      value: {
        ...started.value,
        sourceReportId: report.reportId,
        previousAnalysisId: report.analysisId,
      },
      stateRevision: started.stateRevision,
    };
  }
}
