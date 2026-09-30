// The theme preference: one key, one set of modes, one way of putting a mode
// onto the page.
//
// This existed twice — main.ts applied the saved theme before mount so the
// first paint is never the wrong colour, and AppSettingsModal read and wrote
// the same key with its own copy of the literal and its own resolver. Two
// spellings of one storage key is the exact hazard nativeUpdate.ts documents:
// a surface that needs two grep patterns to enumerate is one that gets missed
// when auditing what reads or clears it. Same argument as lib/inviteCode and
// lib/clipboard, both of which exist because a behaviour written twice drifts.

import { Capacitor, SystemBars, SystemBarsStyle, SystemBarType } from '@capacitor/core'

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'bagful-theme'

/**
 * The saved mode, or 'system' when nothing usable is saved. 'system' is the
 * app's default posture — follow the OS — so an unset key, a value no build
 * ever wrote, and storage being disabled all land on the same answer.
 */
export function loadThemeMode(storage: Pick<Storage, 'getItem'>): ThemeMode {
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY)
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
  } catch {
    return 'system'
  }
}

export function saveThemeMode(storage: Pick<Storage, 'setItem'>, mode: ThemeMode): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Storage disabled — the theme applies now and simply won't persist.
  }
}

/**
 * Resolve `mode` to a concrete light/dark and stamp it on the root element,
 * which is what every `[data-theme]` selector in style.css keys off.
 * 'system' asks the OS; startTheme re-applies it when the OS answer changes.
 */
export function applyResolvedTheme(mode: ThemeMode): void {
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode
  document.documentElement.setAttribute('data-theme', resolved)

  currentResolved = resolved
  applyNativeBars()
}

// Which theme is on screen, and whether the status bar is sitting over the
// brand green rather than the page. Remembered so that either one changing can
// restyle the bars without knowing about the other.
let currentResolved: 'light' | 'dark' = 'light'
let statusBarOnBrand = false

/**
 * The list screen's header is brand green and runs up behind the status bar,
 * so the clock and battery need light icons there whatever the theme. Screens
 * that draw it say so on mount and take it back on unmount; everywhere else the
 * status bar follows the theme like the navigation bar does.
 */
export function setStatusBarOnBrand(on: boolean): void {
  statusBarOnBrand = on
  applyNativeBars()
}

// Android colours the status bar icons and the navigation buttons from the
// PHONE's dark mode, never the app's. A phone in dark mode with the app set to
// Light drew white buttons over the app's near-white background, and they
// vanished. Telling it which theme is actually on screen keeps them visible in
// every combination. Dark style means light icons, for a dark background.
function applyNativeBars(): void {
  if (!Capacitor.isNativePlatform()) return
  const themed = currentResolved === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light
  void SystemBars.setStyle({
    style: statusBarOnBrand ? SystemBarsStyle.Dark : themed,
    bar: SystemBarType.StatusBar,
  }).catch(() => {})
  void SystemBars.setStyle({ style: themed, bar: SystemBarType.NavigationBar }).catch(() => {})
}

/**
 * Paint the saved mode, then keep following the OS while that mode is 'system'.
 *
 * Called once from main.ts. The listener used to live in the settings dialog,
 * so the login, setup and offline screens, which never mount it, stayed on
 * whatever the OS said at boot. The saved mode is re-read on each change rather
 * than remembered here, so a choice made in Settings needs no call back into
 * this module.
 */
export function startTheme(storage: Pick<Storage, 'getItem'>): void {
  applyResolvedTheme(loadThemeMode(storage))
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (loadThemeMode(storage) === 'system') applyResolvedTheme('system')
  })
}
