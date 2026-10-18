# Final Production Package File Ledger (Phase 7A.9R)

- **Tarball File**: `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz`
- **Tarball Size**: 135,731 bytes
- **Tarball SHA-256**: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`
- **Unpacked File Count**: 8 (Strict Whitelist Enforcement)
- **Total Unpacked Bytes**: 576,913 bytes
- **Evidence Classification**: `LOCALLY_EXECUTED_TEST`

## File Ledger

| File Path | Size (Bytes) | SHA-256 | Classification |
|---|---|---|---|
| `LICENSE` | 1,089 | `99922c2a61954f0eaef1591241bcaaac4d3c8984a9866840180d65f7a1ff8101` | `FROZEN_BIT_FOR_BIT` |
| `README.md` | 15,214 | `478320e56539e88cddca40b1cde570e2e7f98bc44e840b1c4515330ef6160bd1` | `CLASS_C_APPROVED_DOCUMENTATION_CORRECTION` |
| `cordis.patch.yml` | 415 | `df9851e21b59cafc69f91b0839c7cd56cb53104c57644813d9001e1a76c7d868` | `FROZEN_BIT_FOR_BIT` |
| `corpus/ecdict.manifest.json` | 566 | `03cba27d42cb43551d7b51fa12e4a07a869c5d4b65ac07f4fa3d105d9c944044` | `FROZEN_BIT_FOR_BIT` |
| `lib/client.js` | 185,043 | `2a1425a94a782cb382ce031dd85d09627eba680f6baac2479dd32127e13e7952` | `FROZEN_BIT_FOR_BIT` |
| `lib/ecdict-integrity-worker.js` | 23,193 | `0d6bda562785797d36e64fa9567125072c6e7626c77c25211ba9dd223294d2b6` | `FROZEN_BIT_FOR_BIT` |
| `lib/index.js` | 345,905 | `f426d1ba68fe548867d46affc028690c6393d571fd77af457cc342ecd49abf2e` | `FROZEN_BIT_FOR_BIT` |
| `package.json` | 5,488 | `e79d9176a09a8ee10f0c0c97c04e12e224c479b002483c0f32ad47dab229f996` | `FROZEN_BIT_FOR_BIT` |

## Packaging Security Checks
- **Dependencies**: 0 runtime dependencies (`dependencies: {}`)
- **Lifecycle Scripts**: 0 (`preinstall`, `install`, `postinstall`, `prepare` absent)
- **Permissions**: Zero credentials, zero commands, zero protectedDsh, zero native binaries, zero dynamic eval (`eval()` / `Function()`).
- **Data Exclusion**: 0 `.db`, 0 `.sqlite`, 0 `.csv`, 0 `.zip` embedded in package. Full ECDICT corpus excluded.
