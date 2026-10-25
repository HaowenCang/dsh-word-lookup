# v0.2.2 GitHub publication and npm handoff

**GitHub: PUBLISHED. npm: OWNER MANUAL UPLOAD; the agent did not execute npm publish.**

- URL: https://github.com/HaowenCang/dsh-word-lookup/releases/tag/v0.2.2
- Published at: 2026-10-25T14:27:55Z
- Source commit: `080085b21c15f85bb93a6af8847353e2b1992451`. Annotated `v0.2.2` remains pinned to that source commit; this publication ledger is committed separately.
- Public release, draft=false, prerelease=false, GitHub latest=v0.2.2.
- Four uploaded assets were downloaded from GitHub and all SHA-256 hashes matched the local originals.
- Tarball: `build/release-v0.2.2/dsh-word-lookup-0.2.2.tgz`, 147304 bytes.
- Tarball SHA-256: `30b46d3c8dcf356c29b763c62882eb882a363d49ee0afb27201d25e0b2c08b45`.
- Registry read-only check: {"status":"VERIFIED_READ_ONLY","checkedAt":"2026-10-25T14:31:31.349Z","latest":"0.2.1","version022Exists":false,"agentExecutedNpmPublish":false}.

## Local PowerShell command

```powershell
npm login --registry https://registry.npmjs.org/
npm publish "E:\Projects\DSHarness\dsh-word-lookup\build\release-v0.2.2\dsh-word-lookup-0.2.2.tgz" --access public --tag latest --registry https://registry.npmjs.org/ --ignore-scripts
```

Skip login if already authenticated. Complete the interactive 2FA prompt locally. `publish-npm.ps1` is an alternative asset: keep it beside the tarball; it verifies SHA-256 and optionally accepts an OTP parameter. The agent parsed this script but did not execute it.

Validation remains 1739 passing tests (70 files; legacy P01-P07 excluded) and 22/22 isolated Web checks. The earlier 34 long-root failures, 262-character path diagnostic and Windows boundary probes are retained. Code and assertions were unchanged in the successful shorter-root rerun; one extra blank EOF in a new test was normalized before source freeze without changing its statements.

Archived evidence uses scoped `-text -whitespace` attributes so Git preserves raw log bytes and historical whitespace; 233 archived hashes were checked against the release source commit. LICENSE differs only by CRLF normalization between Windows payload bytes and its canonical Git blob, explicitly recorded in the manifest.

Desktop, rollback, other runtimes/full corpus remain unverified. The upstream live-browser reconnect error and measured Windows SQLite full-path <260 constraint are disclosed in release notes. No production DSH profile/session/credential/corpus operations were performed.
