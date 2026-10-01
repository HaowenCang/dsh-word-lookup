# Phase 3 Evidence — Local Dictionary Core (SQLite)

## 1. Baseline

| Fact | Value |
| --- | --- |
| `START_SHA` | `cce8ef51edac511c85d02df2f8f8846d4406142e` |
| Branch | `master` |
| Worktree at start | clean (`git status --short` empty) |
| Previous checkpoint | `da9f762` Phase 2 feature, `cce8ef5` launch-token scrub fix |
| Phase 3 scope | Local dictionary core: a real, local SQLite store replacing `source: "stub"` |

Phase 1 and Phase 2 were **not** redone. No file that they had verified was
rewritten beyond what Phase 3 required in it, and every Phase 1 and Phase 2
assertion still passes unchanged (§9, §12).

`HEAD` had **not** advanced beyond the expected baseline, so the stated baseline
was taken as given and no history was rewritten, reset or cleaned.

## 2. Environment

| Fact | Value |
| --- | --- |
| DSH | `0.2.0-rc.2` |
| Node | `v24.13.0` |
| npm | `11.12.0` |
| SQLite (bundled with Node) | `3.50.4` |
| Browser (runtime run) | Chromium `153.0.8010.12` |
| vitest | `3.2.4` |
| tsdown / rolldown | `0.23.0` / `1.2.11` |

## 3. `node:sqlite` capability (measured on the real Node, not assumed)

Phase 0 never probed `node:sqlite`, so Phase 3 measured it before designing
anything against it. The probe was run against the user's actual interpreter and
is re-run as a test on every `npm test` (`tests/host-sqlite-safety.spec.ts`), so
the API this project relies on is checked against whatever Node is executing.

Probe command (reproduced in the test suite):

```powershell
node --no-warnings -e "const s = require('node:sqlite'); const d = new s.DatabaseSync(':memory:'); console.log(JSON.stringify({ node: process.version, exports: Object.keys(s).sort(), sqlite: d.prepare('SELECT sqlite_version() AS v').get().v })); d.close()"
```

Observed:

```json
{"node":"v24.13.0","exports":["DatabaseSync","Session","StatementSync","backup","constants"],"sqlite":"3.50.4"}
```

| Capability | Result |
| --- | --- |
| `import { DatabaseSync } from 'node:sqlite'` | works |
| `new DatabaseSync(path)` / `new DatabaseSync(':memory:')` | works |
| `CREATE TABLE`, `INSERT` | works |
| Parameterized `SELECT` (`?`, `$name`, `:name`) | works |
| `COLLATE NOCASE` matching | works |
| `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` | works |
| `PRAGMA user_version` | works, default `journal_mode = delete` |
| `close()`, reopen a persisted file | works |
| Use after `close()` | throws `ERR_INVALID_STATE: database is not open` |
| Double `close()` | throws `ERR_INVALID_STATE` — so `close()` is guarded in code |
| `readOnly: true` open; write attempt | opens; write throws `ERR_SQLITE_ERROR` |
| `readOnly` open of a missing file | `ERR_SQLITE_ERROR` |
| Open with a missing parent directory | `ERR_SQLITE_ERROR: unable to open database file` |
| `exec()` with several statements | **runs all of them** — hence `exec` is never given caller text |

API shape actually used (re-measured with `Object.getOwnPropertyNames`):

```text
module  : DatabaseSync, Session, StatementSync, backup, constants
statement: all, columns, constructor, get, iterate, run,
           setAllowBareNamedParameters, setAllowUnknownNamedParameters,
           setReadBigInts, setReturnArrays
run()   -> { lastInsertRowid, changes }
get()   -> object | undefined
all()   -> object[]
```

Two facts the design had to accommodate, both discovered by probing rather than
from model knowledge:

1. **There is no transaction helper.** `DatabaseSync` has no `.transaction()`
   method, so transactions are issued as `BEGIN IMMEDIATE` / `COMMIT` /
   `ROLLBACK` literals, wrapped in a helper that rolls back on throw.
2. **`node:sqlite` is experimental in Node 24.13.0** and prints
   `(node:N) ExperimentalWarning: SQLite is an experimental feature and might
   change at any time` on first use. This is left visible rather than
   suppressed: hiding it would hide a real fact about the dependency. It is
   recorded here, and §15 lists it as a residual risk. It appears in the
   isolated DSH process's stderr and in the build/test tooling's stderr; `L04`
   confirms the host boot log carries no loader failure for this plugin.

**Verdict: `node:sqlite` is available and sufficient. No native addon, no
`better-sqlite3` and no WASM SQLite was introduced.**

## 4. Dictionary architecture

```text
POST /api/dsh-word-lookup          src/host/route.ts   (path literal only)
        |
        v
lookup service                     src/host/lookup.ts
  HTTP semantics, validation, wire mapping, settings echo
        |
        v
Dictionary interface               src/host/dictionary.ts
  lookup(normalizedQuery) -> hit | miss ; close()
        |
        v
SQLiteDictionary                   src/host/sqlite-dictionary.ts
  the only module that touches node:sqlite
        |
        v
fixture schema + rows              src/host/fixture.ts
  self-contained; zero imports

path resolution                    src/host/fixture-db.ts
  <package root>/fixtures/dictionary.fixture.db
```

