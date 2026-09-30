// Handing someone an invite, by whatever means the device actually has.
//
// Three paths, because there is no single API that covers where Bagful runs:
//
//   • The Android app — @capacitor/share, which fires an ACTION_SEND intent.
//     This is the one the Web Share API does NOT cover: navigator.share is a
//     Chromium browser feature and Android's WebView does not implement it, so
//     inside the APK it is simply undefined. A build that relied on it would
//     have quietly degraded to a clipboard copy on the one platform this
//     feature is most for.
//   • A mobile browser or an installed PWA — navigator.share, the same sheet
//     without the plugin.
//   • Everything else, meaning desktop — the clipboard, which is what this
//     button already did before any of the above.
//
// The message is built in one place for all three so the invite reads the same
// however it left the phone.

import { Capacitor } from '@capacitor/core'
import { copyText } from './clipboard'
import { t } from './i18n'

export type InviteShareOutcome = 'shared' | 'copied' | 'cancelled' | 'unavailable'

export interface InviteMessage {
  title: string
  text: string
  url: string
}

// A link is only worth sending if it points somewhere the recipient can reach.
// The Android WebView serves the app from localhost, so its origin is a link to
// the recipient's own phone; dev servers are no better. Both yield '' and the
// message goes without a link rather than with a broken one.
export function shareableOrigin(href = typeof window === 'undefined' ? '' : window.location.href): string {
  if (!href) return ''
  try {
    const url = new URL(href)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return ''
    return url.origin
  } catch {
    return ''
  }
}

// Written to be read in a chat thread, which is where it is going. It says what
// the recipient is being asked to join, what they get out of it, and the code —
// in that order, because someone who does not know what Bagful is needs the
// first two before the third means anything.
export function buildInviteMessage(
  listName: string,
  code: string,
  origin = shareableOrigin(),
): InviteMessage {
  const named = listName.trim()
  // Two whole sentences per case rather than one with a {where} hole in it. The
  // hole was cheaper here and unfillable in half the catalogs: the name takes a
  // different preposition and a different article depending on the language, so
  // a translator handed a fragment cannot produce a correct sentence.
  const text = named
    ? t('invite.shareBody', { name: named, code })
    : t('invite.shareBodyGeneric', { code })

  return {
    title: named ? t('invite.shareTitle', { name: named }) : t('invite.shareTitleGeneric'),
    // The link goes in the text as well as in `url`: share targets that take
    // plain text only (SMS, most chat apps) drop the separate url field.
    text: origin ? `${text} ${origin}` : text,
    url: origin,
  }
}

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

// Both sheets throw when the person backs out of them, which is not a failure
// and must not be reported as one — Android says "Share canceled", the web says
// AbortError.
function isDismissal(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /cancel/i.test(message)
}

async function copyInvite(text: string): Promise<InviteShareOutcome> {
  // Clipboard refused (a non-secure context, a permission, an older WebView) is
  // reported as 'unavailable', which is what sends the caller to the settings
  // dialog where the code can be read off the screen instead.
  return (await copyText(text)) ? 'copied' : 'unavailable'
}

// Deliberately not `async`. navigator.share must be called inside the user
// activation from the tap that triggered it, and an `await` before it — even
// one that resolves immediately — ends that activation and the browser rejects
// the call. The native and clipboard paths have no such rule, so only this one
// function has to stay synchronous up to the point it hands off.
export function shareInvite(
  listName: string,
  code: string,
): Promise<InviteShareOutcome> {
  if (!code) return Promise.resolve('unavailable')
  const message = buildInviteMessage(listName, code)

  if (isNative()) {
    return import('@capacitor/share')
      .then(({ Share }) =>
        Share.share({
          title: message.title,
          text: message.text,
          url: message.url || undefined,
          dialogTitle: t('invite.shareDialogTitle'),
        }),
      )
      .then((): InviteShareOutcome => 'shared')
      .catch((error) => (isDismissal(error) ? 'cancelled' : copyInvite(message.text)))
  }

  const webShare = typeof navigator !== 'undefined' ? navigator.share : undefined
  if (typeof webShare === 'function') {
    return webShare
      .call(navigator, { title: message.title, text: message.text, url: message.url || undefined })
      .then((): InviteShareOutcome => 'shared')
      .catch((error: unknown) =>
        isDismissal(error) ? 'cancelled' : copyInvite(message.text),
      )
  }

  return copyInvite(message.text)
}
