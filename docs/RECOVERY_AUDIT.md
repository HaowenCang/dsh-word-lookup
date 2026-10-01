# Recovery Audit — `dsh-word-lookup`

```text
RECOVERY AUDIT PASS — CONTINUE FROM PHASE 2
```

## 1. Audit date

2026-10-01 (America/Los_Angeles). Audit performed against the working tree as it
stood on disk, with no reliance on prior conversation state, model memory or
file-name inference. Every "done" claim below cites a re-executed command, a
re-read artifact or a runtime measurement.

## 2. DSH version

| Fact | Value | Source |
| --- | --- | --- |
| DSH | `0.2.0-rc.2` | `dsh --version`, re-read this session |
| Node | `v24.13.0` | `node -v` |
| npm | `11.12.0` | `npm -v` |
| Phase 0 baseline | `0.2.0-rc.2` | `PHASE0_EVIDENCE.md` §1 |

The baseline has **not** drifted: Phase 0 was measured against the same DSH
release that is installed now.

## 3. Project root

```text
E:\Projects\DSHarness\dsh-word-lookup          the implementation (git repo)
E:\Projects\DSHarness\dsh-word-lookup-devkit   the spec/design package (not a repo)
```

The session working directory is the **devkit**. The devkit holds the design
documents, the phase prompts, the frozen scaffold and the Phase 0 probe
artifacts; the sibling directory holds the actual plugin. Both were audited.

## 4. Git branch

`master`.

## 5. HEAD SHA

**None.** The repository has **no commits at all**:

```text
$ git log --oneline --decorate -20
fatal: your current branch 'master' does not have any commits yet
$ git rev-parse HEAD
fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree
$ git remote -v
(no output — no remote configured)
$ git stash list
(empty)
```

This is the single most important structural finding of the audit: **git history
provides no checkpoint evidence whatsoever.** `.git` was initialised on
2026-09-30 05:26, but nothing was ever staged or committed. `.gitignore` states
"Build output is committed on purpose … Phase 1 evidence is recorded against an
exact build", but that intent was never carried out.

Consequence: the recovery baseline had to be rebuilt entirely from the working
tree, the build output and re-executed tests. It was. See §17.

## 6. Working tree state

Clean in the sense that nothing is modified relative to a commit — because there
is no commit. Everything present is untracked. No `.orig`, `.rej`, `.bak` or
conflict markers were found. No stash exists.

## 7. Untracked files

13 top-level entries, all untracked:

```text
.gitignore          cordis.patch.yml    docs/        lib/
package-lock.json   package.json        scripts/     src/
tests/              tsconfig.build.json tsconfig.json
tsdown.config.ts    vitest.config.ts
```

Notable content: `src/` (13 modules), `tests/` (8 spec files), `lib/` (2 bundles +
16 `.d.ts`), `scripts/` (6 files), `node_modules/` (82 packages, installed),
`verify-out/` (gitignored run output).

`docs/` was **empty** before this audit — the project had no report of any kind.
`README.md` does not exist even though `package.json` lists it in `files` (§15).

## 8. Existing Phase 0 evidence

`E:\Projects\DSHarness\dsh-word-lookup-devkit\docs\PHASE0_EVIDENCE.md` — present,
intact, 824 lines, 42 480 bytes, §A–§H with a reproduction section.

**Status: VERIFIED.** Its conclusions (§10 interface contract) match the
implementation field for field (§13). Its `phase0-probe/` artifacts are present
with non-empty JSON outputs and zero-byte stderr files, i.e. the probes ran
cleanly.

Two Phase 0 statements are now **OBSOLETE**, and neither is a defect in Phase 0:

- §1 records the running profile as `web` on `http://127.0.0.1:50001`. The live
  environment has since changed to profile `desktop` on
  `http://127.0.0.1:19387`. The DSH *version* is unchanged.
- §11.2 documents reusing a real session cookie from the daily browser
  (`%TEMP%\dsh-cookie-50001.txt`). That technique is now **prohibited** by the
  isolation rules. It must not be repeated; every test uses the isolated
  instance's launch token instead.

