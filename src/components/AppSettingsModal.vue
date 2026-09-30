<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useAuth } from '@clerk/vue'
import AppButton from './AppButton.vue'
import AppModal from './AppModal.vue'
import ModalCloseButton from './ModalCloseButton.vue'
import ErrorModal from './ErrorModal.vue'
import LanguagePicker from './LanguagePicker.vue'
import { canSelfUpdate } from '../lib/nativeUpdate'
import { updateCheckKey } from '../lib/updatePrompt'
import {
  enablePushNotifications,
  disablePushNotifications,
  getNotificationPreference,
  setNotificationPreference,
  setPushLanguage,
  type NotificationPreference,
} from '../lib/pushNotifications'
import { getLocale, setLocale, t, type Locale } from '../lib/i18n'
import {
  applyResolvedTheme,
  loadThemeMode,
  saveThemeMode,
  type ThemeMode,
} from '../lib/theme'
import AppIcon from './AppIcon.vue'
import { IS_NIGHTLY, SUPABASE_PROJECT_REF } from '../lib/appChannel'
import { fetchShopCredits, type ShopCredit } from '../lib/shopBadges'
import { deviceTimeZone, resolveRegion } from '../lib/region'
import { replayEnabled, setReplayEnabled } from '../lib/analytics'

// Settings that belong to the app on this device rather than to a list or
// to the account: how it looks, whether it may notify, and what it is.
//
// About lives here because it is the clearest case of the three — an app's
// version and its product-data credit are not a property of any one
// list, which is exactly what made it odd sitting in the list dialog
// behind a flag that pushed it to the bottom of the sidebar.
//
// Sections stacked in one scroll rather than tabs: Appearance is three buttons
// and Notifications is two, and a tab pane holding three buttons reads as an
// empty room. List Settings earns its sidebar because its panels are big.

const props = defineProps({
  open: { type: Boolean, default: false },
})

const emit = defineEmits<{ close: [] }>()

const { userId } = useAuth()

// Replaced at build time with package.json's version, so bumping it there is
// the only step needed for this to show the new one.
//
// The nightly suffix rides along with it so it appears in both places the
// version is shown, the settings row and the About dialog, and so a version
// quoted in a bug report carries the channel with it.
const appVersion = IS_NIGHTLY ? `${__APP_VERSION__}-nightly` : __APP_VERSION__

const aboutOpen = ref(false)

// Loaded when About opens, not when settings does: it is one small cached read,
// and most visits to settings never reach About.
const shopCredits = ref<ShopCredit[]>([])
watch(aboutOpen, (isOpen) => {
  if (!isOpen) return
  void fetchShopCredits(resolveRegion(deviceTimeZone())).then((credits) => {
    shopCredits.value = credits
  })
})

// "Auchan, Carrefour and Lidl" in whatever the app's language makes of a list,
// split into the names (links) and the text between them.
const creditParts = computed(() => {
  if (shopCredits.value.length === 0) return []
  const names = shopCredits.value.map((c) => c.name)
  let index = 0
  // Plain `en` lists with an Oxford comma ("Carrefour, and Lidl"); the app's
  // English never uses one ("Milk, Eggs and 2 more"), so English lists as en-GB.
  const locale = getLocale()
  return new Intl.ListFormat(locale === 'en' ? 'en-GB' : locale, { type: 'conjunction' })
    .formatToParts(names)
    .map((part) =>
      part.type === 'element'
        ? { text: part.value, url: shopCredits.value[index++]?.url ?? null }
        : { text: part.value, url: null },
    )
})

// Language is a third section of the same kind as Appearance and
// Notifications: a title, a segmented control, applied on tap. It went through
// two wrong shapes first — a row that opened its own sheet, then an inline
// section holding a full card grid and a Confirm button. Both were the odd one
// out in a dialog whose other two controls are compact and instant.
//
// Six options fit by wrapping to two rows of three, which is why this needs no
// different kind of control than the three-column one above it.
//
// No Confirm step here, unlike the first-run step where the same component
// does have one. There, choosing dismisses the screen, so a misclick strands
// you. Here the control stays put and each option carries a flag, so a wrong
// tap is visible immediately and undone by tapping the right one — the same
// bargain Appearance and Notifications already make.
const currentLocale = computed(() => getLocale())

