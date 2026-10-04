import js from '@eslint/js'
import ts from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

// Lint rules, added because the discipline they encode was previously held by
// hand alone. That worked — the audit that prompted this found no console.log,
// no TODO, no `any` and no @ts-ignore anywhere in src — but "one person keeps
// noticing" is not the same guarantee as "the build refuses", and the second one
// is the point of writing it down.
//
// Deliberately narrow. vue-tsc already owns types, props, emits and template
// expressions (npm run typecheck), and tsconfig already has noUnusedLocals and
// noUnusedParameters, so anything here that re-checks those is duplicated work
// with two places to disagree. What is left is the set vue-tsc structurally
// cannot see: template-shaped mistakes, and the debugging leftovers that are
// perfectly valid TypeScript.
//
// No formatting rules and no Prettier. Nothing in this repo is misformatted, the
// diffs a formatter would produce on first run would bury the history of every
// file it touched, and a reformat is not a thing to hide inside a lint config.
export default ts.config(
  {
    // Build output, the Android project, the vendored importer, and the
    // generated graph. None of it is ours to lint.
    ignores: [
      'dist/**',
      'dev-dist/**',
      'android/**',
      'graphify-out/**',
      'node_modules/**',
      // OneSignal's own service worker, shipped as-is from their CDN build. Not
      // ours to lint and not ours to change.
      'public/onesignal/**',
      // Local state written by `supabase db start` — gitignored, and it contains
      // a bundled edge-runtime entrypoint that is nothing to do with this app.
      'supabase/.temp/**',
      // The dashboard and catalog repos, cloned into these folders. Each carries
      // its own lint config and its own CI;
      // linting them from here would apply this app's rules to code that is not
      // this app's, and would fail outright on a checkout without them.
      'admin/**',
      'catalog/**',
    ],
  },

  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],

  {
    files: ['**/*.{js,mjs,ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Injected by the bundler from package.json — see the define in
        // vite.config.js and the declaration in src/vite-env.d.ts.
        __APP_VERSION__: 'readonly',
      },
      parserOptions: {
        // Every SFC declares lang="ts", so the script blocks need the TS parser
        // underneath vue-eslint-parser rather than the default one.
        parser: ts.parser,
      },
    },
    rules: {
      // The two that catch real leftovers rather than style. Both are errors
      // rather than warnings: a warning in a project with no lint history is a
      // thing nobody ever comes back to.
      'no-console': 'error',
      'no-debugger': 'error',

      // Every user-facing string goes through t() in src/locales. This is what
      // stops the next one from not doing so: a bare word in a template is now
      // a build failure, not something a reviewer has to spot.
      //
      // It sees templates only, so a string literal in <script> still needs
      // reading — and the trap there is the one lib/i18n's header documents at
      // length: a t() call at module scope evaluates once at import and never
      // follows a language change.
      //
      // allowlist covers the punctuation and symbols that are the same in every
      // language, so they do not each need a catalog key. Brand names and proper
      // nouns (Bagful, Open Food Facts, ODbL 1.0) carry a targeted disable
      // comment at their few sites instead of being listed here, because
      // listing them would also silence a genuine miss elsewhere.
      'vue/no-bare-strings-in-template': [
        'error',
        {
          allowlist: [
            '(', ')', ',', '.', '&', '+', '-', '=', '*', '/', '#', '%', '!', '?', ':',
            '[', ']', '{', '}', '<', '>', '·', '•', '|', '–', '—',
            '‘', '’', '“', '”', '…', 'x',
          ],
        },
      ],

      // vue-tsc reports unused locals and parameters already, with better
      // messages and across templates. Off here so one edit cannot produce two
      // different complaints.
      '@typescript-eslint/no-unused-vars': 'off',

      // `catch {}` with a comment explaining why is the established idiom in
      // this codebase — offline paths, storage that may be disabled, best-effort
      // plugin calls — and there are dozens of them, all deliberate.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Component names: the single-word ones here (AppModal, AppNavBar,
      // ShoppingList) are all prefixed or domain nouns already, and the rule
      // mostly objects to filenames this project has settled on.
      'vue/multi-word-component-names': 'off',

      // Attribute order and self-closing style are formatting by another name.
      'vue/attributes-order': 'off',
      'vue/html-self-closing': 'off',
      // Template indentation and line breaks, likewise — these fire in the
      // hundreds on markup that reads fine.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',

      // ON, with exactly one disabled site: the span inside AppIcon.vue.
      //
      // This was off, and the reasoning for that was sound as far as it went.
      // There were 57 v-html bindings across 15 files, every one of them an SVG
      // imported with Vite's `?raw` suffix or a brand mark declared as a literal
      // in the same file. All build-time content from this repository, no user
      // data, no network, no database. The rule cannot see that distinction, so
      // leaving it on produced 57 warnings that were all false — and 57 false
      // warnings are worse than none, because they train the eye to skip the
      // output.
      //
      // The flaw was in what the old note went on to say: that binding v-html to
      // a product name, a display name or a list name is what would make it
      // wrong, and that the answer would be "not to do it". Those three values
      // are what this app renders on every screen, and "do not do it" is not a
      // mechanism — it is a hope, held by whoever happens to review the diff.
      //
      // Routing every icon through one audited component is what turns it back
      // into a mechanism. AppIcon resolves a NAME through an eager
      // import.meta.glob over src/assets, so the only thing that can reach its
      // v-html is a .svg file in this repository; an unknown name renders
      // nothing. The disable lives around that one element rather than here, so
      // a v-html anywhere else — including one added to AppIcon tomorrow — fails
      // the build.
      'vue/no-v-html': 'error',

      // Off because following it would change what renders. The props it fires
      // on are InputRow's pass-throughs to a native <input> — placeholder,
      // autocomplete, maxlength, modelValue — where undefined and empty string
      // are different outcomes: Vue omits an attribute bound to undefined, and
      // renders autocomplete="" for the empty string. "No default" is the
      // correct declaration for an optional attribute, not an oversight.
      'vue/require-default-prop': 'off',
    },
  },

  {
    // Node scripts, not browser code. catalog/scripts holds the seed importer,
    // which is the same kind of thing as scripts/ at the root: a CLI tool run by
    // hand against a database, whose stdout is its whole interface.
    files: ['scripts/**/*.mjs', '*.config.js', 'vite.config.js', 'vitest.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // These are CLI tools whose output IS the interface.
      'no-console': 'off',
    },
  },

  {
    // The bot swarm: Node, but its page.evaluate callbacks run in the browser.
    files: ['bots/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['test/**/*.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // The service worker runs in a worker scope, so `self` and the workbox
    // manifest global are not part of the browser set above.
    files: ['src/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, self: 'readonly' },
    },
  },
)