## 9. Existing Phase 1 files

All Phase 1 deliverables named in `prompts/phase-1-foundation.md` are present:

| Deliverable | Path | State |
| --- | --- | --- |
| package metadata / exports / bundle patch | `package.json`, `cordis.patch.yml` | present, conformant |
| client bundle build config | `tsdown.config.ts`, `tsconfig*.json` | present, working |
| host config schema | `src/host/config.ts` | present, conformant |
| exact Fetch route | `src/index.ts`, `src/host/route.ts` | present, conformant |
| request handling | `src/host/lookup.ts`, `src/host/dictionary.ts` | present (stub source) |
| settings client / gate mirror | `src/client/index.tsx` | present, conformant |
| overlay occupant | `src/client/card.tsx` | present, idles to nothing |
| shortcut command | `src/client/index.tsx` | present, conformant |
| selection predicate | `src/client/selection.ts` | present, conformant |
| transport | `src/client/transport.ts`, `src/shared/protocol.ts` | present, document-relative |
| unit tests | `tests/*.spec.ts` | 8 files, 83 tests, all pass |
| build output | `lib/` | present, reproducible |
| Phase 1 report | — | **was missing**; created by this audit |

## 10. Build status

`npm run build` (`tsdown` + `tsc -p tsconfig.build.json`) → **exit 0**.

```text
lib/index.js   14 140 bytes  (host, ESM, target node22)
lib/client.js  28 470 bytes  (client, CJS envelope, target es2022)
lib/types/**   16 declaration files
```

The build is **reproducible**: hashes taken before and after a forced rebuild are
identical.

```text
client.js  D6A219A554103A8ED9E442FDACE8E36C5F748E140C0731A1B592283EA2E84303
index.js   294723B6222A0571D54C3D0E927074DE10A246F07A763EB6DFE4C658B207458A
```

Those hashes are also the ones the 2026-09-30 runtime verification measured, so
that evidence still describes the current tree.

## 11. Test status

`npm run verify` → **PASS** (typecheck, tests, build, then static bundle checks).

```text
PASS  typecheck
PASS  test             8 files, 83 tests, 0 failures
PASS  build
PASS  bundle-static-checks   39/39
verify: PASS
```

Runtime: `npm run test:runtime` against an isolated DSH → **PASS — 64/64 checks**
(§21). Both suites were re-executed during this audit.

## 12. What is VERIFIED

Verified means: re-executed now, or measured on an artifact proven byte-identical
to the current build.

1. **Build reproducibility** — forced rebuild reproduces both bundle hashes.
2. **Client bundle envelope** — `lib/client.js` opens with
   `window.__ModuleLoader__.load({ id: "dsh-word-lookup", factory: … })`, has no
   top-level `import`/`export`, no dynamic import, no second chunk, requires only
   `react` / `react/jsx-runtime`, and bundles React only as an external.
3. **Host/client boundary** — `lib/index.js` is ESM importing only
   `@deepseek-ai/schemastery`; it contains no browser global and no model-provider
   import.
4. **Host Config** — exactly
   `autoDoubleClick: z.boolean().default(false).volatile()` and
   `autoSelection: z.boolean().default(false).volatile()`; two independent
   top-level switches, both default `false`.
5. **Route** — `POST /api/dsh-word-lookup`, `requestBody: 'buffered'`, registered
   on `connection.fetch`; no `rpc.handle`, no `rpc.intercept('/api')`.
6. **Client URL** — document-relative `api/dsh-word-lookup`; the absolute form
   never appears in the client bundle.
7. **Shortcut** — `wordLookup.lookupSelection`, `Primary+Shift+L` on
   `web:windows`, `web:macos`, `desktop:windows`, `desktop:macos`,
   `desktop:linux`, and deliberately **absent** on `web:linux`; no conflict.
