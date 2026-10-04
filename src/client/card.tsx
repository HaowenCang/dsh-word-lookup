/**
 * Production Result Card UI for `shell.overlay`.
 *
 * Implements Phase 5 Production Result Card:
 * - Mutually exclusive 5-state model: idle, loading, found, not-found, error.
 * - Viewport-safe positioning relative to selection anchor with fallback.
 * - Dismissal: Escape, outside pointer/click (no shield), and close button.
 * - Dismiss / request race correctness via surface generation.
 * - Accessibility: semantic region, accessible close label, readable contrast.
 * - No focus stealing on card appearance.
 * - Card text selectable and copyable; 0 automatic lookups for internal selection.
 * - Responsive narrow-viewport safety and scrollable long content.
 * - Self-contained light and dark theme support.
 *
 * @module dsh-word-lookup/client/card
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

import { computeCardPosition, type CardPosition } from './position.js'
import { splitGlosses } from '../shared/text.js'
import type { CardState, LookupCardStore } from './store.js'

/** Props the overlay seat supplies plus the store injected at registration. */
export type WordLookupCardProps = Partial<PropsRuntime<'shell.overlay'>> & {
  /** The card's observable state. */
  readonly store: LookupCardStore
}

/** Formal card UI display states. */
export type CardUiState = 'idle' | 'loading' | 'found' | 'not-found' | 'error'

/**
 * Classify CardState into formal UI display state.
 *
 * @param state - The current store snapshot.
 * @returns One of the five mutually exclusive UI states.
 */
export function getCardUiState(state: CardState): CardUiState {
  if (state.status === 'idle') return 'idle'
  if (state.status === 'loading') return 'loading'
  if (state.status === 'failed') return 'error'
  // state.status === 'ready'
  if (state.result.kind === 'found') return 'found'
  if (state.result.kind === 'not-found') return 'not-found'
  return 'error' // refused
}

/** Injectable CSS rules for theming, typography, and scroll behavior. */
const THEME_STYLES = `
.dsh-wl-card {
  --wl-bg: #1c1c21;
  --wl-fg: #f2f2f7;
  --wl-fg-muted: #9898a6;
  --wl-border: rgba(255, 255, 255, 0.14);
  --wl-tag-bg: rgba(255, 255, 255, 0.08);
  --wl-tag-fg: #d0d0dc;
  --wl-example-bg: rgba(255, 255, 255, 0.04);
  --wl-close-hover: rgba(255, 255, 255, 0.12);
  --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
@media (prefers-color-scheme: light) {
  .dsh-wl-card {
    --wl-bg: #ffffff;
    --wl-fg: #18181c;
    --wl-fg-muted: #626270;
    --wl-border: rgba(0, 0, 0, 0.12);
    --wl-tag-bg: rgba(0, 0, 0, 0.06);
    --wl-tag-fg: #454552;
    --wl-example-bg: rgba(0, 0, 0, 0.03);
    --wl-close-hover: rgba(0, 0, 0, 0.08);
    --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.12);
  }
}
:root[data-theme="light"] .dsh-wl-card,
.light .dsh-wl-card {
  --wl-bg: #ffffff;
  --wl-fg: #18181c;
  --wl-fg-muted: #626270;
  --wl-border: rgba(0, 0, 0, 0.12);
  --wl-tag-bg: rgba(0, 0, 0, 0.06);
  --wl-tag-fg: #454552;
  --wl-example-bg: rgba(0, 0, 0, 0.03);
  --wl-close-hover: rgba(0, 0, 0, 0.08);
  --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.12);
}
:root[data-theme="dark"] .dsh-wl-card,
.dark .dsh-wl-card {
  --wl-bg: #1c1c21;
  --wl-fg: #f2f2f7;
  --wl-fg-muted: #9898a6;
  --wl-border: rgba(255, 255, 255, 0.14);
  --wl-tag-bg: rgba(255, 255, 255, 0.08);
  --wl-tag-fg: #d0d0dc;
  --wl-example-bg: rgba(255, 255, 255, 0.04);
  --wl-close-hover: rgba(255, 255, 255, 0.12);
  --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
`

/** Base card panel style. */
const BASE_PANEL_STYLE: CSSProperties = {
  position: 'fixed',
  zIndex: 2147483000,
  pointerEvents: 'auto',
  userSelect: 'text',
  width: 'min(360px, calc(100vw - 24px))',
  maxWidth: 'calc(100vw - 24px)',
  maxHeight: 'min(440px, calc(100vh - 32px))',
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '12px 14px',
  border: '1px solid var(--dsh-color-border, var(--wl-border, rgba(128,128,128,0.25)))',
  borderRadius: '10px',
  background: 'var(--dsh-color-bg-elevated, var(--wl-bg, #1c1c21))',
  color: 'var(--dsh-color-text-primary, var(--wl-fg, #f2f2f7))',
  font: '13px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  boxShadow: 'var(--wl-shadow, 0 8px 28px rgba(0,0,0,0.35))',
  boxSizing: 'border-box',
  overflowWrap: 'break-word',
  wordBreak: 'break-word',
}

