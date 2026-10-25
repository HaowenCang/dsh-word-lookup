import type { CustomSnapshotSummary } from '../../shared/dictionary-management-protocol.js'

/** Host validity is authoritative; corrupt is an optional compatibility veto. */
export function isSnapshotActivatable(snapshot: CustomSnapshotSummary): boolean {
  return snapshot.isValid === true && snapshot.corrupt !== true
}