async function chooseLanguage(next: Locale) {
  await setLocale(next, localStorage, userId.value ?? '')
  // Notifications are written by the server in every language at once and
  // picked per subscription, so changing the language here has to reach
  // OneSignal or the next push still arrives in the old one. After setLocale,
  // because setPushLanguage reads the current locale rather than taking it.
  // Not awaited: the screen has already switched language and nothing here is
  // waiting on a third-party round trip. A no-op unless push is actually on.
  void setPushLanguage()
}

// Asking for an update by hand.
//
// The startup check deliberately stays quiet in several situations — it waits
// out an interval, and it says nothing about a version already declined. Both
// are right for a check nobody asked for and wrong once someone goes looking,
// so this route applies neither. It is also the only way back from a dismissal:
// Back on the update dialog declines that version, and without this the app
// would have nothing to say until the next release.
//
// Provided by HomeView rather than passed down through AppNavBar. Absent (null)
// anywhere that view does not own — the setup screen, and every test that mounts
// this modal on its own — so the row simply does not appear there.
const runUpdateCheck = inject(updateCheckKey, null)
type UpdateCheckState = 'idle' | 'checking' | 'up-to-date' | 'failed'
const updateCheckState = ref<UpdateCheckState>('idle')
const canCheckForUpdates = computed(() => canSelfUpdate() && !!runUpdateCheck)

async function checkForUpdates() {
  if (!runUpdateCheck || updateCheckState.value === 'checking') return
  updateCheckState.value = 'checking'
  const result = await runUpdateCheck()
  // 'found' opens the update dialog, which belongs to the view behind this one.
  // Close everything so it is not buried under two layers of settings.
  if (result === 'found') {
    updateCheckState.value = 'idle'
    aboutOpen.value = false
    emit('close')
    return
  }
  updateCheckState.value = result
}
const themeMode = ref<ThemeMode>('system')
const notificationMode = ref<NotificationPreference>('on')
const notificationHint = ref('')
// Off until chosen, per account; lib/analytics owns the key and starts or stops
// the recorder.
const replayMode = ref<'on' | 'off'>('off')

function syncPreferencesFromStorage() {
  // lib/theme owns the key and the fallback-to-system rule; this only mirrors
  // the answer into the radio group and onto the page.
  themeMode.value = loadThemeMode(localStorage)
  applyResolvedTheme(themeMode.value)

  // Only an explicit opt-in shows On. An unset preference means the user was
  // never asked (or never answered) — showing On there would claim a push
  // subscription that doesn't exist.
  notificationMode.value =
    getNotificationPreference(localStorage, userId.value ?? '') === 'on' ? 'on' : 'off'

  replayMode.value = userId.value && replayEnabled(localStorage, userId.value) ? 'on' : 'off'
}

function applyReplay(mode: 'on' | 'off') {
  if (!userId.value) return
  replayMode.value = mode
  setReplayEnabled(localStorage, userId.value, mode === 'on')
}

function applyTheme(mode: ThemeMode) {
  themeMode.value = mode
  saveThemeMode(localStorage, mode)
  applyResolvedTheme(mode)
}

async function applyNotifications(mode: NotificationPreference) {
  // Read once, up front, for the reason firstRunGreeting gives: the preference
  // belongs to the account that touched the toggle, and enabling push is a
  // round trip the session can end during.
  const uid = userId.value ?? ''
  notificationMode.value = mode
  setNotificationPreference(localStorage, uid, mode)
  notificationHint.value = ''

  if (mode === 'off') {
    await disablePushNotifications()
    return
  }

  if (!uid) return
  const result = await enablePushNotifications(uid)
  if (result === 'permission-denied') {
    // The browser said no — reflect reality instead of a toggle that lies.
    notificationMode.value = 'off'
    setNotificationPreference(localStorage, uid, 'off')
    notificationHint.value = t('error.notificationsBlocked')
  } else if (result === 'error') {
    notificationMode.value = 'off'
    setNotificationPreference(localStorage, uid, 'off')
    notificationHint.value = t('error.notificationsFailed')
  }
  // 'unsupported' / 'not-configured': push is unavailable in this environment;
  // the preference is still saved and the toggle stays on.
}

