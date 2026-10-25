import type { CustomSnapshotSummary } from '../../shared/dictionary-management-protocol.js';
/** Host validity is authoritative; corrupt is an optional compatibility veto. */
export declare function isSnapshotActivatable(snapshot: CustomSnapshotSummary): boolean;
