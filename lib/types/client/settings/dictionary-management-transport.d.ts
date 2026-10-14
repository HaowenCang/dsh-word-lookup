/**
 * Browser transport client for dictionary management endpoints.
 *
 * All endpoints use document-relative paths (`api/dsh-word-lookup/dictionary/...`,
 * no leading slash) conforming to DSH <base href="./"> architecture.
 * Authentication uses standard same-origin cookie credentials.
 *
 * @module dsh-word-lookup/client/settings/dictionary-management-transport
 */
import { type DictionaryCancelResponse, type DictionaryInstallResponse, type DictionaryRemoveResponse, type DictionaryStatusResponse, type DictionaryVerifyResponse, type ManagementErrorCode } from '../../shared/dictionary-management-protocol.js';
/**
 * Successful management API result.
 */
export interface ManagementApiSuccess<T> {
    readonly ok: true;
    readonly data: T;
}
/**
 * Host refused the request with an HTTP error response (e.g. 400, 401, 404, 409, 500).
 */
export interface ManagementApiRefusal {
    readonly ok: false;
    readonly kind: 'refused';
    readonly httpStatus: number;
    readonly code: ManagementErrorCode | 'unexpected-response';
    readonly message: string;
}
/**
 * Network connection failed or server is unreachable.
 */
export interface ManagementApiNetworkError {
    readonly ok: false;
    readonly kind: 'network';
    readonly message: string;
}
/**
 * Request was aborted via AbortSignal.
 */
export interface ManagementApiAborted {
    readonly ok: false;
    readonly kind: 'aborted';
}
/**
 * Unified result type for management API calls.
 */
export type ManagementApiResult<T> = ManagementApiSuccess<T> | ManagementApiRefusal | ManagementApiNetworkError | ManagementApiAborted;
/**
 * Validate that an unknown value conforms to DictionaryStatusResponse structure.
 */
export declare function isValidDictionaryStatusResponse(value: unknown): value is DictionaryStatusResponse;
/**
 * Fetch current dictionary status from the host.
 */
export declare function fetchDictionaryStatus(signal?: AbortSignal): Promise<ManagementApiResult<DictionaryStatusResponse>>;
/**
 * Initiate an installation of the managed ECDICT corpus.
 */
export declare function installManagedDictionary(signal?: AbortSignal): Promise<ManagementApiResult<DictionaryInstallResponse>>;
/**
 * Cancel an in-flight background operation.
 */
export declare function cancelDictionaryOperation(operationId: string, signal?: AbortSignal): Promise<ManagementApiResult<DictionaryCancelResponse>>;
/**
 * Remove the installed managed ECDICT corpus and revert to fixture mode.
 */
export declare function removeManagedDictionary(signal?: AbortSignal): Promise<ManagementApiResult<DictionaryRemoveResponse>>;
/**
 * Verify a custom SQLite dictionary path.
 */
export declare function verifyCustomDictionary(path: string, signal?: AbortSignal): Promise<ManagementApiResult<DictionaryVerifyResponse>>;
