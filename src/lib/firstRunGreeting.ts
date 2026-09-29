import { ref, type Ref } from 'vue'
import { t } from './i18n'
import { hasSeenTour, markTourSeen } from './onboarding'
import { track } from './analytics'
import {
  enablePushNotifications,
  getNotificationPreference,
  getOneSignalAppId,
  isDesktopBrowser,
  isPushSupported,
  setNotificationPreference,
} from './pushNotifications'

// What a new user is shown once, and in what order: the gesture tour first, then
// the notifications ask. One unit rather than two, because the order is the
// point — the tour hands off to the ask when it closes, and being asked for a
// permission before you know what the app does is how you get a "no".
//
// Extracted from HomeView, which owned both alongside six other concerns. The
// view now just renders the two dialogs and hands back the answers.

export interface FirstRunGreeting {
  onboardingTourOpen: Ref<boolean>
  notificationPromptOpen: Ref<boolean>
  // Surfaced by the caller through its own error dialog rather than here, so
  // every failure in the view arrives on one surface.
  notificationError: Ref<string>
  /** Begin the sequence, once the list is up and worth looking at. */
  start: () => void
  /** Whether the sequence still has a dialog to show. */
  isGreeting: () => boolean
  closeTour: () => void
  acceptNotifications: () => Promise<void>
  declineNotifications: () => void
}

export function useFirstRunGreeting(options: {
  userId: Ref<string | null | undefined>
  // Passed in rather than read here: the view's notion of offline includes a
  // failed write, not just navigator.onLine, and there should be one answer.
  isOffline: () => boolean
  storage?: Storage
  // Called once this sequence has nothing left to show — immediately for a
  // returning user, or when the last dialog in it closes.
  //
  // Anything else that wants the screen on startup has to wait for this rather
  // than race it. The update offer learned that the hard way: it ran straight
  // after start(), found the tour already open, and stood down for good, so a
  // freshly installed old APK never got told it was old — which is the one case
  // where it matters most, since an APK is sideloaded and can be any age.
  onSettled?: () => void
}): FirstRunGreeting {
  const { userId, isOffline } = options
  const storage = options.storage ?? localStorage

  const onboardingTourOpen = ref(false)
  const notificationPromptOpen = ref(false)
  const notificationError = ref('')

  function settle(): void {
    options.onSettled?.()
  }

  // First-login greeting: users who never answered the notifications question
  // get asked once, right after their list is up. An unset preference is the
  // signal — both prompt buttons store a decision, so it never re-appears.
  function shouldPromptForNotifications(): boolean {
    if (!userId.value) return false
    if (getNotificationPreference(storage, userId.value)) return false
    // No point asking where accepting could do nothing: unsupported browser,
    // push not configured, or offline (the OneSignal subscription needs the
    // network). Leaving the preference unset re-asks on the next login instead.
    if (!isPushSupported() || !getOneSignalAppId() || isOffline()) return false
    // Desktop browsers never get greeted with a permission ask; the preference
    // stays unset so the same account is still asked on a phone later.
    if (isDesktopBrowser()) return false
    return true
  }

  function maybePromptForNotifications(): void {
    if (!shouldPromptForNotifications()) {
      settle()
      return
    }
    notificationPromptOpen.value = true
  }

  function start(): void {
    if (!userId.value) {
      settle()
      return
    }
    if (!hasSeenTour(storage)) {
      onboardingTourOpen.value = true
      return
    }
    maybePromptForNotifications()
  }

  function closeTour(): void {
    onboardingTourOpen.value = false
    markTourSeen(storage)
    track('onboarding_completed')
    maybePromptForNotifications()
  }

  function isGreeting(): boolean {
    return onboardingTourOpen.value || notificationPromptOpen.value
  }

  async function acceptNotifications(): Promise<void> {
    notificationPromptOpen.value = false
    // Read once, up front: the preference belongs to the account that answered
    // the prompt, and enabling push is a round trip the session can end during.
    // Re-reading the ref after it would file the answer under whoever is signed
    // in by then, or under nobody.
    const uid = userId.value ?? ''
    setNotificationPreference(storage, uid, 'on')
    const result = await enablePushNotifications(uid)
    if (result === 'permission-denied') {
      // The browser said no — reflect reality instead of a preference that lies.
      setNotificationPreference(storage, uid, 'off')
      notificationError.value = t('error.notificationsBlocked')
    } else if (result === 'error') {
      setNotificationPreference(storage, uid, 'off')
      notificationError.value = t('error.notificationsFromSettings')
    }
    settle()
  }

  function declineNotifications(): void {
    notificationPromptOpen.value = false
    setNotificationPreference(storage, userId.value ?? '', 'off')
    settle()
  }

  return {
    onboardingTourOpen,
    notificationPromptOpen,
    notificationError,
    start,
    isGreeting,
    closeTour,
    acceptNotifications,
    declineNotifications,
  }
}
