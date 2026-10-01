// The messages at the bottom of the screen: "Removed Lapte · Undo", "Someone
// checked out 9 items". Module state, not component state, for the same reason
// modalStack is: there is one stack on the screen, whoever asked for a toast.
//
// They stack rather than replace each other. Deleting two rows in a row is two
// things you might want back, and a newer message wiping out an older one's Undo
// took that choice away. Each toast keeps its own timer and its own action;
// past MAX_VISIBLE the oldest leaves to make room.
//
// A toast can carry a deferred action. `onExpire` runs when the toast leaves
// WITHOUT its action being pressed: timed out, pushed out by newer ones, or the
// page being hidden. That is what makes undo safe to build on it: a delete waits
// in `onExpire`, Undo cancels it, and nothing can be dropped on the floor,
// because every way a toast can go away except Undo commits.
//
// The page-hidden case is the one that matters on a phone: someone deletes an
// item and switches app within the five seconds. `pagehide` alone misses that on
// Android (the WebView is frozen, not unloaded), so visibilitychange is the real
// trigger and pagehide the backstop for a closing tab.

import { ref, readonly } from 'vue'

export interface ToastOptions {
  message: string
  actionLabel?: string
  onAction?: () => void
  onExpire?: () => void
  duration?: number
}

export interface Toast extends ToastOptions {
  id: number
}

const TOAST_DURATION_MS = 5000
export const MAX_VISIBLE_TOASTS = 3

const toasts = ref<Toast[]>([])
let nextId = 1

interface Clock {
  timer: ReturnType<typeof setTimeout> | null
  remaining: number
  startedAt: number
}
const clocks = new Map<number, Clock>()
let paused = false

function start(id: number, ms: number) {
  const clock: Clock = { timer: null, remaining: ms, startedAt: Date.now() }
  clocks.set(id, clock)
  if (!paused) clock.timer = setTimeout(() => dismissToast(id), ms)
}

function take(id: number): Toast | undefined {
  const toast = toasts.value.find((t) => t.id === id)
  if (!toast) return undefined
  const clock = clocks.get(id)
  if (clock?.timer) clearTimeout(clock.timer)
  clocks.delete(id)
  toasts.value = toasts.value.filter((t) => t.id !== id)
  return toast
}

/**
 * Remove a toast, committing its deferred action. With no id, every toast
 * goes, oldest first, so deferred deletes land in the order they were made.
 */
export function dismissToast(id?: number): void {
  if (id === undefined) {
    for (const toast of [...toasts.value]) dismissToast(toast.id)
    return
  }
  take(id)?.onExpire?.()
}

export function showToast(options: ToastOptions): number {
  const toast: Toast = { ...options, id: nextId++ }
  toasts.value = [...toasts.value, toast]
  start(toast.id, options.duration ?? TOAST_DURATION_MS)
  while (toasts.value.length > MAX_VISIBLE_TOASTS) dismissToast(toasts.value[0]!.id)
  return toast.id
}

/** A toast's button: runs onAction and skips onExpire. Defaults to the newest. */
export function triggerToastAction(id?: number): void {
  const target = id ?? toasts.value.at(-1)?.id
  if (target === undefined) return
  take(target)?.onAction?.()
}

// Someone reading the stack, or with the keyboard on an Undo button, should not
// have it pulled away from them. The whole stack pauses together: they are read
// as one thing.
export function pauseToast(): void {
  if (paused) return
  paused = true
  const now = Date.now()
  for (const clock of clocks.values()) {
    if (clock.timer) clearTimeout(clock.timer)
    clock.timer = null
    clock.remaining = Math.max(0, clock.remaining - (now - clock.startedAt))
  }
}

export function resumeToast(): void {
  if (!paused) return
  paused = false
  for (const [id, clock] of clocks) {
    clock.startedAt = Date.now()
    clock.remaining = Math.max(clock.remaining, 1500)
    clock.timer = setTimeout(() => dismissToast(id), clock.remaining)
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dismissToast()
  })
  window.addEventListener('pagehide', () => dismissToast())
}

export function useToast() {
  return { toasts: readonly(toasts), showToast, dismissToast }
}
