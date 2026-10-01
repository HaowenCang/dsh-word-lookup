/**
 * The selection qualification rule.
 *
 * The rule is asserted as a truth table over {@link SelectionEndpointFacts}
 * rather than through a DOM, because the decision — "inside a conversation flow
 * item **and** outside every interactive text surface" — is what the plugin
 * actually depends on. The DOM walk that produces those facts is covered by the
 * real-browser verification, where the shipped conversation markup exists.
 */

import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_FLOW_SELECTOR,
  INTERACTIVE_SURFACE_SELECTOR,
  isEligibleEndpoint,
  type SelectionEndpointFacts,
} from '../src/client/selection.js'

/** The two facts, in the four combinations that exist. */
const CASES: readonly (SelectionEndpointFacts & { readonly expected: boolean; readonly label: string })[] = [
  {
    label: 'in the transcript, outside any text surface',
    insideConversationFlow: true,
    insideInteractiveSurface: false,
    expected: true,
  },
  {
    label: 'in the transcript but inside a text surface (the composer case)',
    insideConversationFlow: true,
    insideInteractiveSurface: true,
    expected: false,
  },
  {
    label: 'outside the transcript (sidebar, dialog, toolbar)',
    insideConversationFlow: false,
    insideInteractiveSurface: false,
    expected: false,
  },
  {
    label: 'outside the transcript and inside a text surface',
    insideConversationFlow: false,
    insideInteractiveSurface: true,
    expected: false,
  },
]

describe('isEligibleEndpoint', () => {
  for (const testCase of CASES) {
    it(`${testCase.expected ? 'accepts' : 'rejects'} an endpoint ${testCase.label}`, () => {
      expect(
        isEligibleEndpoint({
          insideConversationFlow: testCase.insideConversationFlow,
          insideInteractiveSurface: testCase.insideInteractiveSurface,
        }),
      ).toBe(testCase.expected)
    })
  }
})

describe('selectors', () => {
  it('anchors the conversation test on the attribute Phase 0 measured as reliable', () => {
    expect(CONVERSATION_FLOW_SELECTOR).toBe('[data-chat-flow-kind]')
  })

  it('does not depend on the unreliable message-body anchor', () => {
    expect(CONVERSATION_FLOW_SELECTOR).not.toContain('message-body')
  })

  it('excludes every interactive text surface the composer and form controls use', () => {
    for (const part of [
      'input',
      'textarea',
      'select',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ]) {
      expect(INTERACTIVE_SURFACE_SELECTOR).toContain(part)
    }
  })

  it('uses no hashed class name', () => {
    // The shipped class names are content-hashed and change between builds.
    expect(INTERACTIVE_SURFACE_SELECTOR).not.toMatch(/\._[a-z0-9]+_/)
    expect(CONVERSATION_FLOW_SELECTOR).not.toMatch(/\._[a-z0-9]+_/)
  })
})
