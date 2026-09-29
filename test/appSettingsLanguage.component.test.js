// @vitest-environment happy-dom
//
// Language as the third section in App Settings, and specifically as the same
// KIND of thing as Appearance and Notifications above it: a segmented control
// that applies on tap. It reached that shape after two wrong ones — a row that
// opened its own sheet, then an inline section holding a full card grid and a
// Confirm button — both of which read as the odd control out.
//
// So the assertions here are as much about consistency as behaviour: same
// control shape as its siblings, no extra step, no leftover dialog.
//
// Two things stay easy to break. The section has to show the CURRENT language,
// because a stale selection is worse than none. And a tap has to write the
// scoped key as well as the device one, or the choice survives a reload on
// this phone and evaporates the next time the account signs in anywhere.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AppSettingsModal from '../src/components/AppSettingsModal.vue'
import { LOCALE_DEVICE_KEY, LOCALE_PREFIX, LOCALES } from '../src/lib/locale'
import { userScopedKey } from '../src/lib/perUserStorage'
import { setLocale, getLocale } from '../src/lib/i18n'

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return { useAuth: () => ({ userId: ref('user-1') }) }
})

vi.mock('../src/lib/pushNotifications', () => ({
  enablePushNotifications: vi.fn(async () => 'ok'),
  disablePushNotifications: vi.fn(async () => undefined),
  getNotificationPreference: () => null,
  setNotificationPreference: () => {},
  // Changing the language tells OneSignal which of the six the server should
  // deliver, so the picker calls this too. Stubbed rather than asserted here —
  // supabase/functions/_shared/push.ts is where the copy itself is pinned.
  setPushLanguage: vi.fn(async () => undefined),
}))

const scopedKey = userScopedKey(LOCALE_PREFIX, 'user-1')

const wrappers = []
function mountModal(open = true) {
  const w = mount(AppSettingsModal, {
    global: { stubs: { AppModal: false } },
    props: { open },
  })
  wrappers.push(w)
  return w
}

// The title of whichever section holds the language control.
//
// This used to be `.findAll('.app-settings__section-title').at(-1)`, back when
// Language was the last section in the dialog. Shopping region was added after
// it and both assertions here started reading that section's title instead —
// the same positional-indexing trap the .segmented helpers in
// appSettingsModal.component.test.js are warned about in AppSettingsModal.vue.
//
// Shopping region has since been removed, which would make `.at(-1)` correct
// again and is exactly why this stays as it is: it was correct before too, and
// a section appearing or disappearing below Language must not be able to reach
// this file. Anchoring on .lang-seg, which only LanguagePicker draws, is what
// buys that in both directions.
const languageTitle = (w) =>
  w.findAll('.app-settings__section').find((s) => s.find('.lang-seg').exists())
    .find('.app-settings__section-title')
const optionFor = (w, locale) => w.findAll('.lang-seg__btn')[LOCALES.indexOf(locale)]
const activeOption = (w) => w.find('.lang-seg__btn--active')

beforeEach(async () => {
  localStorage.clear()
  // Warm every chunk this file switches to, then settle on English. setLocale
  // performs a real dynamic import and the first load of a given language does
  // not settle inside a single flushPromises(), which would otherwise make
  // these tests pass or fail depending on the order they ran in.
  await setLocale('ro')
  await setLocale('de')
  await setLocale('en')
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
})

describe('the Language section', () => {
  it('is a segmented control, like the two sections above it', () => {
    const w = mountModal()
    expect(w.find('.lang-seg').exists()).toBe(true)
    expect(w.findAll('.lang-seg__btn')).toHaveLength(LOCALES.length)
  })

  it('offers no Confirm step and no sheet to open', () => {
    // Both are shapes this section used to have. Appearance and Notifications
    // apply on tap; this one has to as well, or it is the odd one out again.
    const w = mountModal()
    expect(w.find('.lang-confirm').exists()).toBe(false)
    expect(w.find('.lang-grid').exists()).toBe(false)
    expect(w.find('.language-dialog').exists()).toBe(false)
  })

  it('titles itself in the current language', async () => {
    const w = mountModal()
    expect(languageTitle(w).text()).toBe('Language')

    await setLocale('ro')
    await flushPromises()
    expect(languageTitle(w).text()).toBe('Limbă')
  })

  it('marks the current language as selected', () => {
    const w = mountModal()
    expect(activeOption(w).text()).toContain('English')
    expect(optionFor(w, 'en').attributes('aria-pressed')).toBe('true')
    expect(optionFor(w, 'de').attributes('aria-pressed')).toBe('false')
  })

  it('shows a real flag graphic per option, not emoji text', () => {
    // Unicode regional-indicator flag emoji render as literal letter pairs
    // ("GB", "RO") on Windows, which is what this replaced.
    const w = mountModal()
    for (const locale of LOCALES) {
      expect(optionFor(w, locale).find('.lang-seg__flag svg').exists()).toBe(true)
    }
  })

  it('sits after every segmented section without disturbing their indices', () => {
    // appSettingsModal.component.test.js reads .segmented positionally
    // (.at(0) Appearance, .at(1) Notifications). This control is classed
    // .lang-seg precisely so it cannot join that list. The third .segmented is
    // Screen recording, which comes after both.
    const w = mountModal()
    expect(w.findAll('.segmented')).toHaveLength(3)

    const html = w.html()
    expect(html.indexOf('lang-seg')).toBeGreaterThan(html.lastIndexOf('class="segmented'))
  })
})

describe('choosing a language', () => {
  it('applies on tap, with no second step', async () => {
    const w = mountModal()
    await optionFor(w, 'de').trigger('click')
    await flushPromises()

    expect(getLocale()).toBe('de')
  })

  it('records both the account key and the device key', async () => {
    const w = mountModal()
    await optionFor(w, 'de').trigger('click')
    await flushPromises()

    expect(localStorage.getItem(scopedKey)).toBe('de')
    expect(localStorage.getItem(LOCALE_DEVICE_KEY)).toBe('de')
  })

  it('re-translates the dialog around it, including its own section title', async () => {
    const w = mountModal()
    await optionFor(w, 'ro').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Setările aplicației')
    expect(languageTitle(w).text()).toBe('Limbă')
    expect(activeOption(w).text()).toContain('Română')
  })

  it('is recoverable in one tap — the control stays put after a wrong choice', async () => {
    // Why this section needs no Confirm: unlike the first-run step, nothing
    // is dismissed, so the way back is visible and one tap away.
    const w = mountModal()
    await optionFor(w, 'de').trigger('click')
    await flushPromises()
    expect(getLocale()).toBe('de')

    await optionFor(w, 'en').trigger('click')
    await flushPromises()
    expect(getLocale()).toBe('en')
    expect(activeOption(w).text()).toContain('English')
  })
})
