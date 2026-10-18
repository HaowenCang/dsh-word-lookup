# Active Snapshot Deletion Protection E2E Acceptance Report (Phase 7A.9R)

- **Probe Reference**: `scripts/probes/phase7a9/rc-c-multi-snapshot-ui.mjs` (Step 9.5)
- **Evidence Classification**: `REAL_ISOLATED_DSH_E2E`
- **Screenshot Evidence**: `docs/evidence/phase7a9r/screenshots/rcc-S09_active_delete_guard-active-snapshot-delete-disabled.png`
- **Structured Evidence**: `docs/evidence/phase7a9r/multi-snapshot-real-ui-e2e.json`

---

## 1. Finding Addressed

The independent audit identified that while inactive snapshot deletion was tested, active snapshot deletion protection was claimed in evidence without a dedicated active-deletion rejection attempt in the RC-C probe.

## 2. Test Execution Details

In an authentic isolated DSH instance running in Chromium with Custom B active:

1. **DOM UI Assertion**:
   - Selector: `[data-testid="custom-snapshot-row-4af8ca6c-13db-462b-8edb-f9e651085cba"] button:has-text("删除")`
   - Verified: Button is strictly disabled (`isDisabled() === true`).
   - Tooltip: `"不能删除当前激活的词典快照，请先切换至其他词典"`
   - Screenshot captured: `rcc-S09_active_delete_guard-active-snapshot-delete-disabled.png`.

2. **Guarded API Rejection Attempt**:
   - Direct HTTP POST executed via page context to `/api/dsh-word-lookup/remove-custom?snapshotId=4af8ca6c-13db-462b-8edb-f9e651085cba`.
   - Result: HTTP request was strictly rejected (`ok: false`). Active snapshot was protected against deletion.

3. **Active Snapshot Continued Functionality**:
   - Query for `"synapse"` executed immediately after the rejection attempt.
   - Result: `{ found: true, headword: 'synapse' }`. Custom B remained active and completely undamaged.

4. **Raw SQLite Source Invariance**:
   - Raw source SQLite files on disk were checked before and after all deletion attempts:
     - Custom A initial: `b6edf3fcc91250fb7a2beca84d5da479ebaf0875256be53d1964fa00c745cb16`
     - Custom A final:   `b6edf3fcc91250fb7a2beca84d5da479ebaf0875256be53d1964fa00c745cb16` (INVARIANT)
     - Custom B initial: `326155d554fef19e44117b6a0b8492cd42b8af6120a46314ed19600044e12fef`
     - Custom B final:   `326155d554fef19e44117b6a0b8492cd42b8af6120a46314ed19600044e12fef` (INVARIANT)

## 3. Verdict
**PASS** — Both UI-level disabling and backend management API rejection of active snapshot deletion are verifiably proven in a real browser session.