- The route never writes SQL; the storage layer never builds a `Response`.
- The wire contract lives in `src/shared/protocol.ts` and is a leaf module; the
  dictionary's own record types carry provenance (`source`, `sourceId`, `score`)
  the browser has no use for, and the projection between them happens in exactly
  one function (`toWire` in `src/host/lookup.ts`).
- The Phase 1 stub is **removed**. It is not kept as a test double either:
  every handler test answers from a real SQLite store over the bundled fixture
  in `:memory:`, so no fake can disagree with the production path.
- `src/host/fixture.ts` imports nothing. That is load-bearing rather than
  stylistic: `scripts/build-fixture-db.mjs` imports it directly as TypeScript
  and relies on Node's type stripping, which does not rewrite `.js` specifiers.
  One source of truth produces both the runtime data and the on-disk database.

### Lifecycle

One `ctx.effect` in `src/index.ts` owns the whole host surface:

```text
open the fixture database
  -> register the exact Fetch route
     -> on unload: unregister the route, then close the database

if the open fails, or the registration throws: close, then propagate
```

- The open happens **before** the registration, so a store that cannot be opened
  fails the load instead of leaving a route that answers 500 to everything.
- `close()` is idempotent, and a failed open closes the handle it had already
  acquired, so a failed initialization cannot leave a half-open resource.
- There is **no connection pool**. One lifecycle owns at most one connection.

### Host-only boundary

`node:sqlite` appears in exactly one file, `src/host/sqlite-dictionary.ts`. This
is asserted twice: over the sources by `tests/host-sqlite-safety.spec.ts`, and
over the emitted bytes by `scripts/check-bundle.mjs` (§10).

## 5. SQLite schema

Materialised by `src/host/fixture.ts`; validated by `validateFixture`.

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  word           TEXT PRIMARY KEY COLLATE NOCASE,
  phonetic       TEXT,
  definition_en  TEXT,
  translation_zh TEXT,
  pos            TEXT,
  exchange       TEXT,
  frequency      INTEGER
);

CREATE TABLE IF NOT EXISTS forms (
  form      TEXT PRIMARY KEY COLLATE NOCASE,
  headword  TEXT NOT NULL,
  kind      TEXT
);

CREATE TABLE IF NOT EXISTS examples (
  id        INTEGER PRIMARY KEY,
  headword  TEXT NOT NULL COLLATE NOCASE,
  english   TEXT NOT NULL,
  chinese   TEXT,
  source    TEXT,
  source_id TEXT,
  score     REAL
);

