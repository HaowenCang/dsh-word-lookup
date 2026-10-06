# Changelog

All notable changes to this project are documented in this file.

## 0.2.0 — Unreleased

Development checkpoint for Phase 7A (managed dictionary lifecycle and in-app settings UX).

### Added

- Added DictionaryManager-backed active dictionary lifecycle and atomic hot switching.
- Expanded Host configuration model (`dictionaryMode`, `customDictionaryPath`, `autoDoubleClick`, `autoSelection`) with Schemastery `.volatile()` declarations compatible with DSH Settings `ctx.configForms`.
- Dedicated typed configuration readers (`readSwitch`, `readDictionaryMode`, `readCustomDictionaryPath`).
- Foundation for managed dictionary storage, downloader, and custom SQLite selection.

### Changed

- Development version transitioned to 0.2.0 (unreleased development target; latest published release remains 0.1.0).
- Active host runtime strictly initializes the deterministic fixture dictionary during Phase 7A.1 architectural transition.

### Removed

- Permanently removed legacy `DSH_WORD_LOOKUP_DB_PATH` environment variable database activation across host runtime and startup.
- Eliminated static `process.env` access from the active package runtime, clearing the DSH Store permission `credentials` signal (`credentials: false`).

## 0.1.0 — 2026-10-05

Initial public release.

### Added

- Local English-Chinese dictionary lookup for DSH Web.
- Primary manual lookup shortcut: `Primary+Shift+L`.
- Opt-in automatic double-click and drag-selection lookup, both disabled by default.
- Local SQLite dictionary engine with exact-entry, inflection-form, phrase, and example lookup.
- Result card with phonetic transcription, part of speech, Chinese meanings, forms, examples, viewport-safe positioning, dismissal, accessibility, and latest-request-wins behavior.
- Explicit production ECDICT database activation through `DSH_WORD_LOOKUP_DB_PATH` with strict provenance, schema, index, metadata, and integrity gates.
- Deterministic production-corpus build and verification tooling.
- Isolated runtime, browser acceptance, packaging, credential, and distribution-safety verification.

### Security and privacy

- No intentional AI fallback or model-provider lookup path.
- No remote dictionary API.
- Full ECDICT corpus is not committed to Git and is not included in the npm package.
- Explicit production database activation fails closed rather than silently falling back.

### Known limitations

- `autoSelection` portability across unmeasured operating systems, display servers, DPI settings, and platform multi-click configurations remains unresolved. It is opt-in and defaults to off.
- The npm package does not redistribute the full ECDICT corpus. Production-corpus use requires a separately obtained or built compatible local database.
- DSH Web `0.2.0-rc.2` is the verified host baseline; the desktop client is not a tested target.
