# Phase 7A.10 — npm Release Preflight Audit Report

- **Package**: `dsh-word-lookup@0.2.0`
- **Execution Date**: 2026-10-18
- **Release Engineer**: Gemini 3.8 Flash High (Release Engineering & Authorization Gate)
- **Status**: `PASS` (Interactive 2FA OTP marked `REQUIRES_USER_ACTION` upon publication)

---

## 1. Executive Preflight Summary

This preflight audit evaluates the npm registry environment, authentication posture, package identity, tarball integrity, and release immutability constraints prior to authorization of `dsh-word-lookup@0.2.0`.

All checks were conducted using read-only operations with **zero publication side-effects**.

| Verification Item | Standard / Expected Value | Measured Value | Status |
|---|---|---|---|
| **npm Registry** | `https://registry.npmjs.org/` | `https://registry.npmjs.org/` | **PASS** |
| **npm Account Identity** | Authenticated publish maintainer | `evan-williams` | **PASS** |
| **Package Access / Collaborator Role** | `read-write` on `dsh-word-lookup` | `{"evan-williams": "read-write"}` | **PASS** |
| **Published Versions Ledger** | `0.2.0` must NOT exist | `["0.0.0-stage", "0.1.0"]` | **PASS** |
| **Release Version Availability** | `0.2.0` available for publish | Available (`0.2.0` not in registry) | **PASS** |
| **2FA / Authentication Enforcement** | Disclose OTP / token requirement | `tfa.mode: "auth-and-writes"` | **REQUIRES_USER_ACTION** |
| **Tarball Byte Size** | `135731 bytes` | `135731 bytes` | **PASS** |
| **Tarball SHA-256 Hash** | `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` | Identical match | **PASS** |
| **Tarball SHA-1 (shasum)** | `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3` | Identical match | **PASS** |
| **npm Integrity (SHA-512 Base64)** | `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==` | Computed & verified | **PASS** |
| **Tarball File Whitelist** | Strict 8 files | 8 files (0 symlinks, 0 hidden) | **PASS** |
| **Lifecycle Scripts Audit** | Zero install/postinstall/preinstall | None present | **PASS** |
| **Credential & DB Hygiene** | Zero tokens, DBs, temp files | Clean (0 secrets, 0 database files) | **PASS** |
| **DSH Compatibility Descriptor** | `0.2.0-rc.2`, Web profile | Verified in tarball `package.json` | **PASS** |

---

## 2. Command-Level Audit Verification

### 2.1 Registry & Identity Inspection
- **Command**: `npm config get registry`
  - Output: `https://registry.npmjs.org/`
- **Command**: `npm whoami`
  - Output: `evan-williams`
- **Command**: `npm access list collaborators dsh-word-lookup --json`
  - Output:
    ```json
    {
      "evan-williams": "read-write"
    }
    ```
- **Finding**: Account `evan-williams` is actively authenticated and possesses explicit `read-write` publishing authorization over `dsh-word-lookup`.

### 2.2 Version Ledger & Dist-Tags Inspection
- **Command**: `npm view dsh-word-lookup versions --json`
  - Output:
    ```json
    [
      "0.0.0-stage",
      "0.1.0"
    ]
    ```
- **Command**: `npm view dsh-word-lookup dist-tags --json`
  - Output:
    ```json
    {
      "latest": "0.1.0"
    }
    ```
- **Finding**: Version `0.2.0` has never been published to the registry. The version namespace is completely available and safe for publication.

### 2.3 Two-Factor Authentication (2FA) Posture
- **Command**: `npm profile get --json` (sanitized)
  - `tfa.mode`: `"auth-and-writes"`
  - `name`: `"evan-williams"`
  - `email_verified`: `true`
- **Impact Analysis**:
  Because `tfa.mode` is configured to `auth-and-writes`, registry write operations (specifically `npm publish`) are rejected by the registry unless accompanied by a valid second-factor one-time password (OTP) or an authorized granular access token configured for automation bypass.
