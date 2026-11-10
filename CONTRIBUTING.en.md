# Contributing

[简体中文](CONTRIBUTING.md)

## Current scope

Initialized on 2026-11-10 with structure, index and gates only; there is no product code yet. The license and whether external contributions are accepted are still undecided - check with the maintainer before opening a PR.

## Before committing

- Run `node scripts/check-repo.mjs --all` locally; after a fresh clone run `git config core.hooksPath .githooks` once.
- Disposable output goes only to `artifacts/`, runtime data only to `.dsh-cona/`; neither is committed. Hand-written conclusions belong in the matching `docs/` subdirectory.
- Bilingual facade documents are registered in `i18n/docs-manifest.json` and must be updated together.

## Discipline

- Settled decisions live in `docs/knowledge/decisions.md`; do not reopen them inside documents.
- Report unexecuted, untested and blocked items honestly; never present them as passed, and never let a machine PASS replace human acceptance.
- Push and tags belong to the user; agents do not push.
