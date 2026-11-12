# dsh-cona

[简体中文](README.md)

A project management plugin primarily for software development, using DSH (DeepSeek Harness) as its agent foundation, following a change of direction from the sealed **Cona** repository.

## Status

- As of 2026-11-12: project management design, revised architecture, development roadmap, i18n and data collaboration drafts, and static DSH research are available, with `0.2.2-rc.2` fixed as the baseline. **No plugin code, installed dependencies or active change; integration has not been tested at runtime.**
- Current requirements and proposals: [project management design draft](docs/product/2026-11-11-project-management-design.md). The direction is confirmed; usage flows and implementation remain under discussion.
- Initial architecture: [project development architecture draft](docs/architecture/2026-11-11-project-development-architecture.md), covering research, ongoing analysis, project trees and chat continuity. Defaults will be refined through practical use.
- Current direction and retained boundaries: [docs/knowledge/decisions.md](docs/knowledge/decisions.md).
- Host integration evidence: [DSH project management integration review](docs/research/2026-11-11-dsh-project-management-review.md) (static research).
- Historical transition and sealing decision: [product-decisions.md section 6](docs/product/product-decisions.md); its restriction to file recovery capabilities has been superseded by the current direction.
- File recovery reference: [workspace recovery spec](openspec/specs/workspace-recovery-prototype/spec.md) (Cona F01-F08; no commitment to current product scope; cross-platform path semantics must be retested if ported).
- Sealed state of the former repository: [project-status.md](docs/development/project-status.md).

## Direction

- Product form: a DSH project management plugin with a dynamic project tree primarily organizing software development and related documentation. Occasional needs such as video production can be added to a project as needed.
- The interface and project logic are integrated into DSH, with an internal project entry linked to host chats. No separate website, application or backend deployment is required.
- Support preset and user-defined processes, file scaffolds applied at creation or later stages, and templates extracted from existing projects.
- Users can edit the project tree directly, arranging stages and inserting or combining process blocks. Detailed interactions await practical validation.
- Stages and chats have many-to-many relationships. Agents can adjust plans in response to new information; interaction and authorization policies remain under discussion.
- Preserve integration boundaries for a future official Super-agent without building an agent scheduler in this round. File recovery does not drive the architecture.
- No standalone desktop agent product or in-house sandbox. Reuse DSH execution and isolation; a plugin's Host-side file access must not be assumed to inherit session sandbox protection.
- Cross-platform plugin: plain Node ESM, no platform-native APIs, no hardcoded drive letters or path separators.
- Development environment: macOS. Users can store project material in the project directory, the DSH data directory, or a custom directory. Requirements include Git collaboration across environments, readability by other agents, and continuation in DSH on another machine. The [separation of portable material and local runtime data](docs/architecture/2026-11-12-project-data-portability.md) awaits implementation and validation.
- The project tree and goal/time roadmap views share one plan. The first version will fully support Simplified Chinese and English UI, with English fallback for other host languages. The overall direction is confirmed; interaction and format details remain to be refined.

The design draft distinguishes explicit user requirements from proposals. Updating the indexes does not finalize the entire design.

## Repository and collaboration

- Structure mirrors the layress repository skeleton; gates, CI, templates and the i18n manifest follow that skeleton, renamed for this repository.
- Remotes: Gitee + GitHub (currently a single `origin` with two push URLs; check `git remote -v` for the actual configuration). Push and tags are performed manually by the user.
- License: [MIT](LICENSE).

## Layout

| Directory | Purpose |
|---|---|
| `docs/` | Documentation, settled decisions and sealing note |
| `openspec/` | Specs and changes |
| `apps/`, `packages/`, `scripts/` | Code, packages and repository gates (code slots are placeholders) |
| `i18n/`, `datasets/`, `artifacts/` | Terminology and manifest, fixtures, disposable output |
