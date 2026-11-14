// 面板字典（tasks 5.4，design §9）：命名空间 `dsh-cona.project`，中英 key 集合与占位符一致。
// zh 为 key 的来源；en 必须覆盖同一集合（`check-locale.mjs` 与类型都核对）。
// 字典只放界面文案：稳定错误码、项目名称、目标与原因保持原文，不翻译、不进入字典。

import type {} from '@deepseek-ai/dsh-client-ui-slots';
import zh from './locales/zh.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };

/** Remote／字典共用的命名空间。 */
export const NS = 'dsh-cona.project';

export type LocaleKey = keyof typeof zh;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 面板文案命名空间。 */
    'dsh-cona.project': LocaleKey;
  }
}

/** 中文为 key 源；英文缺 key 或类型不符在编译期与检查脚本两处失败。 */
export const dictionaries: { zh: Record<LocaleKey, string>; en: Record<LocaleKey, string> } = {
  zh: zh as Record<LocaleKey, string>,
  en: en as Record<LocaleKey, string>,
};