// Mirrors the stored choices into the controls. Applying the theme and following
// the OS belong to lib/theme (startTheme, from main.ts), not to this dialog.
onMounted(() => {
  syncPreferencesFromStorage()
})

// The preference could have changed since this was last open — the browser's own
// notification permission can be revoked from outside the app entirely — so
// re-read rather than trusting what the dialog showed last time.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    syncPreferencesFromStorage()
  },
)
</script>

<template>
  <AppModal :open="open" overlay-class="app-settings-overlay" transition="modal-fade" @close="emit('close')">
    <div class="app-settings" role="dialog" aria-modal="true" aria-labelledby="app-settings-title">
      <div class="app-settings__header">
        <div class="app-settings__title-wrap">
          <div class="app-settings__icon-bg">
            <AppIcon class="header-icon" name="settings" />
          </div>
          <div>
            <h3 id="app-settings-title">{{ t('settings.title') }}</h3>
            <p class="app-settings__subtitle">{{ t('settings.subtitle') }}</p>
          </div>
        </div>
        <ModalCloseButton :aria-label="t('settings.close')" @click="emit('close')" />
      </div>

      <div class="app-settings__body">
        <section class="app-settings__section">
          <h4 id="app-appearance-label" class="app-settings__section-title">{{ t('settings.appearance') }}</h4>
          <div class="segmented" role="group" aria-labelledby="app-appearance-label">
            <button
              class="segmented__btn"
              :class="{ 'segmented__btn--active': themeMode === 'light' }"
              type="button"
              @click="applyTheme('light')"
            >
              <span class="control-icon control-icon--theme-light" aria-hidden="true"></span>
              <span>{{ t('settings.theme.light') }}</span>
            </button>
            <button
              class="segmented__btn"
              :class="{ 'segmented__btn--active': themeMode === 'dark' }"
              type="button"
              @click="applyTheme('dark')"
            >
              <span class="control-icon control-icon--theme-dark" aria-hidden="true"></span>
              <span>{{ t('settings.theme.dark') }}</span>
            </button>
            <button
              class="segmented__btn"
              :class="{ 'segmented__btn--active': themeMode === 'system' }"
              type="button"
              @click="applyTheme('system')"
            >
              <span class="control-icon control-icon--theme-system" aria-hidden="true"></span>
              <span>{{ t('settings.theme.system') }}</span>
            </button>
          </div>
        </section>

        <section class="app-settings__section">
          <h4 id="app-notifications-label" class="app-settings__section-title">{{ t('settings.notifications') }}</h4>
          <div class="segmented segmented--two" role="group" aria-labelledby="app-notifications-label">
            <button
              class="segmented__btn"
              :class="{ 'segmented__btn--active': notificationMode === 'on' }"
              type="button"
              @click="applyNotifications('on')"
            >
              <span class="control-icon control-icon--notify-all" aria-hidden="true"></span>
              <span>{{ t('settings.notifications.on') }}</span>
            </button>
            <button
              class="segmented__btn"
              :class="{ 'segmented__btn--active': notificationMode === 'off' }"
              type="button"
              @click="applyNotifications('off')"
            >
              <span class="control-icon control-icon--notify-off" aria-hidden="true"></span>
              <span>{{ t('settings.notifications.off') }}</span>
            </button>
          </div>
        </section>

        <section class="app-settings__section">
          <h4 id="app-replay-label" class="app-settings__section-title">{{ t('settings.replay') }}</h4>
          <p class="app-settings__row-hint">{{ t('settings.replay.hint') }}</p>
          <div class="segmented segmented--two" role="group" aria-labelledby="app-replay-label">
            <button
              class="segmented__btn"
              :class="{ 'segmented__btn--active': replayMode === 'on' }"
              type="button"
              @click="applyReplay('on')"
            >
              <span>{{ t('settings.replay.on') }}</span>
            </button>
            <button
              class="segmented__btn"
              :class="{ 'segmented__btn--active': replayMode === 'off' }"
              type="button"
              @click="applyReplay('off')"
            >
              <span>{{ t('settings.replay.off') }}</span>
            </button>
          </div>
        </section>

        <!-- One more of a kind: same section shell, same segmented control,
             same apply-on-tap as the ones above. LanguagePicker draws it, and
             classes it .lang-seg rather than .segmented — deliberately, so
             that the two helpers in test/appSettingsModal.component.test.js
             which index .segmented positionally (.at(0) Appearance, .at(1)
             Notifications) cannot be retargeted by this section existing. -->
        <section class="app-settings__section">
          <h4 class="app-settings__section-title">{{ t('settings.language') }}</h4>
          <LanguagePicker variant="compact" :current="currentLocale" @confirm="chooseLanguage" />
        </section>

        <button class="app-settings__row" type="button" @click="aboutOpen = true">
          <span class="app-settings__row-label">{{ t('settings.about') }}</span>
          <span class="app-settings__row-hint">{{ t('settings.aboutHint', { version: appVersion }) }}</span>
        </button>
      </div>
    </div>
  </AppModal>

  <!-- Where the product data comes from, said where a user can reach it.
       Behind a button is still "somewhere a user can reach"; deleting it is not.
       test/dataAttribution.component.test.js fails if it stops being reachable.

       This USED to be an ODbL licence notice for Open Food Facts and its two
       sibling projects, which was an obligation rather than a courtesy. The
       catalog no longer uses any of them -- it is built from what the shops
       themselves list -- so the obligation is gone and the
       credit changed with it. It is kept because naming your sources is right,
       not because a licence now compels it. -->
  <AppModal :open="aboutOpen" overlay-class="about-overlay" transition="modal-fade" @close="aboutOpen = false">
    <div class="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title">
      <ModalCloseButton class="about-dialog__close" :aria-label="t('about.close')" @click="aboutOpen = false" />
      <img src="/icons/pwa-192.png" alt="" class="about-logo" />
      <!-- eslint-disable-next-line vue/no-bare-strings-in-template -- brand name, the same in every language -->
      <h3 id="about-dialog-title" class="about-name">Bagful</h3>
      <p class="about-version">{{ t('about.versionLine', { version: appVersion }) }}</p>

      <!-- The project this build is actually talking to. Only on nightly, and
           deliberately raw: it is here so that a screenshot of a phone answers
           "which database was that?" without anyone having to reproduce the
           bug first. Untranslated, since a Supabase project ref is a name. -->
      <!-- eslint-disable-next-line vue/no-bare-strings-in-template -- a project ref, not copy -->
      <p v-if="IS_NIGHTLY" class="about-project">{{ SUPABASE_PROJECT_REF }}</p>

      <div v-if="canCheckForUpdates" class="about-update">
        <AppButton
          variant="secondary"
          size="sm"
          :disabled="updateCheckState === 'checking'"
          @click="checkForUpdates"
        >
          {{ updateCheckState === 'checking' ? t('about.checking') : t('about.checkUpdates') }}
        </AppButton>
        <p v-if="updateCheckState === 'up-to-date'" class="about-update__result">
          {{ t('about.upToDate') }}
        </p>
        <p v-else-if="updateCheckState === 'failed'" class="about-update__result">
          {{ t('about.checkFailed') }}
        </p>
      </div>

      <!-- The shops are the catalog's own list for this phone's country, so a
           new retailer is credited the day it starts producing data, with no
           release. The commas and the "and" come from Intl.ListFormat in the
           app's language; each name is a proper noun, linked to the site its
           scraper reads. Hidden when the catalog has never answered. -->
      <p v-if="creditParts.length" class="about-credit">
        {{ t('about.creditLead') }}
        <template v-for="(part, i) in creditParts" :key="i">
          <a
            v-if="part.url"
            class="settings-note-link"
            :href="part.url"
            target="_blank"
            rel="noopener noreferrer"
          >{{ part.text }}</a>
          <template v-else>{{ part.text }}</template>
        </template>{{ t('about.creditEnd') }}
      </p>
    </div>
  </AppModal>

  <ErrorModal :title="t('settings.notifications')" :message="notificationHint" @dismiss="notificationHint = ''" />