CREATE INDEX IF NOT EXISTS idx_forms_headword    ON forms (headword COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_examples_headword ON examples (headword COLLATE NOCASE);
```

Two indexes are added and no more. Each is justified by a query the dictionary
actually issues; an index nothing reads is a cost with no benefit, and Phase 3 is
not a production corpus optimisation. (`forms(form)` and `entries(word)` are
already covered by their primary keys — visible as `sqlite_autoindex_*`.)

Schema and content revision metadata are written into `meta`:

```json
[{"key":"entries_count","value":"7"},
 {"key":"example_source","value":"dsh-word-lookup-fixture"},
 {"key":"examples_count","value":"12"},
 {"key":"fixture_version","value":"phase3-fixture-1"},
 {"key":"forms_count","value":"11"},
 {"key":"generator","value":"scripts/build-fixture-db.mjs"},
 {"key":"schema_version","value":"1"}]
```

The `*_count` values are derived from the fixture arrays rather than written out,
so a row added to the fixture cannot leave the metadata lying about the file.

## 6. Fixture data

Generated at `fixtures/dictionary.fixture.db` (40 960 bytes).

| | count |
| --- | --- |
| entries | 7 |
| forms | 11 |
| examples | 12 |
| example source | `dsh-word-lookup-fixture` (written for this project) |

| headword | POS | phonetic | Chinese | covers |
| --- | --- | --- | --- | --- |
| `derive` | verb | `/dɪˈraɪv/` | 导出；派生；源自 | plain exact entry |
| `go` | verb | `/ɡəʊ/` | 去；走；进行 | irregular morphology target |
| `tooth` | noun | `/tuːθ/` | 牙齿；齿 | irregular plural target |
| `conservation` | noun | `/ˌkɒnsəˈveɪʃn/` | 守恒；保存；保护 | single-word physics vocabulary |
| `wave function` | noun phrase | `/weɪv ˈfʌŋkʃn/` | 波函数 | multi-word phrase |
| `wave` | noun | `/weɪv/` | 波；波浪 | **the word a splitter would answer with** |
| `function` | noun | `/ˈfʌŋkʃn/` | 函数；功能 | **the word a splitter would answer with** |

`wave` and `function` are present on purpose. Without them, an implementation
that split `wave function` into two queries would fail only by returning nothing;
with them it fails by returning the **wrong headword**, which is a far sharper
test. `B33` asserts exactly that.

Forms (`form` → `headword`, with the kind stored explicitly):

```text
derived -> derive (past)          went  -> go (past)
derives -> derive (3rd sg.)       gone  -> go (past participle)
deriving-> derive (present part.) goes  -> go (3rd sg.)
teeth   -> tooth (plural)         going -> go (present participle)
wave functions -> wave function (plural)
waves -> wave (plural)            functions -> function (plural)
```

Every fixture headword has a phonetic, a POS and a Chinese translation. Every
headword has one or two examples, none duplicated, with explicit ids and scores.
No example is copied from ECDICT, Tatoeba or any other corpus, and none claims to
be: the `source` column records `dsh-word-lookup-fixture`.

### Fixture builder

`scripts/build-fixture-db.mjs`:

| Property | How it is met |
| --- | --- |
| deterministic | all rows are literals; ids are explicit; no timestamp, random value or environment fact is recorded |
| rerunnable | re-running over an existing file validates it and leaves it alone (or repairs a stale revision) |
| transaction | one `BEGIN IMMEDIATE` … `COMMIT` for the whole seed, `ROLLBACK` on throw |
| validates schema | `validateFixture` checks tables, revisions, counts and dangling references |
| validates row counts | counts compared against the fixture definition **and** against `meta`'s own declarations |
| closes the DB | `close()` on both the success and the failure path |
| overwrite is explicit | without `--force` the existing file is used; `--force` deletes and rebuilds |
| cannot reach a corpus path | the resolved target must be inside `<repo>/fixtures/` **and** named `dictionary.fixture.db`; there is no flag that widens this |
| determinism is measured | a second build in a scratch directory is compared by logical dump |

Verified guard refusals (real runs, exit 2 each):

```text
$ node scripts/build-fixture-db.mjs --out corpus.db
  refusing to write outside fixtures\: E:\…\dsh-word-lookup\corpus.db
$ node scripts/build-fixture-db.mjs --out fixtures\ecdict.db
  refusing to write "ecdict.db": a fixture database must be named
  dictionary.fixture.db
```

Determinism, measured:

```text
build-fixture-db: built fixtures\dictionary.fixture.db
  entries 7   forms 11   examples 12
  file 40960 bytes  sha256 E5A0F5E379705853BBBE0E1AC29E3F84D06B608A2A107D776CF1A5AF75496A50
  determinism  logical dump identical: true (bytes identical: true)
```

Both builds produced identical bytes *as well as* identical content. That is
reported, not claimed as a promise: the builder asserts the logical dump, because
SQLite is free to lay pages out differently and a byte comparison would be a
claim the toolchain cannot keep. `tests/host-fixture-db.spec.ts` asserts the same
thing through the same code path.

## 7. Normalization

One implementation, `src/shared/text.ts`, used by both halves. The order is the
product specification's:

```text
raw selection
  -> NFKC                    fold compatibility characters
  -> trim / collapse runs of whitespace
  -> strip surrounding punctuation
  -> lowercase
```

**NFKC was missing before Phase 3 and was added by it.** The product
specification (`docs/01-product-spec.md` §归一化) puts a Unicode NFKC fold first,
with a note to test abbreviations and apostrophes; the Phase 3 brief repeats it.
The pre-Phase-3 implementation went straight to whitespace collapsing, so a
full-width or ligature-bearing selection never reached the dictionary as an
English word. The fold runs **first** because it creates characters the later
steps must see: `．` folds to `.` and only then reads as edge punctuation; NBSP
folds to a space and only then collapses; `ﬁ` folds to `fi`.

The specification's "保留词内 apostrophe / hyphen" is honoured because only
*edge* punctuation is removed: `don't`, `don’t` and `time-dependent` survive
intact. NFKC deliberately does not fold `’` to `'`, and both spellings are kept
as written rather than being normalised into each other.

Required cases, all asserted (`tests/shared-text.spec.ts`):

| input | normalized | resolves to |
| --- | --- | --- |
| `" derive "` | `derive` | `derive` |
| `"derived"` | `derived` | `derive` (via `forms`) |
| `"WENT"` | `went` | `go` (via `forms`) |
| `"wave function"` | `wave function` | `wave function` (exact phrase) |
| `"  Wave   Function. "` | `wave function` | `wave function` |
| `"ｄｅｒｉｖｅ"` | `derive` | `derive` (NFKC) |

Measured in the isolated browser through the real shortcut (`B38`/`R38`):

```text
snapshotText="ｄｅｒｉｖｅ"
body={"found":true,"query":"derive","headword":"derive",…,"source":"sqlite-fixture"}
```

And explicitly **not** done, asserted as misses rather than assumed:

| not done | evidence |
| --- | --- |
| aggressive stemming | `conservations` → miss (not `conservation`) |
| fuzzy spelling correction | `derve`, `drived`, `teath` → misses |
| AI lemma guessing | `wented`, `goed` → misses |
| silent phrase splitting | `wave function` → the phrase, never `wave` or `function` |

## 8. Lookup precedence

```text
raw selection
  -> normalize
  -> exact entry            SELECT … FROM entries WHERE word = ?     (COLLATE NOCASE)
  -> if missing, forms      SELECT headword FROM forms WHERE form = ?
  -> headword entry         SELECT … FROM entries WHERE word = ?
  -> examples               SELECT … FROM examples WHERE headword = ? ORDER BY score DESC, id ASC
  -> result
```

Exact first, always. An entry and a form can never disagree, because the entry is
consulted before the `forms` table is touched — which is what makes an exact
phrase outrank morphology and splitting. Examples are ordered
`score DESC, id ASC`: `score DESC` leaves a `NULL` score last (SQLite sorts NULL
below every other value) and `id ASC` makes the order total, so two equal scores
can never come back in a different order between builds. No ranking beyond that
is attempted in Phase 3.

## 9. Result contract

`src/shared/protocol.ts`, extended without changing the transport route,
media type, body limit or any refusal code that Phase 1 verified.

```ts
interface LookupFoundResponse {
  ok: true
  found: true
  query: string                    // normalized query actually looked up
  headword: string
  phonetic: string | null
  meanings: { partOfSpeech: string | null
              definition: string | null      // English
              translation: string | null }[] // Chinese, '；'-separated glosses
  forms: { form: string; kind: string | null }[]
  matchedForm: string | null       // the inflected surface form matched, or null
  examples: { en: string; zh: string | null }[]
  source: 'sqlite-fixture'
  settings: { autoDoubleClick: boolean; autoSelection: boolean }
}
```

Mapping to the requirements:

| required | expressed as |
| --- | --- |
| headword | `headword` |
| phonetic / pronunciation text | `phonetic`, explicitly nullable |
| POS | `meanings[].partOfSpeech` |
| Chinese meaning | `meanings[].translation` (glosses separated by `；`, split for display by `splitGlosses`) |
| inflection / lemma relationship | `headword` + `matchedForm` + `forms[]` |
| examples | `examples[].en` / `examples[].zh` |

Null semantics are explicit throughout: a field with nothing behind it is `null`
(never an empty string, never invented content), and an entry with neither a
definition nor a translation is a hit with `meanings: []` rather than a miss. A
quadrant of the answer is emitted even when empty, so a client cannot mistake
"absent" for "unknown".

`source` is a closed union containing exactly one value, `'sqlite-fixture'`.
There is **no** name in it for a corpus, a third-party dataset or a guess, so a
payload cannot claim a provenance this build does not have. The stub is gone: the
runtime no longer returns `source: 'stub'`, asserted both statically
(`check-bundle`) and in the isolated browser (`B29`/`R29`).

## 10. Security

### Parameterized SQL only

Every query is a fixed literal prepared once, with the query bound as a
parameter. This is asserted three ways:

1. by **effect** — hostile queries are misses and the schema is unchanged
   (`tests/host-dictionary.spec.ts`, `tests/host-lookup.spec.ts`);
2. by **source scan** — no SQL literal in `src/host/sqlite-dictionary.ts` or
   `src/host/fixture.ts` contains an interpolation, and no `.exec()` receives
   anything but a literal or a named constant;
3. by **live measurement** — through the real route in the isolated browser
   (`B36`/`R36`).

Tested inputs include `'`, `"`, `;`, `--`, `' OR '1'='1`,
`'; DROP TABLE entries; --`, `"; DROP TABLE forms; --`,
`' UNION SELECT word FROM entries --`,
`'); INSERT INTO entries (word) VALUES ('x'); --`.

Measured through the running route (`B36`):

```json
[{"query":"'; DROP TABLE entries; --","status":200,"body":{"found":false,"query":"drop table entries"}},
 {"query":"' OR '1'='1","status":200,"body":{"found":false,"query":"or '1'='1"}},
 {"query":"\"; DROP TABLE forms; --","status":200,"body":{"found":false,"query":"drop table forms"}},
 {"query":"' UNION SELECT word FROM entries --","status":200,"body":{"found":false,"query":"union select word from entries"}},
 {"query":"'); INSERT INTO entries (word) VALUES ('x'); --","status":200,"body":{"found":false,"query":"insert into entries (word) values ('x"}}]
```

No 5xx, no schema change, and the dictionary still answers `derive` afterwards.
Note that these are `200 found:false`, not SQL errors: the metacharacters are
treated as ordinary query text, and the trailing SQL comment is removed by the
edge-punctuation rule rather than by anything SQL-aware.

`exec()` is the one API that runs multiple statements in `node:sqlite`. It is
given only literals — schema DDL and transaction control — and never anything
derived from a request.

### No network, no AI

| claim | evidence |
| --- | --- |
| the host half makes no outbound call | source scan (`fetch(`, `node:http(s)`) + `check-bundle`: *host bundle makes no outbound call of its own* |
| no model or provider is imported | source scan + `check-bundle`: *host bundle imports no model provider package* |
| the client half reaches the network from exactly one call site, the lookup transport | `check-bundle` (unchanged Phase 2 assertion) |
| no dictionary content is bundled to the browser | 12 client-bundle assertions (§ below) |

Client-bundle assertions added by Phase 3 — each of these must be **absent** from
`lib/client.js`: `node:sqlite`, `DatabaseSync`, `StatementSync`, `better-sqlite3`,
`sqlite3`, `CREATE TABLE`, `INSERT INTO`, `DELETE FROM`, `PRAGMA`,
`dictionary.fixture`, `fixtures/`, `dictionaryPath`, any Node built-in `require`,
any filesystem/path API, and any SQL statement shape. The SQL check matches
statement *shapes* (`SELECT … FROM x`, `CREATE TABLE x`, `ORDER BY x DESC`, …)
rather than bare keywords, because the client legitimately contains the word
`select` inside the composer-exclusion CSS selector — a keyword search would
report a false positive and teach the next reader to ignore the check.

### Credential redaction

`scripts/redact.mjs` scrubs structurally at write time; `scripts/scan-credentials.mjs`
re-checks independently. The scan looks for a **value**, not a field name: it
finds every `token=`, measures the run of token-alphabet characters after it, and
fails on anything long enough to be a credential. It also fails when an
enumerated exception stops matching, so an exception cannot silently widen.

| check | result |
| --- | --- |
| `npm run scan:credentials` | `PASS — no usable launch token in any tracked file or evidence directory` |
| files scanned | 97 (tracked + `docs/evidence` + `verify-out` + `reports`) |
| credential-shaped values found | 4, all of them the two enumerated synthetic fixtures — two occurrences in `tests/redact.spec.ts` and two in the scanner's own exception list, which has to name the value it excuses |
| negative control | a token planted in `docs/evidence/` → `FAIL`, exit 1; removed → `PASS`, exit 0 |
| tokens in the committed Phase 3 report | 7 × `token=<redacted>`, 0 unredacted |
| live isolated-instance credential in any committed/evidence file | **0 occurrences** |

The two same-shaped 43-character values in `tests/redact.spec.ts` were
**replaced** during this phase. They were fabricated test fixtures from Phase 2
(confirmed absent from the isolated environment's own credential store, and the
live isolated credential appears in zero committed files), but a value that
merely *looks* like a credential is a false positive every future scan has to
reason about, so they are now unmistakably labelled
(`NOTAREALCREDENTIAL…`, `FIXTUREONLYVALUE…`) while keeping the real 43-character
length and alphabet so the scrub is still exercised against a faithful shape.

`tests/redact.spec.ts` covers the `?token=` form, a full launch URL, the
`status: 'ERROR'` report path written from the harness's top-level catch (message
+ stack + recorded result + boot log), nested objects and arrays.

