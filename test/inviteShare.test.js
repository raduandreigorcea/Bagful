// @vitest-environment happy-dom
//
// "Invite people" has to work in three places that share no single API: the
// Android app (WebView, no navigator.share at all), a mobile browser or
// installed PWA (navigator.share), and a desktop (clipboard). These pin which
// path is taken where, and that backing out of a share sheet is never mistaken
// for a failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildInviteMessage, shareInvite, shareableOrigin } from '../src/lib/inviteShare'

const native = vi.hoisted(() => ({ value: false }))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => native.value,
    getPlatform: () => (native.value ? 'android' : 'web'),
  },
}))

const nativeShare = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/share', () => ({ Share: { share: nativeShare } }))

const writeText = vi.fn()

beforeEach(() => {
  native.value = false
  nativeShare.mockReset().mockResolvedValue(undefined)
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  delete navigator.share
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the message', () => {
  it('names the list, says what joining is for, and carries the code', () => {
    const message = buildInviteMessage('Home', 'ABCD2345', 'https://famcart-app.vercel.app')

    expect(message.text).toContain('"Home"')
    expect(message.text).toContain('ABCD2345')
    expect(message.text).toContain('shop from the same list')
    expect(message.title).toBe('Join Home on Bagful')
  })

  // Plain-text targets (SMS, most chat apps) drop the separate url field, so
  // the link has to survive inside the text too.
  it('puts the link in the text as well as the url field', () => {
    const message = buildInviteMessage('Home', 'ABCD2345', 'https://famcart-app.vercel.app')

    expect(message.url).toBe('https://famcart-app.vercel.app')
    expect(message.text).toContain('https://famcart-app.vercel.app')
  })

  it('still reads correctly for a list with no name', () => {
    const message = buildInviteMessage('', 'ABCD2345', '')

    expect(message.text).toContain('my list')
    expect(message.text).toContain('ABCD2345')
    expect(message.text).not.toContain('""')
  })

  // The WebView serves the app from localhost, so its origin is a link to the
  // recipient's own phone. Better no link than that one.
  it('refuses to send a link nobody else can open', () => {
    expect(shareableOrigin('http://localhost:5173/')).toBe('')
    expect(shareableOrigin('http://127.0.0.1:4173/')).toBe('')
    expect(shareableOrigin('capacitor://localhost/')).toBe('')
    expect(shareableOrigin('https://famcart-app.vercel.app/list')).toBe(
      'https://famcart-app.vercel.app',
    )
  })
})

describe('the Android app', () => {
  // The reason the plugin exists: navigator.share is a browser API and the
  // WebView does not implement it, so the APK would have fallen back to a
  // silent clipboard copy on the one platform this feature is most for.
  it('uses the native sheet even though navigator.share is absent', async () => {
    native.value = true
    expect(navigator.share).toBeUndefined()

    expect(await shareInvite('Home', 'ABCD2345')).toBe('shared')
    expect(nativeShare).toHaveBeenCalledTimes(1)
    expect(nativeShare.mock.calls[0][0].text).toContain('ABCD2345')
  })

  it('treats a dismissed sheet as an answer, not an error', async () => {
    native.value = true
    nativeShare.mockRejectedValue(new Error('Share canceled'))

    expect(await shareInvite('Home', 'ABCD2345')).toBe('cancelled')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to the clipboard if the intent genuinely fails', async () => {
    native.value = true
    nativeShare.mockRejectedValue(new Error('No activity found to handle intent'))

    expect(await shareInvite('Home', 'ABCD2345')).toBe('copied')
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('a mobile browser', () => {
  it('opens the web share sheet when the browser has one', async () => {
    navigator.share = vi.fn().mockResolvedValue(undefined)

    expect(await shareInvite('Home', 'ABCD2345')).toBe('shared')
    expect(navigator.share).toHaveBeenCalledTimes(1)
    expect(nativeShare).not.toHaveBeenCalled()
  })

  it('treats AbortError as backing out', async () => {
    const abort = new Error('dismissed')
    abort.name = 'AbortError'
    navigator.share = vi.fn().mockRejectedValue(abort)

    expect(await shareInvite('Home', 'ABCD2345')).toBe('cancelled')
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('a desktop', () => {
  it('copies the whole invite, not the bare code', async () => {
    expect(await shareInvite('Home', 'ABCD2345')).toBe('copied')

    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('ABCD2345')
    expect(copied).toContain('Bagful')
  })

  // Clipboard access can be refused outright. The caller turns this into
  // "open the panel that shows the code", rather than a dead press.
  it('reports that it could not hand the invite over', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    expect(await shareInvite('Home', 'ABCD2345')).toBe('unavailable')
  })

  it('has nothing to share without a code', async () => {
    expect(await shareInvite('Home', '')).toBe('unavailable')
    expect(writeText).not.toHaveBeenCalled()
  })
})
