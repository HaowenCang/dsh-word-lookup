/**
 * Host configuration of `dsh-word-lookup`.
 *
 * The DSH settings service reads this schema from the loader entry's runtime
 * (`entry.fiber.runtime.Config`) and projects **only** the fields carrying
 * `.volatile()` metadata as a browser-editable form. The entry id in
 * `cordis.patch.yml` — `dsh-word-lookup` — is the namespace those writes address,
 * which is why the two strings must stay equal.
 *
 * v0.2.0 expands the configuration model to manage the dictionary operational
 * mode (`fixture`, `managed-ecdict`, `custom`) and optional custom SQLite path
 * alongside the existing automatic gesture switches (`autoDoubleClick`, `autoSelection`).
 * All fields are top-level independent `.volatile()` declarations so that DSH
 * settings forms can project and edit them without remounting the host entry.
 *
 * Defaults:
 * - `dictionaryMode = 'fixture'`
 * - `customDictionaryPath = ''`
 * - `autoDoubleClick = false`
 * - `autoSelection = false`
 *
 * @module dsh-word-lookup/host/config
 */
import z from '@deepseek-ai/schemastery';
/** Supported dictionary operational modes. */
export declare const DICTIONARY_MODES: readonly ["fixture", "managed-ecdict", "custom"];
/** Active dictionary operational mode type. */
export type DictionaryMode = (typeof DICTIONARY_MODES)[number];
/** The plugin's configuration schema, exported under the name DSH looks for. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /**
     * Active dictionary operational mode.
     *
     * Supported modes:
     * - 'fixture': deterministic built-in offline fixture dictionary (default).
     * - 'managed-ecdict': downloaded and managed full ECDICT corpus (Phase 7A.2+).
     * - 'custom': user-supplied custom SQLite dictionary file path (Phase 7A.8).
     *
     * In Phase 7A.1, the runtime defaults to and always executes against fixture.
     */
    dictionaryMode: z<"fixture" | "managed-ecdict" | "custom", "fixture" | "managed-ecdict" | "custom", "volatile-defined">;
    /**
     * Host filesystem path to an advanced custom SQLite dictionary.
     *
     * Only takes effect when dictionaryMode === 'custom' (activation deferred to Phase 7A.8).
     * Defaults to empty string on fresh install (absent or logically empty).
     */
    customDictionaryPath: z<string, string, "volatile-defined">;
    /**
     * Automatic lookup after a completed double click. Off by default.
     *
     * The description is not decoration. Phase 3 shipped this switch with no
     * behaviour behind it, so the settings row was a promise the plugin did not
     * keep; Phase 4 makes it true, and the text says exactly which gesture it
     * answers — a double click — so the row cannot be read as "look up whenever
     * the selection changes".
     */
    autoDoubleClick: z<boolean, boolean, "volatile-defined">;
    /**
     * Automatic lookup after a completed drag selection. Off by default.
     *
     * "after dragging to select text" is the load-bearing phrase: this switch
     * answers a finished pointer drag, not a `selectionchange` event. A keyboard
     * selection, a programmatic one and the selection a double click produces are
     * all deliberately outside it.
     */
    autoSelection: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /**
     * Active dictionary operational mode.
     *
     * Supported modes:
     * - 'fixture': deterministic built-in offline fixture dictionary (default).
     * - 'managed-ecdict': downloaded and managed full ECDICT corpus (Phase 7A.2+).
     * - 'custom': user-supplied custom SQLite dictionary file path (Phase 7A.8).
     *
     * In Phase 7A.1, the runtime defaults to and always executes against fixture.
     */
    dictionaryMode: z<"fixture" | "managed-ecdict" | "custom", "fixture" | "managed-ecdict" | "custom", "volatile-defined">;
    /**
     * Host filesystem path to an advanced custom SQLite dictionary.
     *
     * Only takes effect when dictionaryMode === 'custom' (activation deferred to Phase 7A.8).
     * Defaults to empty string on fresh install (absent or logically empty).
     */
    customDictionaryPath: z<string, string, "volatile-defined">;
    /**
     * Automatic lookup after a completed double click. Off by default.
     *
     * The description is not decoration. Phase 3 shipped this switch with no
     * behaviour behind it, so the settings row was a promise the plugin did not
     * keep; Phase 4 makes it true, and the text says exactly which gesture it
     * answers — a double click — so the row cannot be read as "look up whenever
     * the selection changes".
     */
    autoDoubleClick: z<boolean, boolean, "volatile-defined">;
    /**
     * Automatic lookup after a completed drag selection. Off by default.
     *
     * "after dragging to select text" is the load-bearing phrase: this switch
     * answers a finished pointer drag, not a `selectionchange` event. A keyboard
     * selection, a programmatic one and the selection a double click produces are
     * all deliberately outside it.
     */
    autoSelection: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
/**
 * The validated configuration object `apply` receives.
 *
 * Derived from {@link Config} rather than restated: a `.volatile()` field parses
 * to a stable reference read through `get()`, and deriving the type keeps the
 * handler from drifting away from the schema that produces it.
 */
export type HostConfig = ReturnType<typeof Config>;
/** Field names of {@link HostConfig}, for generic access and reflection. */
export type HostConfigField = keyof HostConfig;
/** Boolean switch field names of {@link HostConfig}, for readSwitch. */
export type HostSwitchField = 'autoDoubleClick' | 'autoSelection';
/**
 * Read one live volatile boolean switch.
 *
 * The settings service rewrites the same reference in place when a browser write
 * is accepted, so a read at request time observes the newest value without any
 * subscription on the host side.
 *
 * @param config - the parsed plugin configuration, or `undefined` before the
 * first parse.
 * @param field - the boolean switch field to read.
 * @returns the current boolean value, or `false` when the configuration is absent.
 */
export declare function readSwitch(config: HostConfig | undefined, field: HostSwitchField | HostConfigField): boolean;
/**
 * Read the current live dictionary mode from volatile configuration.
 *
 * @param config - the parsed plugin configuration, or `undefined`.
 * @returns the active DictionaryMode ('fixture' | 'managed-ecdict' | 'custom'), defaulting to 'fixture'.
 */
export declare function readDictionaryMode(config: HostConfig | undefined): DictionaryMode;
/**
 * Read the current custom dictionary file path from volatile configuration.
 *
 * @param config - the parsed plugin configuration, or `undefined`.
 * @returns the trimmed custom dictionary path, or `''` when absent or empty.
 */
export declare function readCustomDictionaryPath(config: HostConfig | undefined): string;
