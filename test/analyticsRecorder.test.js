// @vitest-environment happy-dom
//
// The real recorder entry, unmocked: analytics.test.js mocks it, so only this
// file notices if the import in startReplay stops registering the driver.
// dist/recorder registers rrweb alone; with disable_external_dependency_loading
// the SDK will not fetch initSessionRecording, so replay silently never starts.
import { it, expect } from 'vitest'

it('registers the session recording driver PostHog needs to start replay', async () => {
  await import('posthog-js/dist/posthog-recorder')
  expect(typeof window.__PosthogExtensions__.initSessionRecording).toBe('function')
})