## 11. Tests

`npm run verify` → **PASS**

| step | result |
| --- | --- |
| fixture | built and validated |
| typecheck | clean |
| test | **12 files, 224 tests, 0 failures** |
| build | exit 0 |
| bundle-static-checks | **69/69** |
| credential-scan | PASS |

Coverage added by Phase 3:

| file | tests | content |
| --- | --- | --- |
| `tests/host-dictionary.spec.ts` | 34 | exact, case-insensitive, phrase, regular/irregular morphology, form lists, examples, unknown, lifecycle, closed-store behaviour |
| `tests/host-fixture-db.spec.ts` | 23 | path resolution, schema/index creation, revisions, counts, determinism, repair, persistence, reopen, read-only, validation failures |
| `tests/host-sqlite-safety.spec.ts` | 15 | capability probe, transactions, persistence, use-after-close, injection effect, source scans, host/client boundaries |
| `tests/shared-text.spec.ts` | 31 | normalization incl. NFKC, apostrophe/hyphen, gloss splitting, normalization→dictionary integration |
| `tests/host-lookup.spec.ts` | 24 | route success/refusal/400 boundary/96–97 code points/injection/closed store/settings echo |
| `tests/redact.spec.ts` | 12 | token scrubbing incl. the ERROR report path |

Every Phase 3 brief requirement is covered, including the ones that are easy to
assert vacuously:

