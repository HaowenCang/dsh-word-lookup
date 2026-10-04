import { describe, expect, it } from 'vitest'
import { ExchangeCollector } from '../src/host/exchange-parser.js'

describe('ExchangeCollector', () => {
  it('parses regular verb, noun, and adjective inflections', () => {
    const collector = new ExchangeCollector()
    collector.addEntry('perceive', 'd:perceived/p:perceived/3:perceives/i:perceiving')
    collector.addEntry('bright', 'r:brighter/t:brightest')
    collector.addEntry('apple', 's:apples')

    const result = collector.resolve()
    expect(result.ambiguous).toHaveLength(0)

    const map = new Map(result.forms.map((f) => [f.form.toLowerCase(), f]))
    expect(map.get('perceived')).toEqual({
      form: 'perceived',
      headword: 'perceive',
      kind: 'dp',
    })
    expect(map.get('perceives')).toEqual({
      form: 'perceives',
      headword: 'perceive',
      kind: '3',
    })
    expect(map.get('perceiving')).toEqual({
      form: 'perceiving',
      headword: 'perceive',
      kind: 'i',
    })
    expect(map.get('brighter')).toEqual({
      form: 'brighter',
      headword: 'bright',
      kind: 'r',
    })
    expect(map.get('brightest')).toEqual({
      form: 'brightest',
      headword: 'bright',
      kind: 't',
    })
    expect(map.get('apples')).toEqual({
      form: 'apples',
      headword: 'apple',
      kind: 's',
    })
  })

  it('handles reverse lemma references (0:<lemma>/1:<kind>)', () => {
    const collector = new ExchangeCollector()
    collector.addEntry('went', '0:go/1:p')
    collector.addEntry('teeth', '0:tooth/1:s')

    const result = collector.resolve()
    const map = new Map(result.forms.map((f) => [f.form.toLowerCase(), f]))

    expect(map.get('went')).toEqual({
      form: 'went',
      headword: 'go',
      kind: 'p',
    })
    expect(map.get('teeth')).toEqual({
      form: 'teeth',
      headword: 'tooth',
      kind: 's',
    })
  })

  it('filters out self-referential mappings (form == headword)', () => {
    const collector = new ExchangeCollector()
    // In ECDICT, inflected row `abandoned` often has self-referential `p:abandoned/d:abandoned`
    collector.addEntry('abandoned', '0:abandon/1:dp/p:abandoned/d:abandoned')

    const result = collector.resolve()
    expect(result.stats.selfReferentialExcluded).toBe(2)
    expect(result.forms).toHaveLength(1)
    expect(result.forms[0]).toEqual({
      form: 'abandoned',
      headword: 'abandon',
      kind: 'dp',
    })
  })

  it('identifies and isolates ambiguous collisions across multiple headwords', () => {
    const collector = new ExchangeCollector()
    // Two distinct words producing the same surface form
    collector.addEntry('analysis', 's:analyses')
    collector.addEntry('analyse', '3:analyses')

    const result = collector.resolve()
    expect(result.forms).toHaveLength(0) // ambiguous form excluded from forms table
    expect(result.ambiguous).toHaveLength(1)
    expect(result.ambiguous[0]!.form.toLowerCase()).toBe('analyses')
    expect(result.ambiguous[0]!.candidates).toEqual([
      { headword: 'analyse', kinds: ['3'] },
      { headword: 'analysis', kinds: ['s'] },
    ])
  })
})
