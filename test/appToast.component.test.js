// @vitest-environment happy-dom
//
// When the toast stack pauses. A toast carries deferred work (a delete is only
// sent when its Undo toast goes), so a pause that never ends is a delete that
// never reaches the rest of the list. The bot swarm found exactly that: a
// mouse pointer left resting where toasts appear paused every new one on
// arrival, because a toast sliding in under a still pointer fires
// pointerenter. Someone reading a toast moves the mouse onto it; a pointer that
// only happens to be there does not.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AppToast from '../src/components/AppToast.vue'
import { dismissToast, showToast } from '../src/lib/useToast'

let wrapper = null

beforeEach(() => {
  vi.useFakeTimers()
  wrapper = mount(AppToast)
})

afterEach(() => {
  wrapper.unmount()
  dismissToast()
  vi.useRealTimers()
})

describe('the toast stack', () => {
  it('keeps counting down under a pointer that is only resting there', async () => {
    const onExpire = vi.fn()
    showToast({ message: 'Removed Milk', actionLabel: 'Undo', onExpire })
    await wrapper.find('.toast-region').trigger('pointerenter')

    vi.advanceTimersByTime(5000)
    expect(onExpire).toHaveBeenCalledOnce()
  })

  it('pauses while the pointer moves over it, and resumes when it leaves', async () => {
    const onExpire = vi.fn()
    showToast({ message: 'Removed Milk', actionLabel: 'Undo', onExpire })
    await wrapper.find('.toast-region').trigger('pointermove')

    vi.advanceTimersByTime(10000)
    expect(onExpire).not.toHaveBeenCalled()

    await wrapper.find('.toast-region').trigger('pointerleave')
    vi.advanceTimersByTime(5000)
    expect(onExpire).toHaveBeenCalledOnce()
  })
})