8. **No eligible selection → `{ status: 'pass' }`** and the keystroke is not
   swallowed (`defaultPrevented:false`).
9. **Overlay** — `shell.overlay`, id `dsh-word-lookup:card`, order 900, registered
   exactly once, renders nothing while idle, adds **0** nodes outside the overlay.
10. **Selection predicate** — `[data-chat-flow-kind]` scope plus the exact
    composer-exclusion list `input, textarea, select, [contenteditable=""],
    [contenteditable="true"], [role="textbox"]`. `[data-dsh-part="message-body"]`
    is never used.
11. **Settings round trip** — defaults `false`; write → client snapshot updates
    without restart → persisted to the profile patch → survives a full DSH
    restart; the two switches are independent.
12. **Trigger discipline at Phase 1 scope** — with both switches off, repeated
    double-click and drag gestures produced **0** requests; a qualifying selection
    plus the shortcut produced exactly **1**.
13. **No AI/LLM path** — the handler answers from local stub data; no outbound
    provider or network call exists on the route.

## 13. What is IMPLEMENTED BUT UNVERIFIED

Nothing. Every implemented Phase 1 behaviour was either unit-tested locally or
measured in the isolated runtime. There is no Phase 1 code path that rests on
inspection alone.

## 14. What is PARTIAL

**Phase 2 — Selection Engine + Manual Shortcut.** Genuinely started, not finished:

| Phase 2 requirement | State |
| --- | --- |
| read-only `Selection`/`Range` access | DONE |
| conversation scope qualification | DONE |
| composer/interactive-control exclusion | DONE |
| shortcut re-reads and validates the live selection | DONE |
| no selection → `pass`; selection → exactly one mock lookup | DONE |
| auto triggers remain off regardless of switch values | DONE |
| transport spy tests | DONE (`tests/client-runtime.spec.ts`) |
| **save text + rect + gesture metadata** | **MISSING** — the snapshot is `{present, eligible, text, at}`; no rect, no gesture |
| **distinguish drag-select from double-click gesture** | **MISSING** |
| **100 drag + 100 double-click → 0 lookups regression** | **MISSING** |

The code says so itself, in `src/client/index.tsx`:

```ts
// --- selection snapshot only ---
// No lookup is issued from this listener. … Phase 1 has no trigger gate at all,
// so the listener stores and returns.
```

and `runLookup` is typed `origin: 'shortcut'` — a single origin, so nothing but
the command can reach the transport.

Two smaller partial items:

