/**
 * Host configuration of `dsh-word-lookup`.
 *
 * The DSH settings service reads this schema from the loader entry's runtime
 * (`entry.fiber.runtime.Config`) and projects **only** the fields carrying
 * `.volatile()` metadata as a browser-editable form. The entry id in
 * `cordis.patch.yml` — `dsh-word-lookup` — is the namespace those writes address,
 * which is why the two strings must stay equal.
 *
 * Both switches are `default(false)`: with neither automatic trigger enabled the
 * manual `Primary+Shift+L` path is the only way a lookup can happen, which is the
 * v0.1.0 default interaction.
 *
 * The two fields are independent top-level booleans on purpose. Nesting a
 * volatile field under another volatile field is a hard parse error in the
 * settings form projection, and a single switch covering both gestures could not
 * express the truth table in `docs/06-test-matrix.md`.
 *
 * @module dsh-word-lookup/host/config
 */
import z from '@deepseek-ai/schemastery';
/** The plugin's configuration schema, exported under the name DSH looks for. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
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
/** Field names of {@link HostConfig}, for the live-value reader and tests. */
export type HostConfigField = keyof HostConfig;
/**
 * Read one live volatile field.
 *
 * The settings service rewrites the same reference in place when a browser write
 * is accepted, so a read at request time observes the newest value without any
 * subscription on the host side.
 *
 * @param config - the parsed plugin configuration, or `undefined` before the
 * first parse.
 * @param field - the field to read.
 * @returns the current value, or `false` when the configuration is absent.
 */
export declare function readSwitch(config: HostConfig | undefined, field: HostConfigField): boolean;
