import { onBeforeUnmount, ref, type Ref } from 'vue'

// Copying something to the clipboard, and saying so.
//
// There were three of these. lib/inviteShare had one as the desktop fallback for
// the share sheet; OverviewPanel and OnboardingTour each had their own, with the
// same swallowed failure, the same "Copied" flag, two different hold durations
// (2000ms and 1800ms), and only one of the two clearing its timer. The tour's
// also stacked: tapping twice queued overlapping timers that fought over one
// boolean, so the second tap's confirmation could be cancelled by the first
// tap's expiry.
//
// Same argument as lib/inviteCode, which exists because the code generator was
// duplicated across two views: one behaviour written twice is one that gets
// fixed once.

/**
 * Write `text` to the clipboard. Reports whether it landed rather than throwing:
 * every caller's answer to a refusal is the same (leave the code on screen to be
 * read), and a refusal is ordinary — a non-secure context, a denied permission,
 * an older WebView.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export interface CopyFeedback {
  /** True for `holdMs` after a successful copy. Bind to the tick/label swap. */
  copied: Ref<boolean>
  /** Copy, and light `copied` if it worked. Returns whether it did. */
  copy: (text: string) => Promise<boolean>
}

/**
 * The above, plus the transient "Copied" state a button shows afterwards.
 *
 * The timer is restarted rather than stacked, so holding the button down reads
 * as one continuous confirmation, and it is cleared on unmount, so a dialog
 * closed mid-hold leaves no callback running against it.
 */
export function useCopyFeedback(holdMs = 2000): CopyFeedback {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  async function copy(text: string): Promise<boolean> {
    if (!text) return false
    if (!(await copyText(text))) return false

    copied.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      copied.value = false
      timer = null
    }, holdMs)
    return true
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  return { copied, copy }
}
