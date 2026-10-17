/**
 * Shared wire contract and data types for dictionary management operations.
 *
 * Leaf module: imports nothing and contains no environment-specific APIs.
 * Shared between Host management routes and the future Client settings page (Phase 7A.7).
 *
 * @module dsh-word-lookup/shared/dictionary-management-protocol
 */

/** Document-relative URL of dictionary management status endpoint (client-facing). */
export const MANAGEMENT_STATUS_DOCUMENT_PATH = 'api/dsh-word-lookup/dictionary/status'

/** Document-relative URL of dictionary installation endpoint (client-facing). */
export const MANAGEMENT_INSTALL_DOCUMENT_PATH = 'api/dsh-word-lookup/dictionary/install'

/** Document-relative URL of dictionary cancellation endpoint (client-facing). */
export const MANAGEMENT_CANCEL_DOCUMENT_PATH = 'api/dsh-word-lookup/dictionary/cancel'

/** Document-relative URL of dictionary removal endpoint (client-facing). */
export const MANAGEMENT_REMOVE_DOCUMENT_PATH = 'api/dsh-word-lookup/dictionary/remove'

/** Document-relative URL of dictionary verification endpoint (client-facing). */
export const MANAGEMENT_VERIFY_DOCUMENT_PATH = 'api/dsh-word-lookup/dictionary/verify'

/** Document-relative URL of custom dictionary activation endpoint (client-facing). */
export const MANAGEMENT_ACTIVATE_CUSTOM_DOCUMENT_PATH = 'api/dsh-word-lookup/dictionary/activate-custom'

/** Document-relative URL of dictionary operational mode selection endpoint (client-facing). */
export const MANAGEMENT_SELECT_MODE_DOCUMENT_PATH = 'api/dsh-word-lookup/dictionary/select-mode'

/** Content-Type accepted and returned by management endpoints. */
export const MANAGEMENT_MEDIA_TYPE = 'application/json'

/** Maximum accepted request body size in bytes for management endpoints (64 KiB). */
export const MAX_MANAGEMENT_REQUEST_BYTES = 65536

/**
 * Phase of an active dictionary background operation.
 */
export type DictionaryOperationPhase =
  | 'queued'
  | 'checking-cache'
  | 'downloading'
  | 'verifying-source'
  | 'building'
  | 'validating-database'
  | 'activating'
  | 'completed'
  | 'cancelled'
  | 'failed'

/**
 * Lifecycle status of an operation.
 */
export type DictionaryOperationStatus = 'running' | 'completed' | 'cancelled' | 'failed'

/**
 * Structured progress details.
 */
export interface DictionaryOperationProgress {
  /** Current operation phase. */
  readonly phase: DictionaryOperationPhase
  /** Subphase or granular step description if available. */
  readonly subphase?: string
  /** Processed count in current unit. */
  readonly processed?: number
  /** Expected total count in current unit. */
  readonly total?: number
  /** Rounded percentage (0 - 100), or undefined if total is unknown. */
  readonly percent?: number
  /** Unit of progress. */
  readonly unit?: 'bytes' | 'entries' | 'steps'
  /** Human-readable status message. */
  readonly message?: string
}

/**
 * Structured diagnostic error record on failed operations.
 */
export interface DictionaryOperationError {
  /** Machine-readable error code. */
  readonly code: string
  /** Human-readable error message. */
  readonly message: string
  /** Whether the operation can be retried. */
  readonly retryable: boolean
}

/**
 * Kind of dictionary background operation.
 */
export type DictionaryOperationKind = 'install' | 'remove' | 'activate-custom' | 'switch-mode'

/**
 * Diagnostic snapshot of a background dictionary operation.
 */
export interface DictionaryOperationSnapshot {
  /** Unique operation identifier. */
  readonly operationId: string
  /** Kind of operation ('install' | 'remove' | 'activate-custom' | 'switch-mode'). */
  readonly kind: DictionaryOperationKind
  /** Current fine-grained phase. */
  readonly phase: DictionaryOperationPhase
  /** High-level operational status. */
  readonly status: DictionaryOperationStatus
  /** Monotonic progress metrics. */
  readonly progress: DictionaryOperationProgress
  /** ISO 8601 start timestamp. */
  readonly startedAt: string
  /** ISO 8601 last update timestamp. */
  readonly updatedAt: string
  /** ISO 8601 settlement timestamp if finished. */
  readonly finishedAt?: string
  /** Error details if status === 'failed'. */
  readonly error?: DictionaryOperationError
}

/**
 * Summary information of the currently installed managed corpus.
 */
