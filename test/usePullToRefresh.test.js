// @vitest-environment happy-dom
//
// A pull only refreshes when it began with the page at the top and was dragged
// far enough; anything else is an ordinary scroll and must do nothing.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { usePullToRefresh, PULL_THRESHOLD } from '../src/lib/usePullToRefresh'

function harness(refresh) {
  let state
  const wrapper = mount(
    defineComponent({
      setup() {
        state = usePullToRefresh(refresh)
        return () => h('div')
      },
    }),
  )
  return { state, wrapper }
}

const touch = (type, y) => {
  const e = new Event(type)
  e.touches = type === 'touchend' ? [] : [{ clientY: y }]
  window.dispatchEvent(e)
}

describe('pull to refresh', () => {
  it('refreshes after a long enough pull from the top', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const { state, wrapper } = harness(refresh)
    window.scrollY = 0
    touch('touchstart', 100)
    touch('touchmove', 100 + PULL_THRESHOLD * 2 + 10)
    expect(state.pull.value).toBeGreaterThanOrEqual(PULL_THRESHOLD)
    touch('touchend')
    await vi.waitFor(() => expect(state.pull.value).toBe(0))
    expect(refresh).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps following the finger past the threshold, without ever snapping back', () => {
    const { state, wrapper } = harness(vi.fn().mockResolvedValue(undefined))
    window.scrollY = 0
    touch('touchstart', 0)
    let last = 0
    for (const y of [200, 300, 400, 600, 1000]) {
      touch('touchmove', y)
      expect(state.pull.value).toBeGreaterThan(last)
      last = state.pull.value
    }
    touch('touchcancel')
    wrapper.unmount()
  })

  it('does nothing for a short pull, or one that began down the page', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const { state, wrapper } = harness(refresh)
    window.scrollY = 0
    touch('touchstart', 100)
    touch('touchmove', 130)
    touch('touchend')
    expect(state.pull.value).toBe(0)

    window.scrollY = 300
    touch('touchstart', 100)
    touch('touchmove', 400)
    touch('touchend')
    expect(refresh).not.toHaveBeenCalled()
    window.scrollY = 0
    wrapper.unmount()
  })
})
