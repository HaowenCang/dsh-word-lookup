/**
 * Deterministic parser for ECDICT morphological `exchange` strings.
 *
 * Implements bidirectional morphological extraction:
 * - Forward variants: `p` (past), `d` (past participle), `i` (present participle),
 *   `3` (3rd singular), `r` (comparative), `t` (superlative), `s` (plural).
 * - Lemma references: `0:<lemma>/1:<kind>`.
 *
 * Mappings are normalized to `form` -> `headword` (observed surface form to canonical lemma).
 * Self-referential mappings are excluded.
 * Ambiguous forms (pointing to multiple headwords) are recorded for collision auditing
 * and excluded from the final forms table to guarantee deterministic single-headword resolution.
 *
 * @module dsh-word-lookup/host/exchange-parser
 */

export interface FormCandidate {
  readonly form: string
  readonly headword: string
  readonly kind: string | null
}

export interface AmbiguousFormRecord {
  readonly form: string
  readonly candidates: Array<{
    readonly headword: string
    readonly kinds: string[]
  }>
}

export interface ExchangeParseResult {
  /** Unambiguous forms suitable for insertion into forms table. */
  readonly forms: FormCandidate[]
  /** Ambiguous forms that collide across multiple headwords. */
  readonly ambiguous: AmbiguousFormRecord[]
  /** Statistics for auditing. */
  readonly stats: {
    readonly totalParsedForms: number
    readonly uniqueForms: number
    readonly unambiguousForms: number
    readonly ambiguousForms: number
    readonly selfReferentialExcluded: number
  }
}

const FORWARD_TAGS = new Set(['p', 'd', 'i', '3', 'r', 't', 's'])

export class ExchangeCollector {
  // formLower -> Map(headwordLower -> { headword: string, originalForms: Set<string>, kinds: Set<string> })
  readonly #formMap = new Map<
    string,
    Map<string, { headword: string; originalForms: Set<string>; kinds: Set<string> }>
  >()

  #totalParsedForms = 0
  #selfReferentialExcluded = 0

  /**
   * Process one dictionary entry's exchange string.
   *
   * @param canonical - The entry headword.
   * @param exchange - The raw exchange string from CSV.
   */
  addEntry(canonical: string, exchange: string | null | undefined): void {
    if (!exchange || typeof exchange !== 'string') return
    const trimmed = exchange.trim()
    if (!trimmed) return

    const parts = trimmed.split('/')
    let lemma0: string | null = null
    let lemma1: string | null = null

    for (const part of parts) {
      if (!part) continue
      const colonIdx = part.indexOf(':')
      if (colonIdx === -1) continue

      const type = part.slice(0, colonIdx).trim()
      const val = part.slice(colonIdx + 1).trim()
      if (!val) continue

      if (type === '0') {
        lemma0 = val
      } else if (type === '1') {
        lemma1 = val
      } else if (FORWARD_TAGS.has(type)) {
        this.#addMapping(val, canonical, type)
      }
    }

    if (lemma0) {
      this.#addMapping(canonical, lemma0, lemma1 ?? null)
    }
  }

  #addMapping(form: string, headword: string, kind: string | null): void {
    const trimmedForm = form.trim()
    const trimmedHw = headword.trim()
    if (!trimmedForm || !trimmedHw) return

    this.#totalParsedForms += 1

    const formLower = trimmedForm.toLowerCase()
    const hwLower = trimmedHw.toLowerCase()

    if (formLower === hwLower) {
      this.#selfReferentialExcluded += 1
      return
    }

    let hwMap = this.#formMap.get(formLower)
    if (!hwMap) {
      hwMap = new Map()
      this.#formMap.set(formLower, hwMap)
    }

    let record = hwMap.get(hwLower)
    if (!record) {
      record = { headword: trimmedHw, originalForms: new Set(), kinds: new Set() }
      hwMap.set(hwLower, record)
    }

    record.originalForms.add(trimmedForm)
    if (kind) {
      record.kinds.add(kind)
    }
  }

  /**
   * Resolve all collected mappings into unambiguous forms and ambiguous collisions.
   */
  resolve(): ExchangeParseResult {
    const forms: FormCandidate[] = []
    const ambiguous: AmbiguousFormRecord[] = []

    // Sort form keys for deterministic output
    const sortedFormKeys = Array.from(this.#formMap.keys()).sort((a, b) => a.localeCompare(b))

    for (const formKey of sortedFormKeys) {
      const hwMap = this.#formMap.get(formKey)!
      if (hwMap.size === 1) {
        // Exactly one headword: unambiguous!
        const [, entry] = Array.from(hwMap.entries())[0]!
        // Deterministically select casing: preferred original form
        const form = Array.from(entry.originalForms).sort()[0] ?? formKey
        const kinds = Array.from(entry.kinds).sort()
        const kind = kinds.length > 0 ? kinds.join('') : null
        forms.push({
          form,
          headword: entry.headword,
          kind,
        })
      } else {
        // Multiple candidate headwords: ambiguous collision!
        const candidates = Array.from(hwMap.values())
          .map((v) => ({
            headword: v.headword,
            kinds: Array.from(v.kinds).sort(),
          }))
          .sort((a, b) => a.headword.localeCompare(b.headword))

        const sampleForm = Array.from(hwMap.values())[0]!.originalForms.values().next().value ?? formKey
        ambiguous.push({
          form: sampleForm,
          candidates,
        })
      }
    }

    return {
      forms,
      ambiguous,
      stats: {
        totalParsedForms: this.#totalParsedForms,
        uniqueForms: this.#formMap.size,
        unambiguousForms: forms.length,
        ambiguousForms: ambiguous.length,
        selfReferentialExcluded: this.#selfReferentialExcluded,
      },
    }
  }
}
