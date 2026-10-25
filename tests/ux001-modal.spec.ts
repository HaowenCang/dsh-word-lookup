// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ModalConfirm } from '../src/client/settings/dictionary-settings-components.js'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })
it('UX001 preserves confirm focus and lifetime while Escape/backdrop read latest cancellation callback', () => {
  vi.useFakeTimers()
  const trigger = document.createElement('button'), container = document.createElement('div'); document.body.append(trigger, container); trigger.focus()
  const root = createRoot(container), oldCancel = vi.fn(), latestCancel = vi.fn()
  const render = (onCancel: () => void) => act(() => root.render(React.createElement(ModalConfirm, { title: 'Delete', message: 'Synthetic', onConfirm() {}, onCancel })))
  render(oldCancel); act(() => vi.advanceTimersByTime(20))
  const buttons = container.querySelectorAll('button'); const cancel = buttons[0]!, confirm = buttons[1]!
  confirm.focus(); render(latestCancel); act(() => vi.advanceTimersByTime(100))
  expect(document.activeElement).toBe(confirm)
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(latestCancel).toHaveBeenCalledTimes(1); expect(oldCancel).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))); expect(document.activeElement).toBe(cancel)
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))); expect(document.activeElement).toBe(confirm)
  act(() => container.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }))); expect(latestCancel).toHaveBeenCalledTimes(2)
  act(() => root.unmount()); expect(document.activeElement).toBe(trigger)
  act(() => { vi.runAllTimers(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }); expect(latestCancel).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0)
})
it('UX001 cancels its initial timer and tolerates a removed trigger on unmount', () => {
  vi.useFakeTimers(); const trigger = document.createElement('button'), container = document.createElement('div'); document.body.append(trigger, container); trigger.focus()
  const root = createRoot(container), cancel = vi.fn()
  act(() => root.render(React.createElement(ModalConfirm, { title: 'Delete', message: '', onConfirm() {}, onCancel: cancel })))
  trigger.remove(); expect(() => act(() => root.unmount())).not.toThrow(); act(() => vi.runAllTimers()); expect(vi.getTimerCount()).toBe(0); expect(cancel).not.toHaveBeenCalled()
})
