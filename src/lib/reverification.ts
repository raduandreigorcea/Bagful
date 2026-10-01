import { toRaw } from 'vue'

// Clerk refuses sensitive actions (unlinking an account, deleting the user) when
// the session's last sign-in is not recent enough, with the error code
// session_reverification_required. Its own UserProfile asks again in a modal;
// AccountProfileModal replaced that, so it has to ask too, or those actions
// simply fail for anyone who signed in a while ago (and Delete account would
// leave the data gone but the sign-in still there).
//
// @clerk/vue 2.x has no useReverification composable, so this calls the modal
// that the React hook calls, __internal_openReverification. "Internal" is
// Clerk's naming; it is the documented route their own hooks take. If a Clerk
// upgrade removes it, the action fails with Clerk's original error instead.

export interface ReverifyingClerk {
  __internal_openReverification?: (props?: {
    afterVerification?: () => void
    afterVerificationCancelled?: () => void
  }) => void
}

/** The person closed the verification window instead of verifying. */
export class ReverificationCancelled extends Error {
  constructor() {
    super('Verification was cancelled.')
    this.name = 'ReverificationCancelled'
  }
}

export function needsReverification(error: unknown): boolean {
  const errors = (error as { errors?: Array<{ code?: string }> } | null)?.errors
  return Array.isArray(errors) && errors.some((e) => e.code === 'session_reverification_required')
}

/**
 * Runs `action`; if Clerk asks for a fresh verification, opens Clerk's window
 * for it and runs `action` once more. Rejects with ReverificationCancelled if
 * the window is closed.
 */
export async function withReverification<T>(
  clerk: ReverifyingClerk | null | undefined,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    // Raw, for the private-field reason in nativeOAuth.ts.
    const raw = clerk ? toRaw(clerk) : null
    if (!needsReverification(error) || !raw?.__internal_openReverification) throw error
    await new Promise<void>((resolve, reject) => {
      raw.__internal_openReverification!({
        afterVerification: resolve,
        afterVerificationCancelled: () => reject(new ReverificationCancelled()),
      })
    })
    return action()
  }
}
