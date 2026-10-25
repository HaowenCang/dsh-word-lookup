# Isolation Test Plan

Status: **ACTIVE** — every DSH runtime test in this project must follow this plan.

## 1. Why this plan exists

A previous development round ran a plugin test against the profile the reader was
using and destroyed it; conversation files in that profile were lost. The cause
was structural, not accidental: `scripts/profile-install.mjs` defaulted to
`DSH_HOME ?? ~/.dsh` with `DSH_PROFILE ?? 'web'`, so an ordinary
`npm run profile:install` from an ordinary shell edited the live profile with
nothing standing in the way.

This plan replaces "be careful" with a gate that fails closed.

## 2. Hard rules

**Never**, for any reason, however small the change looks and however easily it
could "be reverted afterwards":

- start, inject into, register routes on, write settings to, or restart the DSH
  instance the reader is using;
- edit the production profile's `package.json`, `cordis.yml`,
  `cordis.patch.yml`, `node_modules`, loader tree, routes or browser module table;
- change `DSH_HOME` for a test to point at real state;
- read or reuse a real session cookie;
- copy a real conversation into a test environment;
- kill an unknown process to take a port.

If a step can only be completed by modifying the real environment, **stop and
report BLOCKED**. That step does not get done.

## 3. Isolation requirements

A test environment is only valid when all of these hold:

| Property | Requirement |
| --- | --- |
| `DSH_HOME` | a scratch directory under the test root |
| profile | `word-lookup-test`, never `web`, `desktop` or `default` |
| profile directory | `<test home>/profiles/word-lookup-test` |
| port | `50991` or another free high port; never `19387` / `50001` |
| profile `package.json` | owned by the test environment |
| cordis patch | owned by the test environment |
| `node_modules` | a junction to this repo, inside the test environment |
| sessions | created by the isolated instance only |
| credentials | minted by the isolated launch token only |
| process | a separate `dsh` child, never the running one |

Reuse of read-only material is allowed **by copy only**. Junctions, symlinks and
hardlinks may not point at any writable state of the real profile.

## 4. Layout

```text
%TEMP%\dsh-word-lookup-test-<run-id>\        exclusive test root
  .dsh-test-owner.json                       ownership record (not cleanup authority)
  home\                                      isolated DSH_HOME
    profiles\word-lookup-test\               isolated profile
      cordis.yml                             [] (tree is composed as patches)
      cordis.patch.yml                       webserver port override only
      package.json                           bundles + link: dependency
      node_modules\dsh-word-lookup\          junction -> E:\Projects\DSHarness\dsh-word-lookup
    sessions\                                isolated session store
    .credentials.yaml                        isolated launch credentials
  home\...                                   the 50991 instance only
```

Nothing in the test root is committed. `verify-out/` is a local evidence
directory and is intentionally gitignored; report conclusions therefore have to
be written into `docs/` to survive.

## 5. Scripts

| Script | Role |
| --- | --- |
| `scripts/assert-isolated-env.mjs` | the gate; `assertIsolatedDshEnvironment()` |
| `scripts/create-test-profile.mjs` | build the isolated profile (gated) |
| `scripts/run-integration-test.mjs` | the only supported runtime entry point (gated) |
| `scripts/cleanup-test-profile.mjs` | verify stopped environment and remove the owned home/root; never stops processes |
| `scripts/isolated-run-directory.mjs` | exclusive creation, runtime capability, token verification and safe recursive cleanup |
| `scripts/phase1-verify.mjs` | the measurements themselves (gated) |
| `scripts/profile-install.mjs` | install/uninstall a profile entry (gated) |

npm entry points:

```powershell
npm run iso:check              # assert the canonical target is isolated + port free
# Use the explicit run root/token sequence below for create, runtime and cleanup.
```

## 6. The gate

`assertIsolatedDshEnvironment()` refuses a target unless it proves that:

1. the target `DSH_HOME` is not the production home;
2. the target `DSH_HOME` neither contains nor is inside a production home;
3. the target `DSH_HOME` lives under the test root;
4. the test root neither contains nor resolves inside any production home;
5. the profile name is neither the live profile nor `web` / `desktop` / `default`;
6. the profile directory is `<home>/profiles/<name>`, inside the test root, and disjoint in both directions from production;
7. the port, when one is bound, is a valid high port and not a production port.

Production facts are read from the environment rather than hard-coded: the live
GUI URL supplies the port in use, `DSH_PROFILE` names the profile loaded, and
`~/.dsh` plus the `19387` / `50001` history are always forbidden. Paths are
resolved using the nearest existing ancestor's realpath, then genuinely missing
suffixes are appended. Windows comparisons fold case and use separator boundaries.
An absent leaf cannot hide an existing junction. Only ENOENT permits ancestor
lookup; permissions, ENOTDIR, broken links and resolution failures refuse the run
with the offending path and error code.

On failure the gate prints every violation and exits non-zero. Callers must not
catch it and continue.

