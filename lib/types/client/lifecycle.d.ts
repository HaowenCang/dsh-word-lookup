/**
 * A minimal disposer list.
 *
 * The client half makes four contributions — one slot occupant, one shortcut
 * command, one settings subscription, one document listener — and every one of
 * them returns its own disposer. Collecting them here gives the plugin's single
 * `ctx.effect` one thing to unwind, so "how many registrations does this plugin
 * make" and "how many effects does the fiber hold" stop being the same question.
 *
 * Disposal is idempotent, and a failure inside one child does not skip its
 * siblings: a half-disposed runtime is the one outcome a reload must not produce,
 * and a leftover shortcut or slot entry is exactly what a duplicate-registration
 * failure on the next load would report.
 *
 * @module dsh-word-lookup/client/lifecycle
 */
/** Ordered, idempotent, failure-isolating disposer collection. */
export declare class Disposer {
    #private;
    /**
     * Adopt one disposer.
     *
     * @param dispose - the child's disposer. If the collection is already
     * disposed, the child is released immediately rather than retained.
     */
    add(dispose: () => void): void;
    /** Release every adopted disposer, in reverse order. Safe to call twice. */
    disposeAll(): void;
}