- **reopen persisted DB** — a file-backed store is closed and reopened
  read-only, and the reopened store reports `created: false`, `seeded: false`;
- **close lifecycle** — answering after `close()` raises
  `DictionaryUnavailableError` rather than crashing, and `close()` is idempotent;
- **repeated open/close** — 25 in-memory and 10 file-backed cycles complete with
  no handle exhaustion and no double-close throw;
- **no wrong examples** — the phrase entry's examples are asserted disjoint from
  both `wave`'s and `function`'s, so an association bug cannot pass;
- **deterministic examples** — the same lookup twice returns an identical
  sequence;
- **97-code-point reject / 96 accept** — asserted with both ASCII and astral
  characters, so a UTF-16 `.length` implementation fails;
- **query parameters, not interpolation** — asserted by source scan and by
  effect (§10).

Phase 1 and Phase 2 assertions were **not weakened**. They were updated only
where the mandated contract changed: `source: 'stub'` became
`source: 'sqlite-fixture'` (the brief's §15 requires the stub to leave the
runtime path), and the Phase 1 `meanings` / `examples` shapes gained the fields
§11 requires. The 9 pre-existing spec files remain, and the gesture suite
(31 tests), the selection suite (14), the client runtime suite (15), the
isolation-guard suite (14) and the config/route suites are untouched and pass.

## 12. Isolated runtime E2E

```text
$ npm run test:runtime
ISOLATION CHECK: PASS          (runner gate)
ISOLATION CHECK: PASS          (harness gate)
…
phase1-verify: PASS — 97/97 checks
```