export interface InstalledCorpusInfo {
  /** Pinned corpus name ('ECDICT'). */
  readonly name: string
  /** Authoritative Git commit hash. */
  readonly commit: string
  /** Authoritative raw source SHA-256 digest. */
  readonly sha256: string
  /** Database schema version. */
  readonly schemaVersion: number
  /** Database filename basename (e.g. 'ecdict-v1-....sqlite3'). */
  readonly databaseFile: string
  /** Total valid entry count if known. */
  readonly entryCount?: number
  /** Total form count if known. */
  readonly formCount?: number
  /** Physical database byte size on disk. */
  readonly byteSize?: number
  /** Published timestamp if known. */
  readonly publishedAt?: string
}

/**
 * Summary representation of a persistent custom snapshot for listing and inspection.
 */
export interface CustomSnapshotSummary {
  /** Internal snapshot UUID. */
  readonly snapshotId: string
  /** Logical identity token. */
  readonly identity: string
  /** Database schema version. */
  readonly schemaVersion: number
  /** Headword entry count. */
  readonly entryCount: number
  /** Inflection and morphological forms count. */
  readonly formCount: number
  /** Physical database byte size on disk. */
  readonly byteSize: number
  /** Current snapshot state in manager. */
  readonly status: string
  /** Whether this snapshot is currently active. */
  readonly isActive: boolean
  /** Whether the snapshot is valid and eligible for activation. */
  readonly isValid: boolean
  /** ISO-8601 creation/publication timestamp. */
  readonly createdAt: string
}

/**
 * Summary information of the package-owned deterministic fixture dictionary.
 */
export interface FixtureCorpusInfo {
  /** Headword entry count in fixture. */
  readonly entryCount: number
  /** Inflection and morphological forms count in fixture. */
  readonly formCount: number
  /** Fixture version identifier. */
  readonly version: string
}

/**
 * Status response returned by GET /api/dsh-word-lookup/dictionary/status.
 */
export interface DictionaryStatusResponse {
  readonly ok: true
  /** Currently active in-memory dictionary operational mode. */
  readonly activeMode: 'fixture' | 'managed-ecdict' | 'custom'
  /** Mode currently configured in host settings. */
  readonly configuredMode: 'fixture' | 'managed-ecdict' | 'custom'
  /** Provenance source of active dictionary. */
  readonly activeSource: 'sqlite-fixture' | 'ecdict-local' | 'custom-local'
  /** Active dictionary identity token (or 'fixture'). */
  readonly activeIdentity: string
  /** Active custom snapshot UUID if custom mode is active, or null. */
  readonly activeSnapshotId?: string | null
  /** Fine-grained active lease summary if custom mode is active, or null. */
  readonly customSnapshotStatus?: {
    readonly snapshotId: string
    readonly activeLeases: number
  } | null
  /** Whether a valid managed ECDICT corpus is installed and verified on disk. */
  readonly installed: boolean
  /** Metadata of the installed corpus, or null if none is installed. */
  readonly installedCorpus: InstalledCorpusInfo | null
  /** List of persistent custom snapshots in catalog. */
  readonly customSnapshots?: readonly CustomSnapshotSummary[]
  /** Statistics for built-in fixture dictionary, if active or available. */
  readonly fixtureStats?: FixtureCorpusInfo
  /** Snapshot of currently running background operation, or null. */
  readonly currentOperation: DictionaryOperationSnapshot | null
  /** Snapshot of the most recently settled operation, or null. */
  readonly lastOperation: DictionaryOperationSnapshot | null
  /** Whether an installation operation can currently be accepted. */
  readonly canInstall: boolean
  /** Whether an in-flight operation can currently be cancelled. */
  readonly canCancel: boolean
  /** Whether the managed dictionary can currently be removed. */
  readonly canRemove: boolean
  /** Whether a custom dictionary can currently be activated. */
  readonly canActivateCustom?: boolean
  /** Whether the dictionary operational mode can currently be switched. */
  readonly canSwitchMode?: boolean
  /** Whether storage directory is quarantined due to unconfirmed worker termination. */
  readonly quarantined: boolean
  /** Reason for directory quarantine, if quarantined. */
  readonly quarantineReason: string | null
  /** Startup recovery or disk anomaly message if degraded. */
  readonly recoveryError: string | null
  /** Settings synchronization state if managed corpus is installed. */
  readonly settingsSyncState?: 'synced' | 'failed' | 'unavailable' | 'pending'
  /** Settings update synchronization error if persistence failed. */
  readonly settingsSyncError?: string | null
  /** Last activation rollback error message, if any. */
  readonly lastRollbackError?: string | null
  /** Last retirement close error message, if any. */
  readonly lastRetirementError: string | null
  /** Manager generation counter. */
  readonly generation: number
}

/**
 * Response returned by POST /api/dsh-word-lookup/dictionary/install.
 */
export interface DictionaryInstallResponse {
  readonly ok: true
  /** Assigned operation identifier. */
  readonly operationId: string
  /** Initial status ('running'). */
  readonly status: 'running'
  /** Initial phase ('queued'). */
  readonly phase: DictionaryOperationPhase
  /** Informational message. */
  readonly message: string
}

