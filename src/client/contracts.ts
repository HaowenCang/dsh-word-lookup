/**
 * The DSH client contracts this plugin builds on, stated in one place.
 *
 * Every `import type {} from …` below is load-bearing rather than incidental.
 * The DSH client surfaces declare themselves by augmenting shared tables —
 * `@deepseek-ai/cordis` `Context` for services, `@deepseek-ai/dsh-client-ui-slots`
 * `SlotMap` for slots — and TypeScript applies an augmentation only when the
 * declaring module is part of the program. Importing the module that declares the
 * augmentation is how this plugin states which contracts it consumes; a renamed,
 * moved or withdrawn surface then fails `npm run typecheck` instead of silently
 * degrading to `any`.
 *
 * Only public specifiers are used. The DSH packages also publish `./src/*`,
 * which does not exist in the installed copy and is never imported.
 *
 * @module dsh-word-lookup/client/contracts
 */

import type { Context } from '@deepseek-ai/cordis'

// `ctx.slots` — the renderer-owned slot registry and the `slots/changed` event.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// The `shell.overlay` root-scoped list slot, declared by the frame that renders
// it. An external plugin cannot declare the slot itself; it can only occupy it.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// `ctx.shortcuts` — the window-local command registry and its keycap catalog.
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
// `ctx.configForms` — the shared settings describe mirror and per-namespace
// read/write face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The client root context DSH hands to a browser plugin's `apply`. */
export type ClientContext = Context

/** The renderer-owned slot registry the overlay contribution is made through. */
export type SlotRegistry = ClientContext['slots']

/** The command registry the manual lookup command is contributed to. */
export type Shortcuts = ClientContext['shortcuts']

/** The settings mirror the two automatic switches are read from. */
export type ConfigForms = ClientContext['configForms']
