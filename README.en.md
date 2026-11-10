# dsh-cona

[简体中文](README.md)

New repository for the DSH (DeepSeek Harness) plugin direction, forked from the sealed **Cona** repository after a change of direction.

## Status

- Initialized on 2026-11-10: repository structure, index and gates only. **No plugin code, no dependencies, no active change.**
- Final direction and sealing decision: [product-decisions.md section 6](docs/product/product-decisions.md).
- Quick reference of decisions still in force: [docs/knowledge/decisions.md](docs/knowledge/decisions.md).
- Reusable behaviour baseline: [workspace recovery spec](openspec/specs/workspace-recovery-prototype/spec.md) (Cona F01-F08, for reference only; path semantics must be retested cross-platform).
- Sealed state of the former repository: [project-status.md](docs/development/project-status.md).

## Direction

- Product form: a DSH plugin providing checkpoints, delivery and rollback only; no standalone desktop agent product.
- No in-house sandbox: isolation and execution are provided by the DSH host.
- Cross-platform plugin: plain Node ESM, no platform-native APIs, no hardcoded drive letters or path separators.
- Development environment: macOS; the data root is set by the plugin's `Config.dataRoot`, value to be decided.

All four points are settled decisions from section 6 of the former repository and are not reopened here.

## Repository and collaboration

- Structure mirrors `~/Developer/layress`; gates, CI, templates and the i18n manifest follow that skeleton, renamed for this repository.
- Remotes: Gitee + GitHub; check `git remote -v` for the actual addresses. Push and tags are performed manually by the user.
- License: [MIT](LICENSE).

## Layout

| Directory | Purpose |
|---|---|
| `docs/` | Documentation, settled decisions and sealing note |
| `openspec/` | Specs and changes |
| `apps/`, `packages/`, `scripts/` | Code, packages and repository gates (code slots are placeholders) |
| `i18n/`, `datasets/`, `artifacts/` | Terminology and manifest, fixtures, disposable output |
