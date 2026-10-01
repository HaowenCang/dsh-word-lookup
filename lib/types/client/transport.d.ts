/**
 * Browser transport for the exact Fetch route.
 *
 * The URL is **document-relative** (`api/dsh-word-lookup`, no leading slash):
 * `dsh-host-frontend-static` serves the application with `<base href="./">`, so a
 * leading slash would leave the application's mount directory. First-party code
 * strips the same slash before calling `fetch`.
 *
 * No `credentials` option is set: the same-origin default already sends the
 * signed, authority-bound `HttpOnly` cookie the connection fence requires, and
 * there is no `Authorization` header path in this DSH generation.
 *
 * Every outcome is returned as a value. A rejected promise is reserved for the
 * two cases the caller cannot act on — an aborted request and a transport
 * failure — so a controlled host refusal never has to be distinguished from a
 * broken route by catching an exception.
 *
 * @module dsh-word-lookup/client/transport
 */
import { type LookupFailureCode, type LookupFoundResponse, type LookupNotFoundResponse } from '../shared/protocol.js';
/** A lookup that reached the host and produced a body. */
export type LookupResult = {
    readonly kind: 'found';
    readonly body: LookupFoundResponse;
} | {
    readonly kind: 'not-found';
    readonly body: LookupNotFoundResponse;
} | {
    readonly kind: 'refused';
    readonly httpStatus: number;
    readonly code: LookupFailureCode | 'unexpected-response';
    readonly message: string;
};
/** Why a transport-level request ended without a body. */
export type LookupTransportFailure = {
    readonly kind: 'aborted';
} | {
    readonly kind: 'network';
    readonly message: string;
};
/**
 * POST one query and classify the response.
 *
 * @param query - the raw selected text; the host normalizes it.
 * @param signal - cancels a superseded request. A newer lookup must abort the
 * previous one rather than race it, which is what T15 asks for.
 * @returns the classified result.
 * @throws never — transport failures resolve to a value; only a programming
 * error inside the classifier would propagate.
 */
export declare function requestLookup(query: string, signal?: AbortSignal): Promise<LookupResult | LookupTransportFailure>;