/**
 * Request payload for POST /api/dsh-word-lookup/dictionary/cancel.
 */
export interface DictionaryCancelRequest {
  /** Exact operationId to cancel. */
  readonly operationId: string
}

/**
 * Response returned by POST /api/dsh-word-lookup/dictionary/cancel.
 */
export interface DictionaryCancelResponse {
  readonly ok: true
  /** Target operation identifier. */
  readonly operationId: string
  /** Status indicating cancellation was requested. */
  readonly status: 'cancelling' | 'cancelled'
  /** Informational message. */
  readonly message: string
}

/**
 * Response returned by POST /api/dsh-word-lookup/dictionary/remove.
 */
export interface DictionaryRemoveResponse {
  readonly ok: true
  /** Whether files were unlinked. */
  readonly removed: boolean
  /** Active dictionary mode after removal ('fixture' or 'custom'). */
  readonly activeMode: 'fixture' | 'custom'
  /** Informational message. */
  readonly message: string
}

/**
 * Request payload for POST /api/dsh-word-lookup/dictionary/activate-custom.
 */
export interface DictionaryActivateCustomRequest {
  /** Absolute filesystem path to candidate custom SQLite database. */
  readonly path: string
  /** Optional custom alphanumeric identity label. */
  readonly identity?: string
}

/**
 * Response returned by POST /api/dsh-word-lookup/dictionary/activate-custom.
 */
export interface DictionaryActivateCustomResponse {
  readonly ok: true
  /** Assigned operation identifier. */
  readonly operationId: string
  /** Settled operational mode ('custom'). */
  readonly activeMode: 'custom'
  /** Settled dictionary identity. */
  readonly identity: string
  /** Assigned published snapshot UUID. */
  readonly snapshotId: string
  /** Informational message. */
  readonly message: string
}

/**
 * Request payload for POST /api/dsh-word-lookup/dictionary/select-mode.
 */
export interface DictionarySelectModeRequest {
  /** Target operational mode. */
  readonly mode: 'fixture' | 'managed-ecdict' | 'custom'
  /** Published snapshot UUID (required when mode is 'custom'). */
  readonly snapshotId?: string
}

/**
 * Response returned by POST /api/dsh-word-lookup/dictionary/select-mode.
 */
export interface DictionarySelectModeResponse {
  readonly ok: true
  /** Assigned operation identifier. */
  readonly operationId?: string
  /** Settled operational mode. */
  readonly activeMode: 'fixture' | 'managed-ecdict' | 'custom'
  /** Settled dictionary identity. */
  readonly identity?: string | null
  /** Informational message. */
  readonly message: string
}

/**
 * Request payload for POST /api/dsh-word-lookup/dictionary/verify.
 */
export interface DictionaryVerifyRequest {
  /** Filesystem path to candidate custom SQLite database. */
  readonly path: string
}

/**
 * Response returned by POST /api/dsh-word-lookup/dictionary/verify.
 */
export interface DictionaryVerifyResponse {
  readonly ok: true
  /** Whether the database is valid and compatible. */
  readonly valid: boolean
  /** Verified schema version. */
  readonly schemaVersion: number
  /** Headword entries count. */
  readonly entryCount: number
  /** Morphological forms count. */
  readonly formCount: number
  /** Representative sample headwords verified via probe. */
  readonly headwordsSample?: readonly string[]
  /** Informational message. */
  readonly message: string
}

/**
 * Machine-readable error codes across management endpoints.
 */
export type ManagementErrorCode =
  | 'BAD_REQUEST'
  | 'INVALID_ARGUMENT'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'BODY_TOO_LARGE'
  | 'OPERATION_IN_PROGRESS'
  | 'OPERATION_NOT_RUNNING'
  | 'OPERATION_NOT_CANCELLABLE'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_CANCELLED'
  | 'DIRECTORY_QUARANTINED'
  | 'INVALID_OPERATION_ID'
  | 'INVALID_PATH'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'INVALID_SQLITE_FILE'
  | 'INVALID_DATABASE_SCHEMA'
  | 'INCOMPATIBLE_DICTIONARY'
  | 'SNAPSHOT_NOT_FOUND'
  | 'ECDICT_NOT_INSTALLED'
  | 'ACTIVATE_CUSTOM_FAILED'
  | 'SWITCH_MODE_FAILED'
  | 'REMOVE_FAILED'
  | 'INTERNAL_ERROR'

/**
 * Structured error response returned when an endpoint refuses or fails.
 */
export interface DictionaryErrorResponse {
  readonly ok: false
  /** Stable machine-readable error code. */
  readonly error: ManagementErrorCode
  /** Sanitized human-readable error explanation. */
  readonly message: string
  /** Optional sanitized context. */
  readonly details?: Readonly<Record<string, unknown>>
}
