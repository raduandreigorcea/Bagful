// @vitest-environment happy-dom
//
// An address the app does not know used to render nothing at all: no route
// matched, so RouterView drew a blank page. /family-setup and /household-setup
// are the ones that mattered (old bookmarks and PWA shortcuts from before the
// rename to lists), and the catch-all now sends them, and any other stray link,
// home. The guard takes it from there to login or setup as needed.
import { it, expect } from 'vitest'
import router from '../src/router'

it.each(['/family-setup?add=1', '/household-setup', '/no-such-page', '/a/b/c'])('sends %s home', (path) => {
  expect(router.resolve(path).matched.at(-1)?.redirect).toBe('/')
})

it('leaves the real routes alone', () => {
  expect(router.resolve('/list-setup').name).toBe('list-setup')
  expect(router.resolve('/login').name).toBe('login')
})
