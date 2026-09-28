import { describe, it, expect, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => [])
vi.mock('../src/lib/errorReporting', () => ({ captureException: (e) => captured.push(e) }))

import { UserFacingError, userMessage } from '../src/lib/errorMessages.ts'

beforeEach(() => { captured.length = 0 })

describe('userMessage', () => {
  it('shows a UserFacingError message as written', () => {
    const error = new UserFacingError('You can only own one list.')
    expect(userMessage(error, 'Failed to create list.')).toBe('You can only own one list.')
  })

  it('masks raw Postgres error text with the fallback', () => {
    const error = {
      message: 'duplicate key value violates unique constraint "lists_one_per_owner"',
      code: '23505',
    }
    expect(userMessage(error, 'Failed to create list.')).toBe('Failed to create list.')
  })

  it('masks permission-denied text, which names the table', () => {
    const error = { message: 'permission denied for table shopping_list_items' }
    expect(userMessage(error, 'Could not update that item.')).toBe('Could not update that item.')
  })

  it('masks a plain Error, so only a tagged one is ever trusted', () => {
    expect(userMessage(new Error('relation "profiles" does not exist'), 'Failed.')).toBe('Failed.')
  })

  it('falls back for null/undefined errors', () => {
    expect(userMessage(null, 'Failed.')).toBe('Failed.')
    expect(userMessage(undefined, 'Failed.')).toBe('Failed.')
  })

  it('keeps UserFacingError instanceof Error, so existing catch/throw paths still work', () => {
    expect(new UserFacingError('x')).toBeInstanceOf(Error)
  })

  // Found through the bot swarm: every list-settings save cut off by the page
  // being left (a reload, the browser's Back) arrived in Sentry as an error.
  // A request that never got an answer is the network's doing, not a fault in
  // the app, and loadListHeader and the list actions already treat it so.
  it('reports a server error, but not a request that died on the network', () => {
    userMessage({ code: '42501', message: 'permission denied for table lists' }, 'Failed.')
    expect(captured).toHaveLength(1)

    const died = { code: '', details: 'TypeError: Failed to fetch', hint: '', message: 'TypeError: Failed to fetch (arkqdpvguqfsdocmfwaf.supabase.co)' }
    expect(userMessage(died, 'Could not save the list icon.')).toBe('Could not save the list icon.')
    expect(captured).toHaveLength(1)
  })
})
