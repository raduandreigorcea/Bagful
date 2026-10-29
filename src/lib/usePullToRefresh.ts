import { onBeforeUnmount, onMounted, ref } from 'vue'
import { hasOpenModal } from './modalStack'

// Drag the page down from the top and let go: the list is fetched again. A
// phone browser does this natively, an installed app does not, and the web
// view of the APK has no gesture of its own.
//
// A touch only counts when it began with the page already at the top, so
// scrolling back up through a long list never turns into a refresh by accident.

/** How far the finger must travel (after resistance) for a release to refresh. */
export const PULL_THRESHOLD = 64
/** Past the threshold the finger moves the indicator this fraction as far, like a row being swiped. */
const PAST_THRESHOLD = 0.45
/** Past this the pull is heavier still, but never stops: there is no wall under the finger. */
const SOFT_LIMIT = 110
const PAST_SOFT_LIMIT = 0.15

// Follow the finger 1:1 up to the threshold, then push back, as ShoppingListItem does.
function resist(dy: number): number {
  const eased = dy <= PULL_THRESHOLD ? dy : PULL_THRESHOLD + (dy - PULL_THRESHOLD) * PAST_THRESHOLD
  return eased <= SOFT_LIMIT ? eased : SOFT_LIMIT + (eased - SOFT_LIMIT) * PAST_SOFT_LIMIT
}
/** The spinner gives up waiting after this long; the fetch carries on unseen. */
const MAX_REFRESH_MS = 8000

export function usePullToRefresh(refresh: () => Promise<unknown>) {
  /** Pixels the indicator is currently pulled down. */
  const pull = ref(0)
  const refreshing = ref(false)
  let startY: number | null = null

  function onStart(e: TouchEvent) {
    const atTop = window.scrollY <= 0
    startY = atTop && !refreshing.value && !hasOpenModal() && e.touches.length === 1 ? e.touches[0]!.clientY : null
  }

  function onMove(e: TouchEvent) {
    if (startY === null) return
    const dy = e.touches[0]!.clientY - startY
    if (dy <= 0 || window.scrollY > 0) {
      pull.value = 0
      return
    }
    pull.value = resist(dy)
    // Without this the web view starts its own overscroll mid-drag and cancels the
    // touch, so the spinner froze or vanished under the finger.
    if (e.cancelable) e.preventDefault()
  }

  async function onEnd() {
    if (startY === null) return
    startY = null
    if (pull.value < PULL_THRESHOLD) {
      pull.value = 0
      return
    }
    refreshing.value = true
    pull.value = PULL_THRESHOLD
    try {
      // A fetch that never answers (no signal) must not leave the spinner up for good.
      await Promise.race([refresh(), new Promise((resolve) => setTimeout(resolve, MAX_REFRESH_MS))])
    } finally {
      refreshing.value = false
      pull.value = 0
    }
  }

  const cancel = () => {
    startY = null
    if (!refreshing.value) pull.value = 0
  }

  onMounted(() => {
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', cancel)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('touchstart', onStart)
    window.removeEventListener('touchmove', onMove)
    window.removeEventListener('touchend', onEnd)
    window.removeEventListener('touchcancel', cancel)
  })

  return { pull, refreshing }
}
