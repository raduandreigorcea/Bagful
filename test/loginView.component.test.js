// @vitest-environment happy-dom
//
// Component tests for LoginView's error routing: every failure pops a modal —
// already-signed-in gets its own dialog with a go-home action, other sign-in
// failures get the shared ErrorModal — and a signed-in user sitting on the
// login page is redirected home.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import LoginView from '../src/views/LoginView.vue'
import ErrorModal from '../src/components/ErrorModal.vue'
import ConfirmModal from '../src/components/ConfirmModal.vue'

const mocks = vi.hoisted(() => ({
  create: async () => ({}),
  isSignedIn: null,
  routerReplace: () => {},
  isNative: false,
  startNativeOAuth: vi.fn(),
  setActive: vi.fn(),
  signUpCreate: vi.fn(async () => ({})),
  authenticateWithRedirect: vi.fn(),
}))

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return {
    useSignIn: () => ({
      signIn: ref({
        create: (...args) => mocks.create(...args),
        prepareFirstFactor: async () => {},
        attemptFirstFactor: async () => ({ status: 'complete' }),
        authenticateWithRedirect: (...args) => mocks.authenticateWithRedirect(...args),
      }),
      isLoaded: ref(true),
    }),
    useSignUp: () => ({ signUp: ref({ create: (...args) => mocks.signUpCreate(...args), prepareEmailAddressVerification: async () => {} }) }),
    useClerk: () => ref({ setActive: (...args) => mocks.setActive(...args) }),
    useAuth: () => ({ isSignedIn: mocks.isSignedIn }),
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.isNative },
}))

vi.mock('../src/lib/nativeOAuth', () => ({
  startNativeOAuth: (...args) => mocks.startNativeOAuth(...args),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: (...args) => mocks.routerReplace(...args) }),
}))

const mountedWrappers = []

function mountLogin() {
  const wrapper = mount(LoginView)
  mountedWrappers.push(wrapper)
  return wrapper
}

async function submitEmail(wrapper, email = 'radu@example.com') {
  await wrapper.find('input[type="email"]').setValue(email)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

function clerkError(code, message) {
  return Object.assign(new Error(message), { errors: [{ code, message }] })
}

beforeEach(() => {
  mocks.isSignedIn = ref(false)
  mocks.routerReplace = vi.fn()
  mocks.isNative = false
  mocks.startNativeOAuth.mockReset()
  mocks.setActive.mockReset()
  mocks.authenticateWithRedirect.mockReset()
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop().unmount()
  vi.restoreAllMocks()
})

describe('LoginView error routing', () => {
  it('shows the already-signed-in dialog (not the error dialog) on session_exists', async () => {
    mocks.create = async () => {
      throw clerkError('session_exists', "You're currently in single session mode.")
    }
    const wrapper = mountLogin()
    await submitEmail(wrapper)

    // First ConfirmModal in the tree is the already-signed-in dialog.
    expect(wrapper.findComponent(ConfirmModal).props('open')).toBe(true)
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('')
  })

  it('pops the error dialog for other sign-in failures', async () => {
    mocks.create = async () => {
      throw clerkError('form_param_format_invalid', "That email looks wrong.")
    }
    const wrapper = mountLogin()
    await submitEmail(wrapper)

    expect(wrapper.findComponent(ConfirmModal).props('open')).toBe(false)
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('That email looks wrong.')
  })

  it('does not register an email nobody has used, and says to use a provider', async () => {
    mocks.create = async () => {
      throw clerkError('form_identifier_not_found', 'No account.')
    }
    const wrapper = mountLogin()
    await submitEmail(wrapper)

    expect(mocks.signUpCreate).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ErrorModal).props('message')).toContain('Create one with Google')
  })

  it('clears the error when the dialog is dismissed', async () => {
    mocks.create = async () => {
      throw clerkError('form_param_format_invalid', "That email looks wrong.")
    }
    const wrapper = mountLogin()
    await submitEmail(wrapper)

    await wrapper.findComponent(ErrorModal).find('button').trigger('click')

    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('')
  })

  it('redirects home when the user turns out to be signed in', async () => {
    const wrapper = mountLogin()
    expect(mocks.routerReplace).not.toHaveBeenCalled()

    mocks.isSignedIn.value = true
    await wrapper.vm.$nextTick()

    expect(mocks.routerReplace).toHaveBeenCalledWith('/')
  })

  it('redirects home immediately when already signed in at mount', async () => {
    mocks.isSignedIn.value = true
    mountLogin()
    await flushPromises()

    expect(mocks.routerReplace).toHaveBeenCalledWith('/')
  })
})

// The native app must never run OAuth inside the WebView: the buttons hand the
// flow to the system browser (startNativeOAuth) and only activate the session
// the callback delivered. The web redirect path stays untouched.
describe('LoginView native OAuth wiring', () => {
  async function clickGoogle(wrapper) {
    await wrapper.find('.oauth-btn').trigger('click')
    await flushPromises()
  }

  it('activates the returned session instead of redirecting the WebView', async () => {
    mocks.isNative = true
    mocks.startNativeOAuth.mockResolvedValue('sess_native_1')
    const wrapper = mountLogin()
    await clickGoogle(wrapper)

    expect(mocks.startNativeOAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'oauth_google',
    )
    expect(mocks.setActive).toHaveBeenCalledWith({ session: 'sess_native_1' })
    expect(mocks.authenticateWithRedirect).not.toHaveBeenCalled()
  })

  it('still enters the app when session activation throws client-side', async () => {
    // The session exists server-side once startNativeOAuth returns an id;
    // a client-side activation crash must not strand the user on the login
    // screen (the full reload re-reads the session from the server).
    mocks.isNative = true
    mocks.startNativeOAuth.mockResolvedValue('sess_native_2')
    mocks.setActive.mockRejectedValue(
      new TypeError('Cannot read private member #q'),
    )
    const wrapper = mountLogin()
    await clickGoogle(wrapper)

    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('')
  })

  it('quietly re-arms the buttons when the user closes the browser', async () => {
    mocks.isNative = true
    mocks.startNativeOAuth.mockResolvedValue(null)
    const wrapper = mountLogin()
    await clickGoogle(wrapper)

    expect(mocks.setActive).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('')
    // A second attempt must not be swallowed by a stuck loading flag.
    await clickGoogle(wrapper)
    expect(mocks.startNativeOAuth).toHaveBeenCalledTimes(2)
  })

  it('routes native OAuth failures into the error dialog', async () => {
    mocks.isNative = true
    mocks.startNativeOAuth.mockRejectedValue(
      clerkError('oauth_access_denied', 'Access denied.'),
    )
    const wrapper = mountLogin()
    await clickGoogle(wrapper)

    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('Access denied.')
    expect(mocks.setActive).not.toHaveBeenCalled()
  })

  it('keeps the web redirect flow in browsers', async () => {
    mocks.isNative = false
    const wrapper = mountLogin()
    await clickGoogle(wrapper)

    expect(mocks.authenticateWithRedirect).toHaveBeenCalled()
    expect(mocks.startNativeOAuth).not.toHaveBeenCalled()
  })
})