`buildIsolatedEnv()` additionally **strips every inherited `DSH_*` variable**
before setting the three the child owns. Inheriting `DSH_SESSION_ID`,
`DSH_WEB_URL` or `DSH_PROFILE_DIR` would hand the isolated instance a pointer to
real state even though `DSH_HOME` had been replaced.

## 7. Invocation sequence

```powershell
# 1. select a new, nonexistent root and create the profile
$runRoot = Join-Path $env:TEMP ("dsh-word-lookup-test-" + [guid]::NewGuid())
npm run iso:check -- --test-root $runRoot
npm run test-profile:create -- --test-root $runRoot
# Save CLEANUP_TOKEN from the create output outside $runRoot:
$cleanupToken = '<the independently printed 64-character token>'

# 2. run (the runner re-asserts isolation as its first statement)
npm run test:runtime -- --test-root $runRoot
#    prints: ISOLATION CHECK: PASS

# 3. copy the results into docs/ BEFORE cleaning up
#    verify-out/phase1-verification.json is local-only and gitignored

# 4. confirm every owned process/worker has exited, then clean up
npm run test-profile:cleanup -- --test-root $runRoot --cleanup-token $cleanupToken --evidence-recorded --processes-exited
```

The launch URL used by the measurement browser is the isolated instance's own
launch token — `http://127.0.0.1:50991/?token=<isolated-token>`. No cookie is
read from, or shared with, any other browser session.

### TEST-001 ownership and deletion contract

`--test-root` denotes the exact target. Creation uses exclusive mkdir and an
exclusive marker; existing directories are refused, even if otherwise isolated.
There is no marker adoption or automatic rebuild. The actual home must be a direct
child of the newly owned root. Default create/release roots use random run IDs.
Old directories without independently issued ownership tokens remain in place.

The helper holds an opaque runtime capability in a WeakMap, including the original
path, canonical path, nonce, root/marker identity and, for profile creation, home
identity. Serializing a capability does not reproduce it. To preserve the separate
create/cleanup CLI workflow, `reopenOwnedTestRoot({requestedRoot, token, env})`
accepts an independently supplied random token and validates its hash against the
marker, canonical path and directory identities. Reading a marker without the
token grants no cleanup authority. The token is sensitive deletion authority: keep
it outside the test root and out of committed reports.

Cleanup rereads the marker, verifies nonce/content and identities, reruns both
directions of production overlap checks, and inspects links without traversing
their targets. Production or dangling links, changed roots/homes/markers, unknown
capabilities and parsing/permission errors preserve the directory. The profile CLI
checks the actual home before deleting it, requires evidence confirmation and
explicit caller confirmation that all owned processes have exited, and independently
checks that the selected port is free. It never terminates an unknown process.
Port freedom alone does not establish that workers have exited.

The v0.2.1 release runner tracks every DSH child it spawns. Its actual cleanup
function refuses when any child exit is unconfirmed or a selected port is occupied.
Evidence directories must be separate from the scratch root and production, and
must be new independent run directories. Reports use exclusive writes; evidence
names cannot escape that directory. `--keep-evidence` retains the owned scratch
root. A failed setup or uncertain shutdown retains scratch data for review.

This protects controlled local test directories. User-space checks followed by
recursive deletion do not eliminate every race against malicious concurrent path
replacement. Historical probes inherit the strengthened production-path gate, but
their individual ownership/lifecycle implementations have not all been migrated;
this change does not authorize running them against real DSH state.

## 8. Test data policy

Only synthetic sessions may be used. A fixture conversation is created inside
the isolated instance, for example:

```text
User:
The conservation law can be derived from symmetry.

Assistant:
This sentence contains several useful physics terms.
```

Real transcripts are never copied in. `iso-profile.mjs --sessions` was removed
for this reason: it copied the reader's session store into the test environment.

## 9. Crash handling

Profile creation exclusively creates a new run root and home; it does not
overwrite an existing profile or create automatic `.profile-backup` copies.
If the isolated instance crashes, retain the failed run and its evidence, then
create a separate new run for further verification. The cleanup token does not
authorize overwriting or rebuilding an existing run. Switching back to the real
profile to "finish the verification" is prohibited.

## 10. Cleanup protocol

1. the isolated DSH process is stopped;
2. the caller confirms every owned process and worker has exited; the cleanup
   CLI requires `--processes-exited` and independently checks the test port,
   but cannot infer all worker exits from port freedom;
3. the run report is saved and its conclusions written into `docs/`;
4. temporary browser state is deleted;
5. only then are the owned home and root removed, with the separately supplied
   `--cleanup-token`, `--evidence-recorded` and `--processes-exited`.

Cleanup never touches a path the gate has not accepted, and never touches any
real DSH file.

## 11. Closing confirmation

Every runtime test reports:

```text
production DSH profile touched: NO
production session data touched: NO
production port touched: NO
production loader touched: NO
production routes touched: NO
```
