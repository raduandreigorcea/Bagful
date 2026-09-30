// Carries settings over from the FamCart names.
//
// v0.7.2 renamed every localStorage key from famcart-* to bagful-*, and the web
// app kept its address, so every returning browser lost its theme, language,
// sort order and "tour seen" at once. This moves each old value to its new name
// the first time the new code runs, before anything reads it: main.ts imports
// this module first for that reason, since an import runs before the importing
// module's body and some modules read storage as they load.
//
// A value already under the new name wins: it was set after the rename, so it
// is the newer answer. The old key is removed either way, so this does nothing
// on every launch after the first. Safe to delete once no browser that last ran
// a FamCart build is likely to come back.

// First match wins, so the two household keys (renamed later, after the
// households→lists rename) come before the general prefix rule, and cover
// both generations of their old name.
const RENAMES: [RegExp, string][] = [
  [/^(famcart|bagful)-household-snapshot/, 'bagful-list-snapshot'],
  [/^(famcart|bagful)-active-household/, 'bagful-active-list'],
  [/^famcart-/, 'bagful-'],
  [/^famcart\./, 'bagful.'],
  [/^famcart_/, 'bagful_'],
]

export function migrateLegacyKeys(storage: Storage): void {
  try {
    const oldKeys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key && RENAMES.some(([from]) => from.test(key))) oldKeys.push(key)
    }
    for (const oldKey of oldKeys) {
      const rule = RENAMES.find(([from]) => from.test(oldKey))
      if (!rule) continue
      const newKey = oldKey.replace(rule[0], rule[1])
      const value = storage.getItem(oldKey)
      if (value !== null && storage.getItem(newKey) === null) storage.setItem(newKey, value)
      storage.removeItem(oldKey)
    }
  } catch {
    // Storage blocked or full: the app starts with defaults, as it would have.
  }
}

try {
  migrateLegacyKeys(localStorage)
} catch {
  // Reading `localStorage` itself throws where storage is blocked.
}
