<script setup lang="ts">
import { computed } from 'vue'

// Every icon in the app, through one component.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Not to save the imports. It is so that `vue/no-v-html` can be ON.
//
// There were 58 v-html bindings across 15 files, each with its own `?raw`
// import, and the lint rule was disabled globally to keep them quiet. The
// argument for that was sound as far as it went -- all 58 were build-time SVGs
// from this repository, and 58 false warnings train the eye to skip lint output
// -- but it named the exact thing that would make it wrong (binding v-html to a
// product name, a display name, a list name) and then removed the only
// mechanism that would catch it. Those three values are what this app renders on
// every screen.
//
// One audited site is the way out. The rule is on everywhere else now, so a
// v-html on anything reaching a component from outside the bundle is a build
// failure rather than something a reviewer has to notice.
//
// ─── WHY v-html AT ALL ───────────────────────────────────────────────────────
//
// The alternative is <img>, which cannot inherit currentColor, so every icon
// would need a hardcoded colour and none of them would follow the theme.
//
// Safe by construction, and narrowly so: `markup` can only be a value from the
// eager glob below, which is to say a .svg file in this repository resolved at
// build time. An unknown name yields '' and renders nothing. No user data, no
// database value and no network response can reach it. The disable is around the
// one element rather than in eslint.config.js, so a genuine misuse anywhere else
// still fails the build.
//
// ─── WHY IT CARRIES NO STYLES ────────────────────────────────────────────────
//
// Deliberate, and the reason this differs from the dashboard's AppIcon, which
// owns its own sizing.
//
// This app already had a convention before this component existed: the wrapper
// span is sized by the calling component's scoped CSS, and 41 `:deep(svg)` rules
// set width/height/stroke per site, because the same glyph is a 14px tick in a
// suggestion row and a 40px mark in a dialog header. Shipping any box model here
// would fight all of them.
//
// So this renders the same span those rules were written against, and the
// caller's class lands on it: `.confirm-dialog__icon :deep(svg)` still matches,
// because a child component's root element carries the parent's scope id. The
// swap is therefore invisible in the rendered CSS, which is what made migrating
// 58 sites at once a reasonable thing to do.

// eager: the set is small and almost every one of these was already statically
// imported before this component existed. Lazy-loading them would mean a request
// per icon and a frame of empty boxes on first paint.
//
// Only icons/, flags/ and brands/, NOT the whole of assets/. product-icons/,
// list-icons/ and choice-icons/ have their own loaders (ProductIcon, listEmoji,
// ChoiceButton) and are never named here; globbing them too put a second copy of
// about 150 drawings, as raw strings, in a chunk the entry point imports, i.e. on
// every screen. A new folder whose files are drawn through AppIcon must be added
// to this list; an unknown name renders nothing.
//
// Five assets are used ONLY as CSS masks -- add, package-search, moon,
// sun-medium, sun-moon -- so they were bundled as URLs and are now bundled as raw
// strings as well. Excluding them would mean a hardcoded list here that silently
// rots the first time one of them is used as an icon.
//
// Names carry the folder for flags/ and brands/ (`flags/ro`, `brands/google`); the
// general-purpose icons in icons/ keep BARE names (`check`, `plus`): the prefix is
// dropped below, so moving them out of the assets root renamed no caller.
const FILES = import.meta.glob('../assets/{icons,flags,brands}/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, markup]) => [
    path.replace('../assets/', '').replace(/^icons\//, '').replace('.svg', ''),
    markup,
  ]),
)

const props = defineProps({
  /** File name under src/assets, without the extension: `check`, `flags/ro`. */
  name: { type: String, default: '' },
  /**
   * Icons sit beside their own label almost everywhere here, so they are hidden
   * from screen readers by default. Pass a label for the few that carry meaning
   * on their own.
   */
  label: { type: String, default: '' },
})

// '' for an unknown or empty name, which is a real state rather than a mistake:
// several sites bind conditionally and mean "draw nothing here".
const markup = computed(() => ICONS[props.name] ?? '')
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- see the header: `markup` can only be a
       build-time .svg from this repository, resolved through the eager glob
       above. Scoped to this one element so every other v-html still fails. -->
  <span
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    v-html="markup"
  ></span>
  <!-- eslint-enable vue/no-v-html -->
</template>