</template>

<style scoped>
.app-settings-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) calc(var(--space-4) + var(--safe-bottom));
}

.app-settings {
  width: 100%;
  max-width: 380px;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-height: 100%;
}

.app-settings__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  flex-shrink: 0;
}

.app-settings__title-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.app-settings__icon-bg {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  color: var(--color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.header-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.app-settings__header h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.app-settings__subtitle {
  margin: 0.1rem 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

.app-settings__body {
  padding: 0 var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow-y: auto;
}

.app-settings__section-title {
  margin: 0 0 0.4rem 0.15rem;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

/* Same box as the account dialog's rows, so a row that opens something looks
   the same wherever you meet one. */
.app-settings__row {
  width: 100%;
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--bg-surface);
  border-radius: var(--radius-md);
  padding: 0.65rem 0.75rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--transition-base) ease, border-color var(--transition-base) ease;
}

.app-settings__row:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--bg-surface));
}

.app-settings__row-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.app-settings__row-hint {
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

/* ─── Segmented controls ─────────────────────────────────────────────────── */
.segmented {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.35rem;
  background: var(--bg-surface-alt);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: 0.25rem;
}

.segmented--two {
  grid-template-columns: repeat(2, 1fr);
}

.segmented__btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  border-radius: var(--radius-sm);
  padding: 0.42rem 0.2rem;
  cursor: pointer;
  transition: all var(--transition-fast) ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.28rem;
}

