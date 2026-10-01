/**
 * Where the fixture database lives, and how the host opens it.
 *
 * Phase 3 adds **no configuration field** for the database location. The
 * verified Phase 0 contract for this DSH generation exposes exactly
 * `autoDoubleClick` and `autoSelection`, and a `dictionaryPath` a reader could
 * point at an arbitrary file would be both an unverified settings surface and a
 * way to make a lookup read something that is not the dictionary. The path is
 * therefore *derived from the package's own location*, which is the one place
 * the plugin can be sure about:
 *
 * ```text
 * <package root>/fixtures/dictionary.fixture.db
 * ```
 *
 * The package root is found by walking up from this module's own URL until a
 * `package.json` naming this package is reached. That works unchanged from the
 * two positions this module is loaded from — `src/host/` under vitest and
 * `lib/index.js` in the published bundle — and it follows the junction an
 * isolated DSH profile installs, because Node resolves module paths to their
 * real location by default.
 *
 * A production corpus is a later phase's problem. When it lands it must not
 * reuse this function: the file name asserts what the file is, and a corpus is
 * not a fixture.
 *
 * @module dsh-word-lookup/host/fixture-db
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DictionaryUnavailableError } from './dictionary.js'
import { openSqliteDictionary, type SqliteDictionary } from './sqlite-dictionary.js'

/** Package name the root search matches against `package.json`. */
export const PACKAGE_NAME = 'dsh-word-lookup'

/** Directory holding generated, package-owned test data. */
export const FIXTURE_DIRECTORY = 'fixtures'

/** File name of the generated fixture database. */
export const FIXTURE_FILE_NAME = 'dictionary.fixture.db'

/** How many directory levels the root search will climb before giving up. */
const MAX_SEARCH_DEPTH = 12

/**
 * Find the package root by climbing from a module URL.
 *
 * @param fromUrl - a `file:` URL inside the package; defaults to this module.
 * @returns the absolute package root.
 * @throws {DictionaryUnavailableError} when no ancestor `package.json` names
 * this package, which means the module is not being loaded from its own tree.
 */
export function findPackageRoot(fromUrl: string = import.meta.url): string {
  let directory = dirname(fileURLToPath(fromUrl))

  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && statSync(manifest).isFile()) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (parsed.name === PACKAGE_NAME) return directory
      } catch {
        // An unreadable or malformed manifest is not this package's; keep going.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  throw new DictionaryUnavailableError(`cannot locate the ${PACKAGE_NAME} package root from ${fromUrl}`)
}

/**
 * Absolute path of the package-owned fixture database.
 *
 * The path is not configurable and is not read from the environment. It is a
 * pure function of where the package is installed.
 *
 * @param fromUrl - a `file:` URL inside the package; defaults to this module.
 * @returns the absolute path the host opens.
 */
export function resolveFixtureDatabasePath(fromUrl: string = import.meta.url): string {
  return join(findPackageRoot(fromUrl), FIXTURE_DIRECTORY, FIXTURE_FILE_NAME)
}

/** Options for {@link openFixtureDictionary}. */
export interface OpenFixtureDictionaryOptions {
  /** Override the module URL the package root is derived from. Tests only. */
  readonly fromUrl?: string
  /** Open without creating or repairing the file. */
  readonly readOnly?: boolean
}

/**
 * Open the host's production dictionary: the package-owned SQLite fixture.
 *
 * This is the only call site the plugin's runtime uses, and it is deliberately
 * the only place the production path is named. Everything else takes a
 * `Dictionary` and does not know what backs it.
 *
 * @param options - test-only overrides.
 * @returns an open dictionary over the package's fixture database.
 * @throws {DictionaryUnavailableError} when the fixture cannot be opened.
 */
export function openFixtureDictionary(options: OpenFixtureDictionaryOptions = {}): SqliteDictionary {
  const path = resolveFixtureDatabasePath(options.fromUrl ?? import.meta.url)
  return openSqliteDictionary({ path, readOnly: options.readOnly === true })
}