| | value |
| --- | --- |
| `DSH_HOME` | `C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home` |
| profile | `word-lookup-test` |
| port | `50991` |
| DSH / Node | `0.2.0-rc.2` / `v24.13.0` |
| browser | Chromium `153.0.8010.12` |
| authentication | the isolated instance's own launch token |
| result | **97/97**, `summary.failed = []` |

97 = Phase 1's 64 + Phase 2's 13 + **Phase 3's 20** (10 checks × 2 boots:
`B29`–`B38` and `R29`–`R38`). Every pre-existing check still passes unchanged.

The suite boots the isolated instance twice to prove settings persistence, and
each Phase 3 check runs on **both** boots, so a dictionary that only worked on a
cold start would fail.

## 13. Runtime dictionary evidence

All of the following went through the product's **only** trigger: a real
selection inside a conversation node, then `Primary+Shift+L`. The payload was
read off the wire, not from the card.

### `derive` — exact entry (`B29`/`R29`)

```json
{"found":true,"query":"derive","headword":"derive","phonetic":"/dɪˈraɪv/","matchedForm":null,
 "meaningCount":1,"firstMeaning":{"partOfSpeech":"verb",
   "definition":"obtain something from a specified source; originate in","translation":"导出；派生；源自"},
 "forms":["derived","derives","deriving"],"exampleCount":2,"source":"sqlite-fixture"}
```

`requests = 1`, `outcome = found`, card headword `derive /dɪˈraɪv/`.

### `derived` → `derive` (`B30`/`R30`)

```json
{"found":true,"query":"derived","headword":"derive","matchedForm":"derived",
 "forms":["derived","derives","deriving"],"source":"sqlite-fixture"}
```

### `went` / `gone` → `go` (`B31`/`R31`)

```json
{"query":"went","headword":"go","matchedForm":"went","phonetic":"/ɡəʊ/",
 "firstMeaning":{"partOfSpeech":"verb","translation":"去；走；进行"},
 "forms":["goes","going","gone","went"],"source":"sqlite-fixture"}
{"query":"gone","headword":"go","matchedForm":"gone","forms":["goes","going","gone","went"]}
```

### `teeth` → `tooth` (`B32`/`R32`)

```json
{"query":"teeth","headword":"tooth","matchedForm":"teeth","phonetic":"/tuːθ/",
 "firstMeaning":{"partOfSpeech":"noun","translation":"牙齿；齿"},
 "forms":["teeth"],"exampleCount":2,"source":"sqlite-fixture"}
```

### `wave function` — exact phrase, never split (`B33`/`R33`)

```json
{"found":true,"query":"wave function","headword":"wave function","matchedForm":null,
 "phonetic":"/weɪv ˈfʌŋkʃn/","firstMeaning":{"partOfSpeech":"noun phrase","translation":"波函数"},
 "forms":["wave functions"],"exampleCount":2,"source":"sqlite-fixture"}
```

### unknown (`B34`/`R34`)

```json
{"ok":true,"found":false,"query":"unknowntoken","source":"sqlite-fixture",
 "settings":{"autoDoubleClick":false,"autoSelection":false}}
```

`status = 200`, `outcome = not-found`, card renders `no entry for "unknowntoken"`.
**Not** a 400, 404 or 500.

### payload completeness (`B35`/`R35`)

`conservation` returned headword, non-empty phonetic, `partOfSpeech: "noun"`,
Chinese translation containing 守恒, an English definition, an empty `forms`
array (correct — the fixture gives it none), `matchedForm: null`, two examples
and `source: "sqlite-fixture"`, with the settings echo matching the client
snapshot on both boots.

### examples (`B37`/`R37`)

```text
derive        : 2 examples, identical across two consecutive lookups
wave function : 2 examples, disjoint from wave's and function's
wave          : 1 example
function      : 2 examples (incl. the "delta function" sentence, which must not leak)
```

### NFKC (`B38`/`R38`)

A full-width selection `ｄｅｒｉｖｅ` produced `query: "derive"`,
`headword: "derive"`, `source: "sqlite-fixture"`.

## 14. Trigger regression

This is Phase 3's hard boundary, and it holds: **no gesture path calls the lookup
transport**, whatever the two switches say. Their values persist, are readable
and are displayed; they still drive nothing, and enabling them is the next
phase's job.

| check | measurement |
| --- | --- |
| 100 real drags | `drags = 100` |
| 100 real double clicks | `doubleClicks = 100` |
| cancels | `0` |
| **lookup requests during the gesture storm** | **0** |
| shortcut after the storm | `derive` selected + `Primary+Shift+L` → **exactly 1** `POST /api/dsh-word-lookup` |
| that one request's answer | `found: true`, `headword: "derive"`, `source: "sqlite-fixture"` |

Recorded as `B27`/`R27` and `B28`/`R28`; `B28` additionally asserts the response
came from SQLite. The gesture counters are asserted alongside the request count
on purpose: a request count of zero is worthless on its own, because it holds
equally for a plugin whose gesture listeners never ran.

Automatic lookup is **disabled**, and this phase did not add a `drag →` or
`dblclick →` path. Confirmed by construction: the client half still reaches the
network from exactly one call site, and `check-bundle` asserts it.

## 15. Production safety confirmation

```text
production DSH profile touched:   NO
production session data touched:  NO
production port touched:          NO
production loader touched:        NO
production routes touched:        NO
```

