/**
 * Build configuration for `dsh-word-lookup`.
 *
 * Two independent halves, because DSH loads them through two different
 * mechanisms and they must never share a module graph:
 *
 * - `src/index.ts`  → `lib/index.js`  (host half, ESM, Node). Imported by the
 *   DSH host process through the package's `exports["."]`.
 * - `src/client/index.tsx` → `lib/client.js` (browser half, one classic
 *   script). Served by `dsh-client-modules` and consumed only through
 *   `window.__ModuleLoader__.load({ id, factory })`.
 *
 * The browser half carries the loader envelope in `banner`/`footer` instead of
 * an entry module, because the runtime contract is a classic script that
 * registers itself; a surviving top-level `import`/`export` would be a syntax
 * error in that position. React and React DOM therefore stay external in the
 * only sense that the envelope's `require` supplies them, and the browser entry
 * is emitted as CommonJS rather than ESM.
 *
 * The build is deliberately self-contained: this machine has no DSH source
 * checkout, so nothing here may reference `$DSH_CHECKOUT`. Type resolution uses
 * the DSH packages installed as devDependencies at the exact versions the
 * running 0.2.0-rc.2 installation ships.
 */
import { defineConfig } from 'tsdown'

/** Package id used by the loader envelope and by `__DSH_BOOT__`. */
const PLUGIN_ID = 'dsh-word-lookup'

/**
 * Opening envelope. Not a template literal: the emitted bundle body is
 * arbitrary JavaScript, and keeping the two halves as plain string constants
 * makes the exact bytes auditable in `scripts/check-bundle.mjs`.
 */
const BANNER = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(PLUGIN_ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
].join('\n')

/** Closing envelope: hand the module exports back to the loader. */
const FOOTER = ['\t\treturn module.exports;', '\t}', '});'].join('\n')

export default defineConfig([
  {
    name: 'dsh-word-lookup-host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: true,
    // The package's `exports["."]` addresses `./lib/index.js`; tsdown's default
    // for an ESM Node build is `.mjs`.
    outExtensions: () => ({ js: '.js' }),
    define: {
      __PROD_BUNDLE__: 'true',
    },
    deps: {
      // Provided by the DSH host process. Bundling a second copy would make
      // this plugin's schema objects come from a different schemastery
      // instance than the one the settings service uses.
      neverBundle: [/^@deepseek-ai\/schemastery$/],
    },
  },
  {
    name: 'dsh-word-lookup-client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    // An external client plugin is served as exactly one script; a second
    // chunk would be an asset no contract delivers. `codeSplitting` is a
    // rolldown output option, so it is stated there rather than at the top
    // level of the tsdown config.
    outputOptions: {
      codeSplitting: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    deps: {
      // Resolved by the loader envelope's `require`, never bundled.
      neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    },
    banner: BANNER,
    footer: FOOTER,
  },
  {
    name: 'dsh-word-lookup-worker',
    entry: { 'ecdict-integrity-worker': 'src/host/ecdict-integrity-worker.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    deps: {
      neverBundle: [/^node:/],
    },
  },
])
