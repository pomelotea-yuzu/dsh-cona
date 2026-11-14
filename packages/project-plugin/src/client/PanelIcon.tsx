// 侧栏入口图标（tasks 5.2）：极简内联图形，不额外引入 UI 基础包。
// 侧栏负责按钮、label 与选中态，本组件只画图形。

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';

export function ConaPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor" opacity="0.85" />
      <rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor" opacity="0.35" />
    </svg>
  );
}
