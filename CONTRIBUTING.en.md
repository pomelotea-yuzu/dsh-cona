# Contributing

[简体中文](CONTRIBUTING.md)

## Current scope

Initialized on 2026-11-10. As of 2026-11-12, project management design, architecture, roadmap, i18n and data collaboration drafts, and static DSH research are available, with no product code or runtime validation. See the [decision index](docs/knowledge/decisions.md) for the current direction and retained boundaries; implementation details await practical refinement. Licensed under [MIT](LICENSE); check with the maintainer before opening a PR.

## Before committing

- Leave a newly written change uncommitted for another agent's review, arranged by the user. The reviewer writes `review.md` inside the change; the author reads it, revises the change, records the disposition of each finding, and reruns checks before committing. See the [change workflow](docs/development/workflow.md).
- Run `node scripts/check-repo.mjs --all` locally; after a fresh clone run `git config core.hooksPath .githooks` once.
- Repository-local disposable output goes to `artifacts/`; local experiment runtime data may go to `.dsh-cona/`. Neither is committed. Hand-written conclusions belong in the matching `docs/` subdirectory. These conventions do not prescribe deployment directories. Users can choose among three project material locations; see the [collaboration design](docs/architecture/2026-11-12-project-data-portability.md) for portable versus local data. The format is not yet implemented.
- Bilingual facade documents are registered in `i18n/docs-manifest.json` and must be updated together.

## Discipline

- Current direction and settled boundaries live in `docs/knowledge/decisions.md`. Distinguish explicit user requirements from draft proposals, and update indexes when the user changes direction.
- Report unexecuted, untested and blocked items honestly; never present them as passed, and never let a machine PASS replace human acceptance.
- Push and tags belong to the user; agents do not push.
