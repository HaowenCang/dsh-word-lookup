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
| profile | `word-lookup-test`, never `web` or `desktop` |
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
%TEMP%\dsh-word-lookup-test\                 test root
  home\                                      isolated DSH_HOME
    profiles\word-lookup-test\               isolated profile
      cordis.yml                             [] (tree is composed as patches)
      cordis.patch.yml                       webserver port override only
      package.json                           bundles + link: dependency
      node_modules\dsh-word-lookup\          junction -> E:\Projects\DSHarness\dsh-word-lookup
    .profile-backup\<stamp>\                 profile files copied before a re-create
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
| `scripts/cleanup-test-profile.mjs` | stop and remove the environment (gated) |
| `scripts/phase1-verify.mjs` | the measurements themselves (gated) |
| `scripts/profile-install.mjs` | install/uninstall a profile entry (gated) |

npm entry points:

```powershell
npm run iso:check              # assert the canonical target is isolated + port free
npm run test-profile:create    # create the isolated profile
npm run test:runtime           # run the measurement suite against it
npm run test-profile:cleanup -- --evidence-recorded
```

## 6. The gate

`assertIsolatedDshEnvironment()` refuses a target unless it proves that:

1. the target `DSH_HOME` is not the production home;
2. the target `DSH_HOME` is not *inside* the production home;
3. the target `DSH_HOME` lives under the test root;
4. the test root does not itself resolve into the production home;
5. the profile name is neither the live profile nor `web` / `desktop`;
6. the profile directory is `<home>/profiles/<name>` and inside the test root;
7. the port, when one is bound, is a valid high port and not a production port.

Production facts are read from the environment rather than hard-coded: the live
GUI URL supplies the port in use, `DSH_PROFILE` names the profile loaded, and
`~/.dsh` plus the `19387` / `50001` history are always forbidden. Paths are
realpath'd and case-folded on Windows so that a junction or a mixed-case
spelling cannot smuggle a production path past the comparison.

On failure the gate prints every violation and exits non-zero. Callers must not
catch it and continue.

`buildIsolatedEnv()` additionally **strips every inherited `DSH_*` variable**
before setting the three the child owns. Inheriting `DSH_SESSION_ID`,
`DSH_WEB_URL` or `DSH_PROFILE_DIR` would hand the isolated instance a pointer to
real state even though `DSH_HOME` had been replaced.

## 7. Invocation sequence

```powershell
# 1. gate + build the profile
npm run iso:check
npm run test-profile:create

# 2. run (the runner re-asserts isolation as its first statement)
npm run test:runtime
#    prints: ISOLATION CHECK: PASS

# 3. copy the results into docs/ BEFORE cleaning up
#    verify-out/phase1-verification.json is local-only and gitignored

# 4. clean up
npm run test-profile:cleanup -- --evidence-recorded
```

The launch URL used by the measurement browser is the isolated instance's own
launch token — `http://127.0.0.1:50991/?token=<isolated-token>`. No cookie is
read from, or shared with, any other browser session.

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

Before any run that can touch the profile or loader tree, the profile's
`package.json`, `cordis.yml` and `cordis.patch.yml` are copied to
`<test home>\.profile-backup\<stamp>\`. If the isolated instance crashes, only
the isolated environment is repaired or rebuilt. Switching back to the real
profile to "finish the verification" is prohibited.

## 10. Cleanup protocol

1. the isolated DSH process is stopped;
2. no orphan process remains and the test port is free (the cleanup script
   verifies this and refuses to proceed otherwise);
3. the run report is saved and its conclusions written into `docs/`;
4. temporary browser state is deleted;
5. only then is the test home removed, and only with `--evidence-recorded`.

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
