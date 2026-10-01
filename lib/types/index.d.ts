/**
 * Host half of `dsh-word-lookup` (`exports "."`).
 *
 * Loaded by the DSH host Loader as a normal entry and activated with the parsed
 * {@link Config} output. It contributes exactly two things:
 *
 * 1. `Config` — the schema the settings service projects to the browser. It is a
 *    module-level export read from `entry.fiber.runtime.Config`; there is no
 *    config class and no `ctx.config` service in this DSH generation.
 * 2. one exact Fetch route `POST /api/dsh-word-lookup`, registered on the
 *    `connection` service inside a single `ctx.effect`.
 *
 * `connection.rpc.handle` and `connection.rpc.intercept('/api', …)` are
 * deliberately unused: the interceptor slot on `/api` is held by
 * `dsh-api-gateway` in the shipped Web composition, so a second registration
 * throws at plugin load, and `rpc.handle` has no first-party call site to model
 * against.
 *
 * This module is imported by the Node host process and must never reach a
 * browser-only dependency. The browser half lives behind `exports "./client"` and
 * shares only the type-only contract in `src/shared/protocol.ts`.
 *
 * @module dsh-word-lookup
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, type HostConfig } from './host/config.js';
export { Config };
export type { HostConfig };
/** Package name; equals the Loader entry id and the settings namespace. */
export declare const name = "dsh-word-lookup";
/** Host services required before this entry activates. */
export declare const inject: readonly string[];
/**
 * Register the host contributions.
 *
 * One effect owns the whole host surface, so unloading the loader entry removes
 * the route exactly once. A second registration of the same path would throw
 * `connection: exact Fetch route "…" is already registered`, which is a
 * load-time signal rather than a silent duplicate.
 *
 * @param ctx - the host plugin context.
 * @param config - the parsed {@link Config} output for this loader entry.
 */
export declare function apply(ctx: Context, config: HostConfig): void;
