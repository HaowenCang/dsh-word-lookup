/**
 * The SQLite-backed implementation of {@link Dictionary}.
 *
 * This is the **only** module in the package that touches `node:sqlite`, and it
 * is reachable only from the host half. The browser bundle must never import it:
 * a database in the page would mean shipping the dictionary to the client, and
 * `scripts/check-bundle.mjs` asserts that it does not happen.
 *
 * Three properties shape the code below:
 *
 * - **Every value is bound, never interpolated.** Each statement is a fixed
 *   string prepared once; the query arrives as a parameter. A selection of
 *   `'; DROP TABLE entries; --` is therefore just a word the dictionary has
 *   never heard of. SQLite's `exec` does run multiple statements, so `exec` is
 *   used only for schema and transaction control, whose text is a literal, and
 *   never for anything derived from a query.
 * - **The lookup order is fixed and checked in this order**: exact entry first,
 *   then the `forms` table, then the resolved headword's rows. An exact phrase
 *   therefore outranks morphology, which is what stops `wave function` from
 *   being answered as `wave`.
 * - **The handle is owned, not pooled.** One plugin lifecycle opens at most one
 *   connection and {@link SqliteDictionary.close} releases it. There is no
 *   connection pool: a fixture database read once per keystroke does not need
 *   one, and a pool is exactly the construct that would let a load/unload cycle
 *   leak a handle.
 *
 * @module dsh-word-lookup/host/sqlite-dictionary
 */
import { DatabaseSync } from 'node:sqlite';
import { type Dictionary, type DictionaryLookup } from './dictionary.js';
/** How the database was brought to its current state, for evidence. */
export interface DictionaryInitialization {
    /** Absolute path of the database file, or `:memory:`. */
    readonly path: string;
    /** Whether the schema had to be created on this open. */
    readonly created: boolean;
    /** Whether the rows had to be (re)written on this open. */
    readonly seeded: boolean;
    /** `schema_version` read back after initialization. */
    readonly schemaVersion: number;
    /** `fixture_version` read back after initialization. */
    readonly fixtureVersion: string;
    /** Whether the file was already present when the store opened. */
    readonly existed: boolean;
}
/** Options accepted by {@link openSqliteDictionary}. */
export interface SqliteDictionaryOptions {
    /**
     * Database file, or `':memory:'`.
     *
     * Never a configuration field: Phase 3 exposes no `dictionaryPath` setting.
     * The production path is resolved by `src/host/fixture-db.ts` from the
     * package's own location, and tests pass a scratch path explicitly.
     */
    readonly path: string;
    /**
     * Open read-only, and refuse to modify the file.
     *
     * A read-only open never creates, seeds or repairs anything: a missing or
     * unusable file is an error. Tests use it to prove that a closed database
     * really was persisted rather than quietly rebuilt.
     */
    readonly readOnly?: boolean;
}
/**
 * A SQLite connection that is opened and closed exactly once.
 *
 * Constructed only by {@link openSqliteDictionary}, which is what guarantees the
 * schema and rows were validated before the first query.
 */
export declare class SqliteDictionary implements Dictionary {
    #private;
    readonly source: "sqlite-fixture";
    /**
     * @param db - an open connection whose schema and rows are already valid.
     * @param info - what initialization did, for evidence.
     */
    constructor(db: DatabaseSync, info: DictionaryInitialization);
    /** What opening this database did. Read-only. */
    get initialization(): DictionaryInitialization;
    /**
     * Resolve one normalized query.
     *
     * @param normalizedQuery - the normalized selection.
     * @returns a hit or a miss.
     * @throws {DictionaryUnavailableError} when the store has been closed.
     */
    lookup(normalizedQuery: string): DictionaryLookup;
    /** Release the connection. Idempotent. */
    close(): void;
}
/**
 * Open the SQLite dictionary.
 *
 * The connection is closed again if anything after it fails, so a failed open
 * never leaves a half-open handle behind — which is the property that makes
 * "repeated load/unload does not accumulate handles" a consequence of the code
 * rather than of careful calling.
 *
 * @param options - where the database lives and whether to initialize it.
 * @returns an open dictionary.
 * @throws {DictionaryUnavailableError} when the store cannot be opened or is
 * not a usable fixture.
 */
export declare function openSqliteDictionary(options: SqliteDictionaryOptions): SqliteDictionary;
