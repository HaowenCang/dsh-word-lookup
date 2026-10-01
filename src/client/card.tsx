/**
 * The `shell.overlay` occupant.
 *
 * `shell.overlay` is a **list** slot at `root` scope whose layer is
 * click-through: the frame itself ignores pointer events and each entry opts
 * back in. The card therefore sets `pointer-events: auto` on its own root and
 * nowhere else, and it never covers the composer: the panel is anchored to the
 * lower right, clear of the input column.
 *
 * Two properties this component must keep:
 *
 * 1. **Idle renders nothing.** `shell.overlay` is mounted for the whole
 *    application lifetime, so an occupant that rendered a container node while
 *    idle would put a permanent element into every page. Returning `null` keeps
 *    the layer at zero children until a lookup actually produces something.
 * 2. **The style sheet is inline.** An external client plugin is served as one
 *    classic script; there is no second asset a stylesheet could travel in, and
 *    the shipped class names are hashed and must never be relied on.
 *
 * @module dsh-word-lookup/client/card
 */

import { useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { splitGlosses } from '../shared/text.js'
import type { LookupCardStore } from './store.js'

/** Props the overlay seat supplies plus the store injected at registration. */
export type WordLookupCardProps = PropsRuntime<'shell.overlay'> & {
  /** The card's observable state. */
  readonly store: LookupCardStore
}

/** Panel geometry and typography, in the overlay layer's own coordinates. */
const PANEL_STYLE = {
  position: 'fixed',
  right: '16px',
  bottom: '96px',
  zIndex: 2147483000,
  // The layer is click-through; this entry opts back in, and only here.
  pointerEvents: 'auto',
  maxWidth: '360px',
  padding: '10px 12px',
  border: '1px solid rgba(128,128,128,0.35)',
  borderRadius: '8px',
  background: 'rgba(24,24,28,0.94)',
  color: '#e8e8ee',
  font: '12px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
  boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
  whiteSpace: 'normal',
} as const

/** Header row: query on the left, dismiss on the right. */
const HEADER_STYLE = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  marginBottom: '6px',
} as const

/** The close affordance. */
const CLOSE_STYLE = {
  marginLeft: 'auto',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  opacity: 0.7,
  padding: '0 2px',
} as const

/**
 * Render the current lookup state.
 *
 * @param props - overlay seat props plus the injected store.
 * @returns the card, or `null` while idle.
 */
export function WordLookupCard(props: WordLookupCardProps): ReactElement | null {
  const state = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  if (state.status === 'idle') return null

  const close = (): void => {
    props.store.clear()
  }

  const statusText = state.status === 'loading' ? 'looking up' : state.status === 'failed' ? 'transport failed' : ''

  const header = (
    <div style={HEADER_STYLE}>
      <strong data-dsh-word-lookup="query" style={{ fontWeight: 600 }}>
        {state.query}
      </strong>
      <span data-dsh-word-lookup="status" style={{ opacity: 0.7 }}>
        {statusText}
      </span>
      <button type="button" data-dsh-word-lookup="close" style={CLOSE_STYLE} onClick={close} aria-label="Close">
        {'\u00d7'}
      </button>
    </div>
  )

  let body: ReactNode = null
  if (state.status === 'failed') {
    body = (
      <div data-dsh-word-lookup="error">
        {state.failure.kind === 'aborted' ? 'superseded' : state.failure.message}
      </div>
    )
  } else if (state.status === 'ready') {
    const result = state.result
    if (result.kind === 'refused') {
      body = (
        <div data-dsh-word-lookup="error">
          {result.code} ({String(result.httpStatus)})
        </div>
      )
    } else if (result.kind === 'not-found') {
      body = (
        <div data-dsh-word-lookup="not-found">
          {'no entry for "'}
          {result.body.query}
          {'"'}
        </div>
      )
    } else {
      const found = result.body
      body = (
        <div data-dsh-word-lookup="entry">
          <div data-dsh-word-lookup="headword">
            {found.headword}
            {found.phonetic === null ? null : <span style={{ opacity: 0.7 }}> {found.phonetic}</span>}
          </div>
          {found.matchedForm === null ? null : (
            <div data-dsh-word-lookup="lemma" style={{ opacity: 0.7 }}>
              {found.matchedForm}
              {' \u2192 '}
              {found.headword}
            </div>
          )}
          <ol style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
            {found.meanings.map((meaning, index) => (
              <li key={String(index)}>
                {meaning.partOfSpeech === null ? null : (
                  <em style={{ opacity: 0.75 }}>{meaning.partOfSpeech} </em>
                )}
                {/* The specification's card lists 中文义项 1, 中文义项 2, …: one
                    cell holds several glosses, so they are rendered as a list
                    rather than as one run-on string. */}
                {splitGlosses(meaning.translation).map((gloss, glossIndex) => (
                  <span key={String(glossIndex)} data-dsh-word-lookup="gloss">
                    {glossIndex === 0 ? '' : '\uff1b'}
                    {gloss}
                  </span>
                ))}
                {meaning.translation !== null && meaning.definition !== null ? ' ' : null}
                {meaning.definition === null ? null : (
                  <span style={{ opacity: 0.85 }}>{meaning.definition}</span>
                )}
              </li>
            ))}
          </ol>
          {found.forms.length === 0 ? null : (
            <div data-dsh-word-lookup="forms" style={{ marginTop: '4px', opacity: 0.7 }}>
              {found.forms.map((form) => form.form).join(' \u00b7 ')}
            </div>
          )}
          {found.examples.slice(0, 2).map((example, index) => (
            <div key={String(index)} data-dsh-word-lookup="example" style={{ marginTop: '4px', opacity: 0.85 }}>
              {example.en}
              {example.zh === null ? null : (
                <>
                  <br />
                  {example.zh}
                </>
              )}
            </div>
          ))}
        </div>
      )
    }
  }

  return (
    <div data-dsh-word-lookup="card" data-dsh-word-lookup-state={state.status} style={PANEL_STYLE}>
      {header}
      {body}
    </div>
  )
}
