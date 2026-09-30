import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

// The add search as a bottom sheet.
//
// On a phone the suggestions dropdown has nowhere to go, so the search is the
// whole viewport instead: a sheet that rises from the bottom edge, with the
// field in a header band at the top of it and the matches running edge to edge
// beneath, down to wherever the keyboard starts.
//
// Adding starts from the action bar's centre button, so there is no origin in
// the flow to animate from. The sheet uses the motion the app already owns for
// anything anchored to the bottom edge (--modal-rise: 100% with the shared
// modal-rise keyframes in style.css), which is also the edge the keyboard is
// about to come from.
//
// The hard bit is knowing where the visual viewport actually is. Android
// resizes the WebView and leaves offsetTop at 0; iOS does not resize and puts
// the difference in offsetTop. Both are wrong in different ways if you reach
// for window.innerHeight.

// The width at which the bar hands over to the header shell, matching the 900px
// boundary in AppNavBar and --desktop-column. Above it the form stays in the
// flow as an ordinary field with a dropdown, and none of this applies.
//
// This was 599.98px when the split was "does the dropdown fit", which is a
// different question from "which shell is this". One breakpoint answering both
// is what would have left a 600-899px window with a bar it could not open.
const SHEET_QUERY = '(max-width: 899.98px)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// How long the sheet is allowed to be on its way out before we tidy up
// regardless. Comfortably past --transition-slow, which is what the exit
// animation runs at.
const EXIT_TIMEOUT_MS = 400

// The raw query check. isSheetWidth() below wraps the one callers actually ask
// about; the reduced-motion query is this file's own business.
function mediaMatches(query: string): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches
  )
}

/** Whether the viewport is narrow enough for the search to be a sheet. */
export function isSheetWidth(): boolean {
  return mediaMatches(SHEET_QUERY)
}

export interface SearchSheet {
  /** The sheet's box, measured from the visual viewport. */
  screenBox: Ref<Record<string, string> | null>
  /** True while the sheet is travelling back down. */
  closing: Ref<boolean>
  /**
   * Whether the sheet is on screen at all: open, or still leaving. Everything
   * that draws it keys off this rather than off `expanded`, which answers the
   * different question of whether the user wants it.
   */
  present: Readonly<Ref<boolean>>
  expand: () => void
  collapse: () => void
}

export function useSearchSheet(options: {
  /** The caller's expanded model — owned there because the parent reads it too. */
  expanded: Ref<boolean>
}): SearchSheet {
  const { expanded } = options

  const screenBox = ref<Record<string, string> | null>(null)
  const closing = ref(false)

  let exitTimer: ReturnType<typeof setTimeout> | null = null

  // offsetTop + height is the visual viewport in layout coordinates, which is
  // what makes this right both on Android (the WebView resizes, offsetTop stays
  // 0) and on iOS (it does not resize, and offsetTop carries the difference).
  function measureScreen(): void {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) {
      screenBox.value =
        typeof window !== 'undefined' ? { top: '0px', height: `${window.innerHeight}px` } : null
      return
    }
    screenBox.value = {
      top: `${Math.round(vv.offsetTop)}px`,
      height: `${Math.round(vv.height)}px`,
    }
  }

  // A rotation can cross out of sheet width with the search still open, and a
  // phone's sheet stretched across a desktop column is not a layout.
  function onResize(): void {
    if (!expanded.value) return
    if (!isSheetWidth()) settle()
    else measureScreen()
  }

  function bindViewportListeners(on: boolean): void {
    if (typeof window === 'undefined') return
    const method = on ? 'addEventListener' : ('removeEventListener' as const)
    window[method]('resize', onResize)
    window.visualViewport?.[method]('resize', measureScreen)
    window.visualViewport?.[method]('scroll', measureScreen)
  }

  function clearExitTimer(): void {
    if (exitTimer) clearTimeout(exitTimer)
    exitTimer = null
  }

  // Everything the open state needs, wherever the decision to open came from.
  //
  // It is a watcher rather than the body of expand() because expand() is no
  // longer the only way in. The bar's centre button opens the sheet by setting
  // the parent's model, and a sheet opened that way still has to measure the
  // visual viewport and start listening to it, or it renders at 100dvh with the
  // results running underneath the keyboard.
  //
  // immediate, so a component mounted with the model already true is open
  // properly rather than open-looking.
  function attach(): void {
    clearExitTimer()
    closing.value = false
    measureScreen()
    bindViewportListeners(true)
  }

  watch(
    expanded,
    (open) => {
      if (open) attach()
      else bindViewportListeners(false)
    },
    { immediate: true },
  )

  function expand(): void {
    // Already open, and staying open. Reopening mid-exit is not this case: the
    // model went false the moment the sheet was dismissed, so it falls through
    // and the watcher picks it up, which is what reverses the exit.
    //
    // That path is real rather than theoretical. A dialog opened from the search
    // hands focus back to the field when it closes (AppModal restores what was
    // focused when it opened), and the tap that dismissed it has already started
    // the exit — reachable from the item-limit popup, which is exactly what a
    // full list answers a tapped suggestion with.
    if (expanded.value) return
    expanded.value = true
  }

  function collapse(): void {
    // Escape closes by blurring, so this arrives twice: once from the key and
    // once from the blur it caused. The second must not restart the exit.
    if (!expanded.value) return

    // The model goes false NOW, not when the animation ends. It answers "does
    // the user want the search open", and they have just said no; holding it
    // true for the length of the exit would leave the bar's centre button
    // unable to raise the sheet again until the travel finished, and would tell
    // the parent it was still searching while it visibly was not.
    expanded.value = false

    if (mediaMatches(REDUCED_MOTION_QUERY)) {
      settle()
      return
    }

    // What keeps the sheet on screen while it leaves. The animation is CSS,
    // driven by this flag; the timer only takes the sheet down afterwards.
    // animationend would be tighter, but it is also the event a backgrounded tab
    // never delivers, and a sheet that never unmounts is a worse failure than
    // one that unmounts 60ms late.
    closing.value = true
    exitTimer = setTimeout(settle, EXIT_TIMEOUT_MS)
  }

  function settle(): void {
    clearExitTimer()
    bindViewportListeners(false)
    expanded.value = false
    closing.value = false
    screenBox.value = null
  }

  onBeforeUnmount(() => {
    clearExitTimer()
    bindViewportListeners(false)
  })

  const present = computed(() => expanded.value || closing.value)

  return { screenBox, closing, present, expand, collapse }
}
