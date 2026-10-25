/**
 * Parse dictionary metadata without truncation or coercing non-string values.
 * Supported schema revisions are checked separately by each caller.
 */
export function parseDictionarySchemaVersion(value: unknown): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('schema_version must be a non-empty string')
  }
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new RangeError('schema_version must be a positive safe integer')
  }
  return version
}