- **Action Requirement**:
  At publication execution time, the operator must provide `--otp=<code>` or authenticate with an authorized token. This requirement is formally designated as `REQUIRES_USER_ACTION`.

---

## 3. Candidate Package Tarball Metadata & Security Audit

### 3.1 Candidate Package Identity
Inspected directly from `package/package.json` unpacked from `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz`:
- `name`: `"dsh-word-lookup"`
- `version`: `"0.2.0"`
- `type`: `"module"`
- `license`: `"MIT"`
- `engines`: `{"node": ">=22"}`
- `main`: `"./lib/index.js"`
- `exports`:
  - `.` -> `"./lib/index.js"`
  - `./client` -> `"./lib/client.js"`
  - `./package.json` -> `"./package.json"`
- `publishConfig`: `{"access": "public"}`
- `peerDependencies`:
  - `@deepseek-ai/cordis`: `"~4.0.4"`
  - `@deepseek-ai/schemastery`: `"~3.18.4"`
  - `react`: `"^18.2.0"`
- `dsh`:
  - `pluginType`: `"feature"`
  - `client.platform`: `"web"`
  - `client.inject`: Layout, Renderer, Shortcuts, Settings, Locale
  - `compatibility.dsh`: `"0.2.0-rc.2"`
  - `compatibility.profiles`: `["web"]`

### 3.2 Lifecycle Script Invariance
The `scripts` block contains only development, test, verify, and fixture building tooling.
- `install`: **ABSENT**
- `postinstall`: **ABSENT**
- `preinstall`: **ABSENT**
- `prepublish`: **ABSENT**
- `prepare`: **ABSENT**
- **Conclusion**: The package contains zero arbitrary code execution hooks upon consumer installation (`npm install dsh-word-lookup`).

### 3.3 Archive Member Security & Hygiene
Tarball members verified by archive streaming:
1. `package/LICENSE` (1089 B)
2. `package/README.md` (15214 B)
3. `package/cordis.patch.yml` (415 B)
4. `package/corpus/ecdict.manifest.json` (566 B)
5. `package/lib/client.js` (185043 B)
6. `package/lib/ecdict-integrity-worker.js` (23193 B)
7. `package/lib/index.js` (345905 B)
8. `package/package.json` (5488 B)

- **Total Unpacked Regular Files**: 8
- **Symlinks / Hardlinks**: 0
- **Path Traversals**: 0
- **Credentials / Tokens / Keys**: 0
- **SQLite / Database files**: 0 (Full ECDICT corpus is strictly excluded; deterministic fixture is built locally or downloaded on user demand)

---

## 4. npm Immutability & Re-publication Policy Rules

1. **Version Immutability**:
   Once `dsh-word-lookup@0.2.0` is published to npm, the registry permanently locks version string `0.2.0`. It cannot be re-published or replaced with an altered tarball under the same version number.
2. **Prohibition of Deletion as Rollback**:
   Under npm registry policy, `npm unpublish` is strictly restricted (time-limited to 72 hours, subject to downstream dependency rules, and does not allow re-using the same version). In the event of a post-release defect, the recovery action is to publish a forward patch (`0.2.1`), never to unpublish and re-issue `0.2.0`.
3. **Publication Input Discipline**:
   Publication MUST execute using the pre-built, bit-for-bit verified tarball:
   `npm publish build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz --access public`
   The operator MUST NOT run `npm publish` from the workspace root or rebuild the tarball, ensuring absolute provenance and hash preservation.

---

## 5. npm Preflight Conclusion

```text
NPM_REGISTRY_VERIFIED = PASS
NPM_MAINTAINER_AUTHORIZED = PASS
NPM_VERSION_0_2_0_AVAILABLE = PASS
NPM_2FA_REQUIREMENT = REQUIRES_USER_ACTION (OTP required at publish)
NPM_PACKAGE_MANIFEST_STRICT_PASS = PASS
NPM_LIFECYCLE_SCRIPTS_CLEAN = PASS
NPM_TARBALL_SHA256_MATCH = PASS
OVERALL_NPM_PREFLIGHT = PASS
```