.segmented__btn:hover:not(.segmented__btn--active) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.segmented__btn--active {
  background: var(--bg-surface);
  color: var(--color-primary);
  box-shadow: var(--elevation-soft);
}

.control-icon {
  width: 12px;
  height: 12px;
  display: inline-block;
  background-color: currentColor;
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}

.control-icon--theme-light {
  mask-image: url('../assets/sun-medium.svg');
  -webkit-mask-image: url('../assets/sun-medium.svg');
}

.control-icon--theme-dark {
  mask-image: url('../assets/moon.svg');
  -webkit-mask-image: url('../assets/moon.svg');
}

.control-icon--theme-system {
  mask-image: url('../assets/sun-moon.svg');
  -webkit-mask-image: url('../assets/sun-moon.svg');
}

.control-icon--notify-all {
  mask-image: url('../assets/bell.svg');
  -webkit-mask-image: url('../assets/bell.svg');
}

.control-icon--notify-off {
  mask-image: url('../assets/bell-off.svg');
  -webkit-mask-image: url('../assets/bell-off.svg');
}

/* ─── About ──────────────────────────────────────────────────────────────── */
.about-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Above App Settings, which opened it. */
  z-index: 1200;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) calc(var(--space-4) + var(--safe-bottom));
}

.about-dialog {
  position: relative;
  width: 100%;
  max-width: 320px;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-modal);
  padding: var(--space-6) var(--space-5) var(--space-5);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.about-dialog__close {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
}

.about-logo {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  object-fit: contain;
}

.about-name {
  margin: var(--space-3) 0 0;
  font-size: var(--text-md);
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.about-version {
  margin: 0.2rem 0 0;
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.about-project {
  margin: 0.15rem 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.about-update {
  margin-top: var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
}

.about-update__result {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.4;
}

.about-credit {
  margin: var(--space-4) 0 0;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--text-secondary);
  max-width: 30ch;
}

.settings-note-link {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.settings-note-link:hover,
.settings-note-link:focus-visible {
  color: var(--text-primary);
}

/* ─── Transition ─────────────────────────────────────────────────────────── */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-active .app-settings,
.modal-fade-enter-active .about-dialog {
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

.modal-fade-leave-active .app-settings,
.modal-fade-leave-active .about-dialog {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}

@media (max-width: 520px) {
  .app-settings-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .app-settings {
    max-width: none;
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom));
    max-height: 92vh;
    /* Flush with the bottom edge, so it can travel its full height and start
       off screen rather than merely nudging up. */
    --modal-rise: 100%;
  }
}
</style>
