/**
 * The host configuration schema, checked against the rules the DSH settings
 * service actually applies.
 *
 * The service reads `entry.fiber.runtime.Config`, calls `volatileForm(schema)`,
 * and drops the entry entirely when that returns `undefined` — so "the fields
 * are visible and independently editable" is a property of the schema's shape,
 * not of any code in this plugin. These tests assert that shape directly
 * rather than through a paraphrase of it.
 */

import { describe, expect, it } from 'vitest'

import {
  Config,
  readSwitch,
  readDictionaryMode,
  readCustomDictionaryPath,
  DICTIONARY_MODES,
  type DictionaryMode,
} from '../src/host/config.js'

/** The shape `volatileForm` walks: `meta.volatile` on a field node. */
interface SchemaNode {
  readonly type: string
  readonly meta: { readonly volatile?: boolean; readonly default?: unknown }
  readonly dict?: Record<string, SchemaNode>
}

describe('host Config schema', () => {
  it('is an object schema with all four v0.2.0 fields', () => {
    const schema = Config as unknown as SchemaNode
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.dict ?? {}).sort()).toEqual([
      'autoDoubleClick',
      'autoSelection',
      'customDictionaryPath',
      'dictionaryMode',
    ])
  })

  it('marks all fields volatile with correct v0.2.0 defaults', () => {
    const schema = Config as unknown as SchemaNode

    // dictionaryMode: union, volatile, default 'fixture'
    const modeNode = schema.dict?.dictionaryMode
    expect(modeNode).toBeDefined()
    expect(modeNode?.meta.volatile).toBe(true)
    expect(modeNode?.meta.default).toBe('fixture')

    // customDictionaryPath: string, volatile, default ''
    const pathNode = schema.dict?.customDictionaryPath
    expect(pathNode).toBeDefined()
    expect(pathNode?.meta.volatile).toBe(true)
    expect(pathNode?.meta.default).toBe('')

    // autoDoubleClick & autoSelection: boolean, volatile, default false
    for (const field of ['autoDoubleClick', 'autoSelection'] as const) {
      const node = schema.dict?.[field]
      expect(node, field).toBeDefined()
      expect(node?.type, field).toBe('boolean')
      expect(node?.meta.volatile, field).toBe(true)
      expect(node?.meta.default, field).toBe(false)
    }
  })

  it('keeps all fields as independent top-level fields', () => {
    // Nesting a volatile field under another volatile field is a hard parse
    // error in the settings projection, and a shared parent would make fields
    // impossible to write independently.
    const schema = Config as unknown as SchemaNode
    expect(schema.meta.volatile).toBeUndefined()
    expect(schema.dict?.dictionaryMode?.dict).toBeUndefined()
    expect(schema.dict?.customDictionaryPath?.dict).toBeUndefined()
    expect(schema.dict?.autoDoubleClick?.dict).toBeUndefined()
    expect(schema.dict?.autoSelection?.dict).toBeUndefined()
  })

  it('parses fresh install ({}) to stable references with expected defaults', () => {
    const parsed = Config({})
    expect(typeof parsed.dictionaryMode.get).toBe('function')
    expect(typeof parsed.customDictionaryPath.get).toBe('function')
    expect(typeof parsed.autoDoubleClick.get).toBe('function')
    expect(typeof parsed.autoSelection.get).toBe('function')

    expect(parsed.dictionaryMode.get()).toBe('fixture')
    expect(parsed.customDictionaryPath.get()).toBe('')
    expect(parsed.autoDoubleClick.get()).toBe(false)
    expect(parsed.autoSelection.get()).toBe(false)
  })

  it('accepts explicit valid dictionaryMode values', () => {
    for (const mode of DICTIONARY_MODES) {
      const parsed = Config({ dictionaryMode: mode })
      expect(parsed.dictionaryMode.get()).toBe(mode)
      expect(parsed.customDictionaryPath.get()).toBe('')
      expect(parsed.autoDoubleClick.get()).toBe(false)
      expect(parsed.autoSelection.get()).toBe(false)
    }
  })

  it('rejects invalid dictionaryMode values', () => {
    expect(() => Config({ dictionaryMode: 'invalid-mode' as never })).toThrow(/dictionaryMode/)
    expect(() => Config({ dictionaryMode: 'custom-sqlite' as never })).toThrow(/dictionaryMode/)
    expect(() => Config({ dictionaryMode: 123 as never })).toThrow(/dictionaryMode/)
  })

  it('accepts explicit customDictionaryPath value', () => {
    const parsed = Config({ customDictionaryPath: 'C:\\path\\to\\custom.db' })
    expect(parsed.customDictionaryPath.get()).toBe('C:\\path\\to\\custom.db')
    expect(parsed.dictionaryMode.get()).toBe('fixture')
  })

  it('reads an explicitly supplied value on the field it belongs to only', () => {
    const parsed = Config({ autoSelection: true, dictionaryMode: 'managed-ecdict' })
    expect(parsed.autoSelection.get()).toBe(true)
    expect(parsed.autoDoubleClick.get()).toBe(false)
    expect(parsed.dictionaryMode.get()).toBe('managed-ecdict')
    expect(parsed.customDictionaryPath.get()).toBe('')
  })
})

describe('readSwitch', () => {
  it('reports false for both fields when the configuration is absent', () => {
    expect(readSwitch(undefined, 'autoDoubleClick')).toBe(false)
    expect(readSwitch(undefined, 'autoSelection')).toBe(false)
  })

  it('reads through the reference on every call, so a replaced value is visible', () => {
    let current = false
    const config = {
      dictionaryMode: { get: () => 'fixture' as const },
      customDictionaryPath: { get: () => '' },
      autoDoubleClick: { get: () => current },
      autoSelection: { get: () => false },
    }
    expect(readSwitch(config, 'autoDoubleClick')).toBe(false)
    current = true
    expect(readSwitch(config, 'autoDoubleClick')).toBe(true)
  })
})

describe('readDictionaryMode', () => {
  it('reports fixture when the configuration is absent', () => {
    expect(readDictionaryMode(undefined)).toBe('fixture')
  })

  it('reads live mode through the reference on every call', () => {
    let current: DictionaryMode = 'fixture'
    const config = {
      dictionaryMode: { get: () => current },
      customDictionaryPath: { get: () => '' },
      autoDoubleClick: { get: () => false },
      autoSelection: { get: () => false },
    }
    expect(readDictionaryMode(config)).toBe('fixture')
    current = 'managed-ecdict'
    expect(readDictionaryMode(config)).toBe('managed-ecdict')
    current = 'custom'
    expect(readDictionaryMode(config)).toBe('custom')
  })
})

describe('readCustomDictionaryPath', () => {
  it('reports empty string when the configuration is absent', () => {
    expect(readCustomDictionaryPath(undefined)).toBe('')
  })

  it('reads and trims path through the reference on every call', () => {
    let current = '   '
    const config = {
      dictionaryMode: { get: () => 'custom' as const },
      customDictionaryPath: { get: () => current },
      autoDoubleClick: { get: () => false },
      autoSelection: { get: () => false },
    }
    expect(readCustomDictionaryPath(config)).toBe('')
    current = '  /user/dict/ecdict.db  '
    expect(readCustomDictionaryPath(config)).toBe('/user/dict/ecdict.db')
  })
})