/** Header row container style. */
const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  marginBottom: '8px',
}

/** Close button style. */
const CLOSE_STYLE: CSSProperties = {
  flexShrink: 0,
  marginLeft: 'auto',
  border: 'none',
  background: 'transparent',
  color: 'var(--wl-fg-muted, #9898a6)',
  cursor: 'pointer',
  fontSize: '18px',
  lineHeight: '1',
  padding: '2px 6px',
  borderRadius: '4px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
}

/**
 * Render the Production Dictionary Result Card.
 *
 * @param props - Overlay seat props plus the injected store.
 * @returns The dictionary card element, or null while idle.
 */
export function WordLookupCard(props: WordLookupCardProps): ReactElement | null {
  const state = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<CardPosition | null>(null)

  const uiState = getCardUiState(state)

  const close = (): void => {
    props.store.clear()
  }

  // Positioning measurement and resize listener
  useIsomorphicLayoutEffect(() => {
    if (state.status === 'idle') {
      setPosition(null)
      return
    }

    const updatePosition = (): void => {
      const el = cardRef.current
      const width = el ? el.offsetWidth : 340
      const height = el ? el.offsetHeight : 180
      const anchorRect = props.store.anchorRect()
      const viewport = {
        width: typeof window !== 'undefined' ? window.innerWidth : 1200,
        height: typeof window !== 'undefined' ? window.innerHeight : 800,
      }
      const next = computeCardPosition(anchorRect, { width, height }, viewport)
      setPosition(next)
    }

    updatePosition()

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', updatePosition)
      return () => {
        window.removeEventListener('resize', updatePosition)
      }
    }
  }, [state, props.store])

  // Dismissal: Escape key and outside pointerdown
  useEffect(() => {
    if (state.status === 'idle') return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }

    const onOutsidePointerDown = (event: PointerEvent): void => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
        close()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onOutsidePointerDown, { capture: true })

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onOutsidePointerDown, { capture: true })
    }
  }, [state.status, props.store])

  if (state.status === 'idle') return null

  // Position coordinates: use calculated position or safe upper-center initial placement
  const posStyle: CSSProperties = position
    ? { left: `${String(position.x)}px`, top: `${String(position.y)}px` }
    : { left: '16px', top: '72px' }

  // Header content depending on state
  let headerTitle: ReactNode = null
  let statusBadge: ReactNode = null

  if (uiState === 'loading') {
    headerTitle = (
      <strong data-dsh-word-lookup="query" style={{ fontWeight: 600, fontSize: '15px' }}>
        {state.query}
      </strong>
    )
    statusBadge = (
      <span
        data-dsh-word-lookup="status"
        style={{
          fontSize: '12px',
          color: 'var(--wl-fg-muted, #9898a6)',
          fontStyle: 'italic',
        }}
      >
        looking up...
      </span>
    )
  } else if (uiState === 'found') {
    const found = (state as { result: { body: { headword: string; phonetic: string | null } } }).result.body
    headerTitle = (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <h2
          data-dsh-word-lookup="headword"
          style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: 700,
            lineHeight: '1.3',
            color: 'inherit',
          }}
        >
          {found.headword}
        </h2>
        {found.phonetic ? (
          <span
            data-dsh-word-lookup="phonetic"
            style={{
              fontSize: '12px',
              color: 'var(--wl-fg-muted, #9898a6)',
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            {found.phonetic}
          </span>
        ) : null}
      </div>
    )
  } else {
    // not-found or error
    headerTitle = (
      <strong data-dsh-word-lookup="query" style={{ fontWeight: 600, fontSize: '15px' }}>
        {state.query}
      </strong>
    )
  }

  const header = (
    <div style={HEADER_STYLE}>
      <div style={{ flex: '1 1 auto', minWidth: 0, marginRight: '8px' }}>
        {headerTitle}
        {statusBadge}
      </div>
      <button
        type="button"
        data-dsh-word-lookup="close"
        style={CLOSE_STYLE}
        onClick={close}
        aria-label="Close dictionary"
        title="Close dictionary (Esc)"
      >
        {'\u00d7'}
      </button>
    </div>
  )

  // Body content by state
  let body: ReactNode = null

  if (uiState === 'loading') {
    body = (
      <div
        data-dsh-word-lookup="loading-body"
        style={{
          padding: '12px 0 6px',
          fontSize: '12px',
          color: 'var(--wl-fg-muted, #9898a6)',
        }}
      >
        Fetching dictionary definition...
      </div>
    )
  } else if (uiState === 'not-found') {
    body = (
      <div
        data-dsh-word-lookup="not-found"
        style={{
          padding: '6px 0',
          fontSize: '13px',
          color: 'var(--wl-fg-muted, #9898a6)',
        }}
      >
        {'no entry for "'}
        <span style={{ color: 'var(--wl-fg, #f2f2f7)', fontWeight: 500 }}>{state.query}</span>
        {'"'}
      </div>
    )
  } else if (uiState === 'error') {
    let errorMessage = 'Dictionary lookup temporarily unavailable'
    if (state.status === 'ready' && state.result.kind === 'refused') {
      errorMessage = `Request refused (${String(state.result.httpStatus)})`
    } else if (state.status === 'failed') {
      errorMessage = state.failure.kind === 'aborted' ? 'Lookup superseded' : 'Dictionary service unavailable'
    }
    body = (
      <div
        data-dsh-word-lookup="error"
        style={{
          padding: '6px 0',
          fontSize: '13px',
          color: '#e06c75',
        }}
      >
        {errorMessage}
      </div>
    )
  } else if (uiState === 'found') {
    const found = (state as { result: { body: any } }).result.body
    // Lemma relation: only show when matchedForm exists and differs from headword
    const showLemma =
      found.matchedForm !== null &&
      found.matchedForm !== undefined &&
      found.matchedForm.trim().toLowerCase() !== found.headword.trim().toLowerCase()

    body = (
      <div data-dsh-word-lookup="entry">
        {showLemma ? (
          <div
            data-dsh-word-lookup="lemma"
            style={{
              fontSize: '12px',
              color: 'var(--wl-fg-muted, #9898a6)',
              marginBottom: '6px',
            }}
          >
            <span style={{ fontWeight: 500 }}>{found.matchedForm}</span>
            {' \u2192 '}
            <span>{found.headword}</span>
          </div>
        ) : null}

        {Array.isArray(found.meanings) && found.meanings.length > 0 ? (
          <ol
            style={{
              margin: '6px 0 8px',
              paddingLeft: found.meanings.length > 1 ? '18px' : '0',
              listStyleType: found.meanings.length > 1 ? 'decimal' : 'none',
            }}
          >
            {found.meanings.map((meaning: any, index: number) => {
              const glosses = meaning.translation ? splitGlosses(meaning.translation) : []
              return (
                <li key={String(index)} style={{ marginBottom: '6px', fontSize: '13px' }}>
                  {meaning.partOfSpeech ? (
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '1px 5px',
                        marginRight: '6px',
                        borderRadius: '3px',
                        background: 'var(--wl-tag-bg, rgba(255,255,255,0.08))',
                        color: 'var(--wl-tag-fg, #d0d0dc)',
                        fontSize: '11px',
                        fontWeight: 600,
                        fontStyle: 'italic',
                      }}
                    >
                      {meaning.partOfSpeech}
                    </span>
                  ) : null}

                  {glosses.map((gloss, glossIndex) => (
                    <span key={String(glossIndex)} data-dsh-word-lookup="gloss">
                      {glossIndex === 0 ? '' : '\uff1b'}
                      {gloss}
                    </span>
                  ))}

                  {meaning.translation && meaning.definition ? ' ' : null}

                  {meaning.definition ? (
                    <span style={{ color: 'var(--wl-fg-muted, #9898a6)', fontSize: '12px' }}>
                      {meaning.definition}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        ) : null}

        {Array.isArray(found.forms) && found.forms.length > 0 ? (
          <div
            data-dsh-word-lookup="forms"
            style={{
              marginTop: '4px',
              fontSize: '11px',
              color: 'var(--wl-fg-muted, #9898a6)',
            }}
          >
            {found.forms.map((form: any) => form.form).join(' \u00b7 ')}
          </div>
        ) : null}

        {Array.isArray(found.examples) && found.examples.length > 0 ? (
          <div style={{ marginTop: '8px', borderTop: '1px solid var(--wl-border, rgba(128,128,128,0.2))', paddingTop: '6px' }}>
            {found.examples.slice(0, 2).map((example: any, index: number) => (
              <div
                key={String(index)}
                data-dsh-word-lookup="example"
                style={{
                  marginTop: index === 0 ? '4px' : '6px',
                  padding: '4px 6px',
                  borderRadius: '4px',
                  background: 'var(--wl-example-bg, rgba(255,255,255,0.03))',
                  fontSize: '12px',
                }}
              >
                <div style={{ color: 'var(--wl-fg, #f2f2f7)' }}>{example.en}</div>
                {example.zh ? (
                  <div style={{ color: 'var(--wl-fg-muted, #9898a6)', marginTop: '2px', fontSize: '11px' }}>
                    {example.zh}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <aside
      ref={cardRef}
      role="region"
      aria-label="Dictionary lookup"
      data-dsh-word-lookup="card"
      data-dsh-word-lookup-state={state.status}
      data-dsh-word-lookup-ui-state={uiState}
      className="dsh-wl-card"
      style={{
        ...BASE_PANEL_STYLE,
        ...posStyle,
      }}
    >
      <style>{THEME_STYLES}</style>
      {header}
      {body}
    </aside>
  )
}