- **`README.md` is missing** while `package.json` `files` lists it, and
  `scripts/check-bundle.mjs` does not notice (it reports "the published file list
  covers the build output" without checking every entry exists).
- **Phase 0's `exampleLimit=2`** appears in `prompts/phase-1-foundation.md` but
  not in the implementation. This is **correct**: Phase 0 §10.2 — the verified
  0.2.0-rc.2 contract, which outranks the prompt per the precedence in §19 —
  specifies exactly two fields, and the product requirement forbids merging or
  extending them. The prompt line should be treated as superseded.

## 15. What is MISSING

1. **Any git commit** (§5). Without one there is no recoverable checkpoint.
2. **`README.md`** in the project root, though `package.json` publishes it.
3. **Phase 2 gesture work** (§14).
4. **Phases 3–8**: no ECDICT/Tatoeba import, no SQLite store, no real dictionary
   (`source: "stub"` is returned by the host), no example limiting, no release
   packaging. None of these were started, and none should be claimed.
5. **A project-local Phase 1 report** — `docs/` was empty. Addressed by this
   audit plus `docs/PHASE1_EVIDENCE.md`.

## 16. What appears obsolete

| Item | Why |
| --- | --- |
| Phase 0 §1 "running profile `web`, port `50001`" | the live profile is now `desktop` on `19387` |
| Phase 0 §11.2 real-session-cookie reuse | prohibited by the isolation rules; launch token only |
| `iso-profile.mjs --sessions` | copied the reader's real session store into a test home; now refused |
| the legacy `%TEMP%\dsh-phase1-iso` / `dsh-phase1-iso2` homes | superseded by `%TEMP%\dsh-word-lookup-test`; retained as evidence, not deleted |
| `prompts/phase-1-foundation.md` `exampleLimit=2` | superseded by the verified Phase 0 §10.2 contract |
| `iso-profile.mjs` as a primary entry point | superseded by `create-test-profile.mjs`; kept only for its scratch-path guard |
| `.gitignore` comment "build output is committed on purpose" | describes an intent that was never executed |

## 17. Evidence of the last trustworthy development checkpoint

```text
last source edit      2026-09-30 05:52:30   src/client/index.tsx
build of that source  2026-09-30 05:52:38   lib/client.js, lib/index.js
original runtime run  2026-09-30 13:03:22Z → 13:03:49Z   PASS 64/64
                       (isolated home %TEMP%\dsh-phase1-iso, profile wlphase1, port 50998)
post-incident re-run  2026-10-01 08:07:32Z → 08:08:00Z   PASS 64/64
                       (isolated home %TEMP%\dsh-word-lookup-test, profile word-lookup-test, port 50991)
local verify          2026-10-01 (this audit)            PASS
                       typecheck + 83 tests + build + 39/39 bundle checks
```

The checkpoint is trustworthy because three independent lines of evidence agree
on the **same artifacts**:

1. the rebuild reproduces the exact hashes the runtime run measured;
2. the 64/64 runtime battery was re-executed today under the new isolation gate
   and passed again;
3. the static verification passes on the same tree.

Build ordering is consistent — the last source edit (05:52:30) precedes the build
(05:52:38), which precedes the first verification (06:03 local). No source file is
newer than the build it was measured against.

**Last trustworthy checkpoint: end of Phase 1, verified on
`lib/client.js` SHA-256 `D6A219A5…` at 2026-10-01T08:08:00Z.**

## 18. Isolation test design

Full plan: [`docs/ISOLATION-TEST-PLAN.md`](ISOLATION-TEST-PLAN.md). Summary:

- **Test root** `%TEMP%\dsh-word-lookup-test`, home `<root>\home`, profile
  `word-lookup-test`, port `50991`.
- **Gate** `scripts/assert-isolated-env.mjs` —
  `assertIsolatedDshEnvironment()` refuses a target unless its resolved
  paths prove it is scratch: home ≠ production home, home not inside production
  home, home under the test root, test root not inside production home, profile
  not `web`/`desktop`/the live profile, profile dir exactly
  `<home>/profiles/<name>`, and port not `19387`/`50001`. Paths are realpath'd and
  case-folded on Windows so junctions and spelling tricks cannot slip past.
- **Environment scrubbing** `buildIsolatedEnv()` strips **every** inherited
  `DSH_*` variable before setting the three the child owns, so a leaked
  `DSH_SESSION_ID`, `DSH_WEB_URL` or `DSH_PROFILE_DIR` cannot reach the child.
- **Entry points** `scripts/create-test-profile.mjs`,
  `scripts/run-integration-test.mjs`, `scripts/cleanup-test-profile.mjs`, and a
  gate added to `scripts/phase1-verify.mjs` and `scripts/profile-install.mjs`.
- **Refusals verified** — the gate is exercised by 14 unit tests
  (`tests/iso-guard.spec.ts`) and by real CLI runs that exit non-zero on
  production targets (§22).
- **Cleanup** requires `--evidence-recorded`, confirms the port is released and
  refuses to delete otherwise.

## 19. Production environment safety confirmation

Read-only inspection only; no production file was written, moved or deleted.

```text
production DSH_HOME                C:\Users\20659\.dsh          read only
live profile                       desktop                       read only
live port                          19387                         never bound by a test
plugin in production profile       absent  (bundleListed=false, dependency=null, link.present=false)
production session data            never read or copied
production loader / routes         never touched
production instance restarted      NO
```

The live profile was confirmed **clean of this plugin** before and after the
audit. Two unrelated DSH processes belonging to other projects
(`tpm-phase94-isolated` on 29617, `mail-notify-v050-web` on 51231) were observed
and deliberately left alone; they are out of scope for this project.

### Incident-scene observations (read-only, nothing modified)

Reading the profile directories — never writing — produced two facts that
corroborate the incident timeline. They are recorded here because they are
evidence, not because anything was done about them:

- `profiles\web\` contains `package.json.before-plugin-restore-20260930-080710.bak`
  and `pnpm-workspace.yaml.before-plugin-restore-20260930-080710.bak`, dated
  2026-09-30 07:58 and 07:52. A plugin restore was therefore attempted on the
  `web` profile at 08:07:10 on 2026-09-30, roughly two hours after the Phase 1
  verification run at 06:03.
- `profiles\web\package.json` and `cordis.yml` carry a 2026-10-01 00:52:09
  timestamp, and `profiles\desktop\cordis.patch.yml` carries 2026-10-01 01:01:35
  — both **before this audit's first command** (01:01:41). Neither timestamp was
  produced by this work; both are the live instance's own activity.

The damaged `web` profile was not repaired, restored, rebuilt or modified, as
instructed. Its backups were read for the timeline only.

## 20. Recommended continuation point

```text
RECOVERY AUDIT PASS — CONTINUE FROM PHASE 2
```

Phase 1 is complete and independently verified; do not rebuild it. Resume **Phase
2** at the point it stopped:

1. extend the selection snapshot with rect plus gesture metadata;
2. distinguish drag-select from double-click without letting a double-click's
   incidental `selectionchange` masquerade as a drag;
3. add the `100 drag + 100 double-click → 0 lookups` regression;
4. keep the two automatic triggers **disabled** — Phase 2 explicitly does not
   enable them;
5. run `npm run verify`, then `npm run test:runtime` (the runner asserts
   isolation first);
6. commit the result — the absence of any commit is the largest residual risk on
   this project.

Do not touch the damaged `web` profile. Do not install into `desktop`.

## 21. Runtime verification record

Executed this session:

```text
$ npm run test:runtime
ISOLATION CHECK: PASS          (runner gate)
ISOLATION CHECK: PASS          (harness gate)
PASS [H01] the isolated DSH Web process started and printed an authenticated URL
           http://127.0.0.1:50991/?token=<redacted>
…
phase1-verify: PASS — 64/64 checks
```

| | value |
| --- | --- |
| isolated home | `C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home` |
| profile | `word-lookup-test` |
| port | `50991` |
| DSH / Node | `0.2.0-rc.2` / `v24.13.0` |
| browser | Chromium `153.0.8010.12` |
| authentication | the isolated instance's own launch token |
| result | **64/64**, `summary.failed = []` |

Both automatic switches defaulted to `false`; with both off, double-click and
drag produced `requests=0`; a qualifying selection plus `Primary+Shift+L`
produced exactly one `POST /api/dsh-word-lookup`; the write persisted to the
isolated profile patch (`autoDoubleClick: false, autoSelection: true`) and
survived a full restart; the plugin added `0` nodes outside `shell.overlay`; and
no console error or duplicate registration appeared across a reload and a restart.

Full detail: [`docs/PHASE1_EVIDENCE.md`](PHASE1_EVIDENCE.md) and
[`docs/evidence/phase1-verification.json`](evidence/phase1-verification.json).

## 22. Damage-prevention changes added by this audit

| Change | Effect |
| --- | --- |
| `scripts/assert-isolated-env.mjs` (new) | the shared gate; seven assertions, path realpath'ing, CLI with `ISOLATION CHECK: PASS` |
| `scripts/assert-isolated-env.d.mts` (new) | types so the gate is covered by `npm run typecheck` |
| `tests/iso-guard.spec.ts` (new, 14 tests) | every refusal is itself tested |
| `scripts/create-test-profile.mjs` (new) | builds the isolated profile; gated; backs up profile files before overwrite |
| `scripts/run-integration-test.mjs` (new) | the only supported runtime entry point; asserts isolation as its first statement |
| `scripts/cleanup-test-profile.mjs` (new) | stops, verifies the port is released, refuses to delete without `--evidence-recorded` |
| `scripts/profile-install.mjs` (hardened) | **install/uninstall now refuse any non-isolated target.** Previously defaulted to `~/.dsh` + `web` with no guard — the likely cause of the incident |
| `scripts/phase1-verify.mjs` (hardened) | gate added; child env built by `buildIsolatedEnv`, stripping inherited `DSH_*` |
| `scripts/iso-profile.mjs` (hardened) | `--sessions` refused; real conversations can no longer be copied into a test home |
| `package.json` (scripts) | `iso:check`, `test-profile:create`, `test:runtime`, `test-profile:cleanup` |
| `docs/evidence/` (new) | runtime evidence copied out of the gitignored `verify-out/` so it survives |

Verified refusals (real runs, non-zero exit):

```text
$ node scripts/profile-install.mjs install                   → exit 2  refused
$ node scripts/profile-install.mjs uninstall --profile web   → exit 2  refused
$ node scripts/assert-isolated-env.mjs --home ~/.dsh --profile desktop --port 19387
                                                             → exit 2, 6 violations
$ node scripts/assert-isolated-env.mjs                       → exit 0  ISOLATION CHECK: PASS
```

`profile-install.mjs status` remains read-only and still works against production,
which is how the live profile was confirmed clean.

## 23. Files changed by this audit

New:

```text
scripts/assert-isolated-env.mjs
scripts/assert-isolated-env.d.mts
scripts/create-test-profile.mjs
scripts/run-integration-test.mjs
scripts/cleanup-test-profile.mjs
tests/iso-guard.spec.ts
docs/RECOVERY_AUDIT.md
docs/ISOLATION-TEST-PLAN.md
docs/PHASE1_EVIDENCE.md
docs/evidence/phase1-verification.json
docs/evidence/phase1-verification-20261001.json
```

Modified:

```text
scripts/profile-install.mjs     isolation gate on install/uninstall
scripts/phase1-verify.mjs       isolation gate + scrubbed child environment
scripts/iso-profile.mjs         --sessions refused; unused imports dropped
package.json                    four safety entry points added
```

Nothing under `src/` was modified: Phase 1's implementation was already correct
and verified, so no production code was touched. `lib/` was regenerated by
`npm run build` and is byte-identical to the previously verified output.

**No commit was made** — the recovery-audit rules forbid it.

## 24. Residual risks

1. **No git commit exists.** One bad delete and the whole implementation is gone.
   This is the largest risk on the project and the first thing to fix.
2. **The gate hard-codes this machine's ports** (`19387`, `50001`). It also reads
   `DSH_WEB_URL`/`DSH_PROFILE` live, so a moved instance is still caught, but the
   constants need revisiting if the daily port changes.
3. **`README.md` is listed in `files` but absent**, and `check-bundle.mjs` does not
   validate every entry of that list.
4. **The 64/64 evidence depends on `docs/evidence/`**, which is currently
   untracked like everything else. Risk 1 covers it.
5. **Phase 1 does not implement the automatic triggers.** Anyone reading only the
   settings UI could believe the switches do something; they persist and are
   mirrored, but no gesture consults them yet.
6. **The damaged `web` profile is still on disk** and is deliberately untouched.
7. **Two unrelated DSH instances** (`tpm-phase94-isolated`, `mail-notify-v050-web`)
   are running. They are out of scope and were left alone.

## 25. Next action

Resume Phase 2 (§14, §20), then commit. Concretely:

1. add rect and gesture metadata to the selection snapshot;
2. discriminate drag-select from double-click;
3. add the 100 + 100 zero-lookup regression;
4. `npm run verify`;
5. `npm run test:runtime` (gated);
6. report the current HEAD — currently *there is none* — and make the first commit.