Checked by these measurements:

| fact | value |
| --- | --- |
| production `DSH_HOME` | `C:\Users\20659\.dsh` — read-only inspection only |
| live profile | `desktop` |
| live port `19387` | held by pid `46308` before and after, never restarted |
| plugin in the production profile | `bundleListed: false`, `dependency: null`, `link.present: false` |
| production session data | never read, never copied |
| production loader / routes | never touched |
| test port `50991` after the run | no listener; only `TimeWait` remnants of closed connections |
| isolated instance processes | both stopped by the harness (`H02` asserts the first exits cleanly) |

No unrelated process was killed, no port was taken from another holder, and no
unrelated DSH instance was touched.

## 16. Deviations

1. **NFKC was missing and is now implemented** (§7). This is a correction of a
   pre-existing gap against the product specification, not a Phase 3 invention.
   It changes normalization for non-ASCII input only; every Phase 1 and Phase 2
   assertion on ASCII input is unchanged.
2. **One sense per headword.** The brief's schema pins `entries.word` as the
   primary key, so a headword has exactly one `pos` / `definition_en` /
   `translation_zh` triple and `meanings` has length 0 or 1. Several Chinese
   glosses travel inside the one cell (`导出；派生；源自`), which is the source
   dictionaries' own convention and the shape the specification renders as
   "中文义项 1 / 2 / …"; `splitGlosses` splits them for display. The array shape
   is kept so a later schema can carry more senses without a wire change.
3. **`exchange` is stored but not parsed.** The `forms` table is the resolution
   path, and the `exchange` cell is carried for fidelity to the source
   dictionaries' column shape. A constant enumerating its prefixes existed
   briefly and was removed as dead code rather than kept for decoration.
4. **`metadata` revisions alone are not trusted.** The first implementation
   decided staleness from `meta.schema_version` / `fixture_version` only. It
   served a stale file during development when the `meta` keys changed without a
   revision bump — caught by a failing test, not in the field. The rule is now
   "if the database is not a valid, current fixture, rebuild it", decided by
   `validateFixture`. Rebuilding is safe precisely because the fixture is derived
   from literals rather than authored.
5. **A controlled 500 was added.** `DictionaryUnavailableError` maps to
   `500 { error: 'dictionary-unavailable' }`. The brief fixes the contract for a
   *valid but absent* word (200 / `found: false`) and for *malformed input*
   (400); it does not cover a store that cannot answer. Reporting a lifecycle bug
   as `found: false` would present a broken dictionary as a small vocabulary.
6. **Two migration turns are still to come for `package.json.files`.** See
   residual risk 2.
7. **`scripts/phase1-verify.mjs` keeps its Phase 1 name** while now covering
   Phases 1–3. It is still the only runtime entry point, still gated on the first
   executable statement, and renaming it would churn every isolation and evidence
   reference for no behavioural gain. The name is a misnomer and is recorded as
   one.

## 17. Residual risks

1. **The dictionary is a fixture of 7 headwords, not a corpus.** It proves the
   storage, precedence, morphology and example mechanics; it says nothing about
   coverage. Importing ECDICT / Tatoeba is a later phase, and no result here
   should be read as evidence about a production dictionary.
2. **The generated database is not published.** `fixtures/` is gitignored and is
   not listed in `package.json.files`. A published tarball would not contain it,
   and the host would then try to materialise it inside its own install
   directory at first open — which fails on a read-only install. This is a
   release-phase decision (ship the file, or move the path to a writable
   per-user location); it does not affect the runtime measured here, because the
   isolated profile consumes the package through a junction into this repository.
3. **`node:sqlite` is experimental in Node 24.13.0.** It prints an
   `ExperimentalWarning` on use, and a future Node release may change the API.
   `tests/host-sqlite-safety.spec.ts` re-measures the API on every run, so a
   change fails loudly instead of silently.
4. **The length ceiling is measured on the raw selection, not on the folded
   text.** NFKC can expand (`ﬁ` → `fi`), so a 96-code-point selection can
   normalize to more than 96 code points. This is Phase 1 behaviour, unchanged,
   and both halves apply the same rule — but the asymmetry is real.
5. **CJK punctuation is not stripped.** NFKC folds full-width ASCII punctuation
   but leaves `。`, `、`, `「」` alone, so a selection that drags one of those in
   keeps it. Out of scope for an English–Chinese lookup, and recorded rather
   than silently handled.
6. **The automatic triggers are still inert.** Both switches persist and are
   mirrored, and gesture classification is complete, so the trigger gate is the
   only missing piece — but until it exists the settings UI promises something
   the plugin does not deliver.
7. **No benchmarking.** The dictionary is opened once per lifecycle and each
   lookup is a handful of indexed queries on 30 rows, so no timing was measured;
   nothing here should be read as a performance claim.
8. **`getBoundingClientRect()` still runs on every `selectionchange`**, carried
   over from Phase 2. Correct and measured working; a Phase 7 performance
   question.
9. **The desktop client remains untested.** Every measurement here is the Web
   client.
10. **No remote is configured and nothing was pushed.** No force push, no
    history rewrite, and the sealed Phase 1 / Phase 2 commits were not amended.

