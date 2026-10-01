/**
 * The host configuration schema, checked against the rules the DSH settings
 * service actually applies.
 *
 * The service reads `entry.fiber.runtime.Config`, calls `volatileForm(schema)`,
 * and drops the entry entirely when that returns `undefined` — so "the two
 * switches are visible and independently editable" is a property of the schema's
 * shape, not of any code in this plugin. These tests assert that shape directly
 * rather than through a paraphrase of it.
 */

import { describe, expect, it } from 'vitest'

import { Config, readSwitch } from '../src/host/config.js'

/** The shape `volatileForm` walks: `meta.volatile` on a field node. */
interface SchemaNode {
  readonly type: string
  readonly meta: { readonly volatile?: boolean; readonly default?: unknown }
  readonly dict?: Record<string, SchemaNode>
}

describe('host Config schema', () => {
  it('is an object schema whose only fields are the two switches', () => {
    const schema = Config as unknown as SchemaNode
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.dict ?? {}).sort()).toEqual(['autoDoubleClick', 'autoSelection'])
  })

  it('marks both switches volatile with a false default', () => {
    const schema = Config as unknown as SchemaNode
    for (const field of ['autoDoubleClick', 'autoSelection'] as const) {
      const node = schema.dict?.[field]
      expect(node, field).toBeDefined()
      expect(node?.type, field).toBe('boolean')
      expect(node?.meta.volatile, field).toBe(true)
      expect(node?.meta.default, field).toBe(false)
    }
  })

  it('keeps the switches as independent top-level fields', () => {
    // Nesting a volatile field under another volatile field is a hard parse
    // error in the settings projection, and a shared parent would make the two
    // switches impossible to write independently.
    const schema = Config as unknown as SchemaNode
    expect(schema.meta.volatile).toBeUndefined()
    expect(schema.dict?.autoDoubleClick?.dict).toBeUndefined()
    expect(schema.dict?.autoSelection?.dict).toBeUndefined()
  })

  it('parses to stable references read through get()', () => {
    const parsed = Config({})
    expect(typeof parsed.autoDoubleClick.get).toBe('function')
    expect(typeof parsed.autoSelection.get).toBe('function')
    expect(parsed.autoDoubleClick.get()).toBe(false)
    expect(parsed.autoSelection.get()).toBe(false)
  })

  it('reads an explicitly supplied value on the field it belongs to only', () => {
    const parsed = Config({ autoSelection: true })
    expect(parsed.autoSelection.get()).toBe(true)
    expect(parsed.autoDoubleClick.get()).toBe(false)
  })
})

describe('readSwitch', () => {
  it('reports false for both fields when the configuration is absent', () => {
    expect(readSwitch(undefined, 'autoDoubleClick')).toBe(false)
    expect(readSwitch(undefined, 'autoSelection')).toBe(false)
  })

  it('reads through the reference on every call, so a replaced value is visible', () => {
    // `updateVolatile(target, source)` rewrites the reference's contents in
    // place; a reader that cached the first value would never see a settings
    // write. This stub models that in-place update.
    let current = false
    const config = {
      autoDoubleClick: { get: () => current },
      autoSelection: { get: () => false },
    }
    expect(readSwitch(config, 'autoDoubleClick')).toBe(false)
    current = true
    expect(readSwitch(config, 'autoDoubleClick')).toBe(true)
  })
})
