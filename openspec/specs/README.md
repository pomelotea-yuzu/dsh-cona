# openspec/specs/ · 规范

能力规范。当前内容：

- `workspace-recovery-prototype/spec.md` —— Cona F 系列原文，仅作参考，跨平台语义须重测。
- `plugin-integration/`、`plugin-localization/`、`portable-project-data/`、`project-command-commit/`、`project-conversation-context/`、`project-panel-sync/` —— R1 六份能力规范，2026-11-19 由归档 change `changes/archive/2026-11-19-establish-r1-project-plugin/` 并入（31 个 Requirement／74 个 Scenario）。原归档中 `untested` 的验证状态不因并入主 specs 而改变；实测与未测逐条见该 change 的 `validation-matrix.md` 与 `implementation/2026-11-17-7.3-final-audit.md`。
- `project-overview-resume/` —— R2 首切片能力规范，2026-11-20 由归档 change `changes/archive/2026-11-20-add-project-overview-and-resume/` 并入（6 个 Requirement／13 个 Scenario，纯新增，未修改 R1 规范）。13 个验证场景状态均保持 `untested`、实测证据写入注记，不因并入主 specs 改标 pass；4 个主体完成但留有未实测子项的任务如实保持未勾选。逐条见该 change 的 `validation-matrix.md` 与 `implementation/2026-11-20-archive-final-audit.md`。

口径说明：全仓沿用的「F01–F08」是原 Cona 的**验证用例编号**，本目录收录的是**能力规范**，两者不是一一对应——
`workspace-recovery-prototype/spec.md` 含 7 个 Requirement、12 个 Scenario，未附 F 编号映射。移植到本插件时以规范条目为准，
用例覆盖情况须重新核对，不得据名称推断八个用例都已覆盖。