## 18. Phase 4 readiness

```text
PASS — Phase 3 COMPLETE / Phase 4 READY
```

What Phase 4 inherits, and what it may rely on:

- a **real local dictionary** behind a `Dictionary` interface, with precedence
  fixed and tested: exact entry → exact phrase → `forms` → examples;
- a **result contract** that already carries headword, phonetic, POS, Chinese
  meaning, the inflection → lemma relationship and examples, with explicit `null`
  semantics;
- a **host-owned lifecycle** — one open per load, `close()` on unload,
  idempotent, no pool — that a trigger gate can call into without owning a
  resource;
- a **provable boundary**: the client half has exactly one network call site and
  contains no database, no SQL and no Node built-in;
- a **measured trigger baseline**: 100 drags + 100 double clicks → 0 requests,
  and the shortcut → exactly 1, both re-measured with the dictionary in place.

What Phase 4 must add, and must not assume already exists:

1. the automatic trigger gate that consults `autoDoubleClick` / `autoSelection`
   and turns a classified gesture into a lookup;
2. whatever de-duplication and cancellation that gate needs;
3. an honest answer for the settings UI, which currently persists two switches
   that drive nothing.

Nothing in Phase 3 enables any of that. The two switches are still inert, and
the manual shortcut is still the only path that reaches the dictionary.

## 19. Files changed

New:

```text
src/host/fixture.ts                    deterministic fixture data + DDL + validation
src/host/sqlite-dictionary.ts          the only node:sqlite consumer
src/host/fixture-db.ts                 package-owned path resolution + host open
scripts/build-fixture-db.mjs           the fixture builder
scripts/scan-credentials.mjs           independent credential scan
tests/host-dictionary.spec.ts          dictionary contract and lookup semantics
tests/host-fixture-db.spec.ts          fixture build, determinism, persistence
tests/host-sqlite-safety.spec.ts       capability probe, SQL safety, boundaries
docs/PHASE3_EVIDENCE.md                this report
docs/evidence/phase3-verification-20261001.json   the 97/97 runtime report, token-free
```

Modified:

```text
src/shared/protocol.ts                 result contract: sqlite provenance, forms, matchedForm, nullable fields
src/shared/text.ts                     NFKC fold added; splitGlosses moved here so both halves share it
src/host/dictionary.ts                 the stub replaced by the Dictionary interface + error type
src/host/lookup.ts                     lookup service: dictionary injected, wire mapping, 500 path
src/index.ts                           dictionary lifecycle inside the single ctx.effect
src/client/card.tsx                    renders nullable fields, matchedForm, forms and split glosses
scripts/verify.mjs                     fixture + credential-scan steps added
scripts/check-bundle.mjs               22 new static assertions (client boundary + host dictionary)
scripts/phase1-verify.mjs              20 new runtime checks (B29–B38, R29–R38) + response capture
package.json                           build:fixture, scan:credentials
.gitignore                             the generated fixture database
README.md                              status, dictionary section, layout
tests/host-dictionary.spec.ts          rewritten against SQLite (was the stub suite)
tests/host-lookup.spec.ts              new handler signature + Phase 3 assertions
tests/shared-text.spec.ts              NFKC and gloss coverage
tests/redact.spec.ts                   ERROR-report coverage; synthetic fixtures relabelled
```

Regenerated: `lib/index.js`, `lib/client.js`, `lib/types/**`,
`fixtures/dictionary.fixture.db`.

Nothing under `src/client/gesture.ts`, `src/client/selection.ts`,
`src/client/index.tsx`, `src/client/store.ts`, `src/client/transport.ts`,
`src/client/contracts.ts`, `src/client/lifecycle.ts`, `src/host/config.ts` or
`src/host/route.ts` changed. Phase 2's classifier and Phase 1's transport,
config and route are untouched.

## 20. Git

| | value |
| --- | --- |
| `START_SHA` | `cce8ef51edac511c85d02df2f8f8846d4406142e` |
| Branch | `master` |
| Phase 3 implementation commit | `d4c34dc6e745b8740db6a3c818d544e0317d2f5b` — `feat: add sqlite dictionary core` |
| Evidence document | committed immediately after that, as `docs: record phase 3 evidence`; `git log -1 --format=%H` prints the resulting `HEAD` |
| Worktree after commit | clean — `git status --porcelain` reports 0 entries |
| `git diff --check` | no whitespace errors |

The implementation is one commit, not several: the dictionary, the protocol
change, the tests, the harness extension and the credential scan are one
coherent change, and splitting them would have produced intermediate commits
that neither build nor pass. The only commit after it adds this document, which
cannot name its own SHA.

Git discipline observed:

```text
no force push              no remote was created
no push to an unknown remote         (no remote is configured at all)
Phase 1 / Phase 2 commits  not amended, not rebased, not rewritten
history                    not rewritten
git reset --hard           not run
git clean -fd              not run
git checkout . / restore . not run
```

The only deletions performed were of files this phase generated itself and could
prove worthless: the fixture database and its SQLite sidecars, which
`scripts/build-fixture-db.mjs` deletes before an explicit `--force` rebuild and
which are reproduced byte-for-byte by it.

```text
Production DSH environment modified during this work: NO
```
