// Clerk refuses unlinking and deleting a user until a stale session verifies
// again. Without the retry, those buttons fail for anyone who signed in a while
// ago, and Delete account strands a person whose data is already gone.
import { describe, it, expect, vi } from 'vitest'
import { ReverificationCancelled, withReverification } from '../src/lib/reverification'

const required = Object.assign(new Error('verify'), {
  errors: [{ code: 'session_reverification_required' }],
})

describe('withReverification', () => {
  it('asks Clerk to verify, then retries once', async () => {
    const action = vi.fn().mockRejectedValueOnce(required).mockResolvedValueOnce('done')
    const clerk = { __internal_openReverification: vi.fn((p) => p.afterVerification()) }

    await expect(withReverification(clerk, action)).resolves.toBe('done')
    expect(clerk.__internal_openReverification).toHaveBeenCalledOnce()
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('rejects with ReverificationCancelled when the window is closed', async () => {
    const action = vi.fn().mockRejectedValue(required)
    const clerk = { __internal_openReverification: (p) => p.afterVerificationCancelled() }

    await expect(withReverification(clerk, action)).rejects.toBeInstanceOf(ReverificationCancelled)
    expect(action).toHaveBeenCalledOnce()
  })

  it('passes any other error straight through', async () => {
    const other = Object.assign(new Error('nope'), { errors: [{ code: 'form_param_invalid' }] })
    const clerk = { __internal_openReverification: vi.fn() }

    await expect(withReverification(clerk, () => Promise.reject(other))).rejects.toBe(other)
    expect(clerk.__internal_openReverification).not.toHaveBeenCalled()
  })
})
