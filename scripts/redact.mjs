/**
 * Credential scrubbing for evidence files.
 *
 * Every report this project writes — the `verify-out/` working copy and the
 * copies kept in `docs/evidence/` — is meant to be publishable. The isolated DSH
 * launch token is not: the URL it travels in mints the browser session cookie
 * for that instance, and `docs/evidence/` is committed.
 *
 * The scrub therefore walks the whole value rather than a list of known field
 * names. An earlier version of the harness redacted `bootLogs` and the second
 * boot's log but missed `environment.firstBootUrl` and `environment.secondBootUrl`
 * — a field list is exactly as complete as the person who wrote it remembered to
 * be, and the cost of forgetting is a committed credential. A structural walk
 * covers a field added later without anyone having to remember.
 *
 * @module dsh-word-lookup/scripts/redact
 */

/** What a removed token is replaced with. */
export const REDACTED_TOKEN = 'token=<redacted>'

/**
 * Replace every launch token in a string.
 *
 * The pattern is built per call rather than shared: a module-level `/g` regex
 * carries `lastIndex` between uses, and this function is called on every string
 * in a report.
 *
 * @param text - the text to scrub.
 * @returns the text with every `token=…` value replaced.
 */
export function redactTokenText(text) {
  if (typeof text !== 'string') return text
  return text.replace(/token=[A-Za-z0-9._~-]+/g, REDACTED_TOKEN)
}

/**
 * Recursively replace every launch token in a JSON-shaped value.
 *
 * Returns a new value; the input is never mutated, so a caller may keep the
 * original in memory while writing the scrubbed copy.
 *
 * @param value - any JSON-shaped value: a report object, an array, or a string.
 * @returns the same shape with every token scrubbed.
 */
export function redactTokens(value) {
  if (typeof value === 'string') return redactTokenText(value)
  if (Array.isArray(value)) return value.map((entry) => redactTokens(entry))
  if (value !== null && typeof value === 'object') {
    const scrubbed = {}
    for (const [key, entry] of Object.entries(value)) {
      scrubbed[key] = redactTokens(entry)
    }
    return scrubbed
  }
  return value
}
