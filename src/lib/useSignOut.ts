import { ref, type Ref } from 'vue'
import { useClerk } from '@clerk/vue'
import { forgetLocalUserState } from './session'
import { logoutPushUser } from './pushNotifications'
import { captureException, identifyUser } from './errorReporting'

// Everything that has to happen when somebody signs out, in the order it has to
// happen in.
//
// This lived in AppNavBar, which is a navigation shell that also happens to
// host six dialogs — so the one piece of it that is not about drawing anything
// was the hardest to find and the only part that could not be tested without
// mounting the whole bar. Four subsystems are torn down here and each of them
// has a reason to be at the position it is:
//
//   • Local state first, because it is the only step that cannot fail and the
//     only one whose failure would be silent. lib/session owns the list of what
//     that means, which is why this calls one function rather than four.
//   • Sentry's identity next. setUser is sticky module state rather than
//     per-event, so anything raised after this point would otherwise still be
//     filed under the person who just left.
//   • OneSignal, unawaited. A device left bound is the next person on this
//     phone inheriting the previous account's notifications, and it must not be
//     able to hold the sign-out up on a CDN.
//   • Clerk last, because it is the step that navigates away and nothing after
//     it is guaranteed to run.
//
// The catch matters more than it looks: by the time Clerk is asked, the session
// is already over locally, so a failure there is worth reporting and not worth
// a dialog on the way out.

export interface SignOut {
  /** True for the length of one sign-out, so the control cannot be pressed twice. */
  signingOut: Ref<boolean>
  /** Resolves once the teardown is done — or has failed in a way worth ignoring. */
  signOut: () => Promise<void>
}

export function useSignOut(options: {
  /**
   * The account being signed out, where the caller knows it.
   *
   * Empty is a supported answer rather than a missing one: the topbar renders
   * on ListSetupView with no props, and lib/session then clears EVERY
   * account's queue and snapshot on the device instead of one. That is the
   * safer end of the trade on a shared browser — leaving one behind is the
   * failure the per-account keying was introduced to prevent.
   */
  userId: () => string
  /** Called once Clerk has accepted, before the redirect takes the page. */
  onSignedOut?: () => void
}): SignOut {
  const { userId, onSignedOut } = options
  const clerk = useClerk()
  const signingOut = ref(false)

  async function signOut(): Promise<void> {
    if (signingOut.value) return
    signingOut.value = true
    try {
      forgetLocalUserState(localStorage, userId() || undefined)
      identifyUser(null)
      void logoutPushUser()
      await clerk.value?.signOut({ redirectUrl: `${window.location.origin}/login` })
      onSignedOut?.()
    } catch (error) {
      // The local data is already cleared by this point, so the session is
      // effectively over either way; what failed is Clerk's own teardown, which
      // is worth knowing about but not worth a dialog on the way out.
      captureException(error)
      // Clerk never got to navigate, so leave for the login screen ourselves
      // rather than strand the person on a page whose local data is gone.
      window.location.assign('/login')
    } finally {
      signingOut.value = false
    }
  }

  return { signingOut, signOut }
}
