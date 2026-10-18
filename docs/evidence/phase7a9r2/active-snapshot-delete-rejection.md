# RC-C Active Snapshot Deletion Protection Audit Report

## 1. Executive Summary
- **Probe**: RC-C (`scripts/probes/phase7a9/rc-c-multi-snapshot-ui.mjs`)
- **Gate**: `RC_C_ACTIVE_SNAPSHOT_PROTECTION`
- **Verdict**: **PASS**
- **Tested Active Snapshot**: `6a30d59e-a505-4047-8bbb-5254b985ddcb` (`dict-beta`)
- **Execution Date**: 2026-10-18T07:28:39.353Z

---

## 2. Production Endpoint Invocation & HTTP Protocol Conformance
In contrast to prior defective probes that invoked unregistered routes (`api/dsh-word-lookup/remove-custom`) without request bodies resulting in false-positive HTTP 404 responses, Phase 7A.9R2 invokes the canonical, registered production endpoint:

```http
POST /api/dsh-word-lookup/dictionary/remove-custom HTTP/1.1
Content-Type: application/json
Accept: application/json

{"snapshotId": "6a30d59e-a505-4047-8bbb-5254b985ddcb"}
```

### Actual Observed HTTP Response:
```json
{
  "status": 409,
  "ok": false,
  "headers": {
    "contentType": "application/json; charset=utf-8"
  },
  "body": {
    "ok": false,
    "error": "SNAPSHOT_ACTIVE",
    "message": "Cannot remove currently active custom dictionary snapshot \"6a30d59e-a505-4047-8bbb-5254b985ddcb\". Switch to another dictionary before removing."
  }
}
```

### Protocol Assertions:
| Assertion | Expected | Actual | Verdict |
|---|---|---|---|
| HTTP Status | `409` | `409` | PASS |
| `response.ok` | `false` | `false` | PASS |
| `response.body.ok` | `false` | `false` | PASS |
| `response.body.error` | `"SNAPSHOT_ACTIVE"` | `"SNAPSHOT_ACTIVE"` | PASS |

---

## 3. UI Gating Verification
- **Target Row**: `[data-testid="custom-snapshot-row-6a30d59e-a505-4047-8bbb-5254b985ddcb"]`
- **Delete Button Disabled**: `true`
- **Delete Button Title**: `"不能删除当前激活的词典快照，请先切换至其他词典"`
- **Verdict**: **PASS** (UI strictly prevents deletion of currently active snapshot).

---

## 4. Post-Rejection State & Lexicon Invariance
Following the HTTP 409 rejection:
1. **Host Status Re-read**: Custom B remains active (`activeMode: "custom"`, `activeSnapshotId: "6a30d59e-a505-4047-8bbb-5254b985ddcb"`).
2. **Catalog Integrity**: Snapshot B remains catalogued in `customSnapshots` list.
3. **Lexicon Query**: Word `synapse` returns `found: true` with `source: "custom-local"`.
4. **Physical File Integrity**:
   - Raw SQLite files (`custom-dict-alpha.sqlite3`, `custom-dict-beta.sqlite3`) remain intact and unmodified.
   - Managed snapshot SQLite file (`custom-6a30d59e-a505-4047-8bbb-5254b985ddcb.sqlite3`) remains fully intact.

---

## 5. False-Positive Immunity (Negative Controls)
Live calls in the isolated authenticated browser session proved:
- Wrong route (`remove-custom` without `/dictionary/`): returns **HTTP 404 NOT FOUND**.
- Missing body (`{}`): returns **HTTP 400 INVALID_ARGUMENT**.
- Method GET: returns **HTTP 405 METHOD_NOT_ALLOWED**.
- Only the genuine request on the active snapshot yields **HTTP 409 SNAPSHOT_ACTIVE**.
