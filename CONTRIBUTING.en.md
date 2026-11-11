# Contributing

[简体中文](CONTRIBUTING.md)

## Current scope

Initialized on 2026-11-10. As of 2026-11-11, a project management plugin design draft and static DSH integration research are available, with no product code or runtime validation. See the [decision index](docs/knowledge/decisions.md) for the current direction and retained boundaries; specific designs remain under discussion. Licensed under [MIT](LICENSE); check with the maintainer before opening a PR.

## Before committing

- Run `node scripts/check-repo.mjs --all` locally; after a fresh clone run `git config core.hooksPath .githooks` once.
- Repository-local disposable output goes to `artifacts/`; local experiment runtime data may go to `.dsh-cona/`. Neither is committed. Hand-written conclusions belong in the matching `docs/` subdirectory. These locations do not prescribe deployed plugin project storage, which remains to be designed.
- Bilingual facade documents are registered in `i18n/docs-manifest.json` and must be updated together.

## Discipline

- Current direction and settled boundaries live in `docs/knowledge/decisions.md`. Distinguish explicit user requirements from draft proposals, and update indexes when the user changes direction.
- Report unexecuted, untested and blocked items honestly; never present them as passed, and never let a machine PASS replace human acceptance.
- Push and tags belong to the user; agents do not push.
