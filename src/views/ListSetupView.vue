<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useAuth, useUser } from '@clerk/vue'
import { useRouter, useRoute } from 'vue-router'
import { useSupabase } from '../supabase'
import { saveActiveListId } from '../lib/listCache'
import { deriveProfileFields } from '../lib/userIdentity'
import AppNavBar from '../components/AppNavBar.vue'
import InputRow from '../components/InputRow.vue'
import ErrorModal from '../components/ErrorModal.vue'
import AppCard from '../components/AppCard.vue'
import AppButton from '../components/AppButton.vue'
import ChoiceButton from '../components/ChoiceButton.vue'
import LanguagePicker from '../components/LanguagePicker.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { isOfflineError } from '../lib/offlineQueue'
import { UserFacingError, userMessage } from '../lib/errorMessages'
import { isValidInviteCode, normalizeInviteCode, randomInviteCode } from '../lib/inviteCode'
import { LIST_MEMBERSHIP_CAP, LIST_NAME_MAX_LENGTH } from '../lib/limits'
import { getLocale, setLocale, t, tAccent, type Locale } from '../lib/i18n'
import { hasUserLocale } from '../lib/locale'
import { track } from '../lib/analytics'

const { userId } = useAuth()
const { user } = useUser()
const router = useRouter()
const route = useRoute()
const db = useSupabase()

// Reached from the account dialog's "join or create" action while the user already has lists
// (vs. a brand-new user with none): offer a way back to their list.
const isAddingList = computed(() => route.query.add === '1')

// Owning is capped at one list (003_lists_and_members.sql). Someone adding a list while
// they already own one can only join, so the create option is hidden. A brand-new
// user (not adding) always sees it.
const ownsList = ref(false)
// Only known after the async check below. Until then, in add mode we don't yet
// know whether create is allowed, so we withhold the create option rather than
// flash it and yank it away for an owner.
const ownershipChecked = ref(false)
const showCreate = computed(() => !isAddingList.value || (ownershipChecked.value && !ownsList.value))
onMounted(async () => {
  if (!isAddingList.value || !userId.value) return

  try {
    const { data } = await db
      .from('lists')
      .select('id')
      .eq('created_by', userId.value)
      .limit(1)
      .maybeSingle()
    ownsList.value = !!data
  } finally {
    ownershipChecked.value = true
  }
})

// The language step, ahead of the welcome hero.
//
// A warm English welcome is the wrong first thing to show someone whose phone
// has been Romanian all along, and this is the one screen where changing it
// costs nothing. Someone adding a second list from the account dialog
// already answered this, so they skip it — checked in both the seed below and
// the computed, deliberately, because re-asking there would be the obvious bug.
//
// "Already chosen" is the scoped key EXISTING, not the locale differing from
// English: English is a real answer somebody gave, and treating it as "not yet
// asked" would re-ask every English speaker on every fresh install.
const languageChosen = ref(true)
const showLanguage = computed(() => !languageChosen.value && !isAddingList.value)
// Whatever the boot resolver landed on — the device's own language if this is
// a fresh device, or a hint left by a previous account. Either way it is
// where the grid starts highlighted; see LanguagePicker for why that is not
// the same thing as a "suggestion".
const currentLocale = computed(() => getLocale())
const languageTitle = computed(() => tAccent('setup.language.title'))

// Starts hidden and only appears once there is an account to have an opinion
// about, for the same reason ownershipChecked withholds the create option:
// flashing a question and pulling it away is worse than a beat of nothing.
watch(
  userId,
  (uid) => {
    if (isAddingList.value) {
      languageChosen.value = true
      return
    }
    if (!uid) return
    languageChosen.value = hasUserLocale(localStorage, uid)
  },
  { immediate: true },
)

async function chooseLanguage(next: Locale) {
  // Fired only on Confirm, never on a tap alone — LanguagePicker previews the
  // tap internally and holds off emitting until the user commits. So by the
  // time this runs, swapping the catalog and revealing the welcome hero are
  // both landing exactly where the user meant them to.
  await setLocale(next, localStorage, userId.value ?? '')
  languageChosen.value = true
}

// Brand-new users open on a warm welcome before the create/join picker; someone
// adding a list from the account dialog already knows the app, so they skip it.
const welcomed = ref(false)
const showWelcome = computed(
  () => !welcomed.value && !isAddingList.value && languageChosen.value,
)
const welcomeTitle = computed(() => tAccent('setup.welcome.title'))
const pickerTitle = computed(() =>
  tAccent(isAddingList.value ? 'setup.picker.titleAdd' : 'setup.picker.titleNew'),
)

const mode = ref<'create' | 'join' | null>(null)

// The way back lives in the topbar, in the logo's slot, rather than inside the
// card -- so every step that has somewhere to go back to says so in the same
// place, and the card starts at its heading. Which step it is decides where it
// leads: out of a form is back to the picker, out of the picker is back to the
// list you came from. The language and welcome steps are a brand-new user's
// first two screens and have nothing behind them.
const canGoBack = computed(
  () => !showLanguage.value && !showWelcome.value && (!!mode.value || isAddingList.value),
)

function goBack() {
  if (mode.value) {
    mode.value = null
    error.value = ''
    return
  }
  router.replace('/')
}
const listName = ref('')
const inviteCode = ref('')
const error = ref('')
const loading = ref(false)
const listNameLength = computed(() => listName.value.length)
const listNameOverLimit = computed(() => listNameLength.value > LIST_NAME_MAX_LENGTH)
const limitModal = ref({ open: false, title: '', message: '' })

function openLimitModal(message: string) {
  limitModal.value = {
    open: true,
    title: t('error.nameTooLongTitle'),
    message,
  }
}

function closeLimitModal() {
  limitModal.value = { open: false, title: '', message: '' }
}

async function createList() {
  if (loading.value) return
  const uid = userId.value
  if (!uid) return
  // On the untrimmed value, matching the counter the field shows. Trimming can
  // only shorten, so a name that passes here cannot re-fail after the trim.
  if (listNameOverLimit.value) {
    openLimitModal(t('error.listNameTooLong', { max: LIST_NAME_MAX_LENGTH }))
    return
  }
  const nextListName = listName.value.trim()
  if (!nextListName) return
  error.value = ''
  loading.value = true
  try {
    const code = randomInviteCode()
    const { display_name, image_url } = deriveProfileFields(user.value)

    // One server-side step, exactly like the join path below: the profile (which
    // the membership references), the list and the membership are one
    // transaction, so a rejected membership takes the list row back with it.
    //
    // This used to be three client writes with a compensating delete if the last
    // one failed. When that delete failed too — it is a network call like any
    // other — the leftover list permanently occupied the account's one
    // ownership slot (lists_one_per_owner) while being invisible to every
    // list in the app, which are all built from list_members. There was no
    // way back from it without SQL.
    const { data: list, error: createErr } = await db
      .rpc('create_list', {
        p_name: nextListName,
        p_invite_code: code,
        p_display_name: display_name,
        p_image_url: image_url ?? undefined,
      })
      .maybeSingle<{ id: string; name: string }>()

    if (createErr) {
      // A user may own only one list (003_lists_and_members.sql). The
      // unique index rejects a second with a 23505; turn that one case into a
      // message that explains it rather than leaking the raw constraint text.
      if (createErr.message?.includes('lists_one_per_owner')) {
        throw new UserFacingError(t('error.ownOneList'))
      }
      // The sentinels are raised as the exception DETAIL, which supabase-js
      // exposes on error.details, not error.message.
      const detail = createErr.details ?? createErr.message ?? ''
      if (detail.includes('membership_limit_exceeded')) {
        throw new UserFacingError(
          t('error.membershipCapCreate', { cap: LIST_MEMBERSHIP_CAP }),
        )
      }
      if (detail.includes('list_name_invalid')) {
        throw new UserFacingError(
          t('error.listNameTooLong', { max: LIST_NAME_MAX_LENGTH }),
        )
      }
      throw createErr
    }
    // The function returns no row only for an unauthenticated caller, which the
    // uid check above has already ruled out. Treated as a plain failure rather
    // than dereferenced.
    if (!list) throw new UserFacingError(t('error.createListFailed'))
    track('list_created')

    // Make the new list the active one so HomeView opens straight to it.
    saveActiveListId(localStorage, uid, list.id)
    router.replace('/')
  } catch (e) {
    error.value = isOfflineError(e)
      ? t('error.offline')
      : userMessage(e, t('error.createListFailed'))
  } finally {
    loading.value = false
  }
}

async function joinList() {
  if (loading.value || !inviteCode.value.trim()) return
  const uid = userId.value
  if (!uid) return
  error.value = ''
  loading.value = true
  try {
    const code = normalizeInviteCode(inviteCode.value)
    if (!isValidInviteCode(code)) {
      error.value = t('error.inviteCodeInvalid')
      return
    }
    const { display_name, image_url } = deriveProfileFields(user.value)

    // The RPC checks the code, upserts the joiner's profile, and inserts the
    // membership in one server-side step; a direct list_members insert would
    // be rejected by RLS, so the code is a real credential (rotating it locks
    // out removed members).
    const { data: list, error: joinErr } = await db
      .rpc('join_list_with_code', {
        p_code: code,
        p_display_name: display_name,
        p_image_url: image_url ?? undefined,
      })
      .maybeSingle<{ id: string; name: string }>()

    if (joinErr) {
      // The sentinel is raised as the exception DETAIL (error.details), not message.
      if ((joinErr.details ?? joinErr.message ?? '').includes('membership_limit_exceeded')) {
        error.value = t('error.membershipCapJoin', { cap: LIST_MEMBERSHIP_CAP })
        return
      }
      throw joinErr
    }
    if (!list) {
      error.value = t('error.noListForCode')
      return
    }
    track('list_joined')

    // Make the joined list the active one so HomeView opens straight to it.
    saveActiveListId(localStorage, uid, list.id)
    router.replace('/')
  } catch (e) {
    error.value = isOfflineError(e)
      ? t('error.offline')
      : userMessage(e, t('error.joinListFailed'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="setup-page">
    <!-- Top bar -->
    <AppNavBar :back="canGoBack" @back="goBack" />

    <!-- Content -->
    <main class="setup-main">
      <AppCard>

        <!-- Language (brand-new users only, before anything else) -->
        <template v-if="showLanguage">
          <div class="card-header">
            <p class="card-eyebrow">{{ t('setup.language.eyebrow') }}</p>
            <h2 class="heading">{{ languageTitle[0]
              }}<span class="heading--accent">{{ languageTitle[1] }}</span>{{ languageTitle[2] }}</h2>
            <p class="sub">{{ t('setup.language.sub') }}</p>
          </div>
          <LanguagePicker :current="currentLocale" @confirm="chooseLanguage" />
        </template>

        <!-- Welcome (brand-new users only) -->
        <template v-else-if="showWelcome">
          <!-- A shared list caught mid-use: three items, three different people,
               one of them just done. Real names rather than grey bars, because a
               row of placeholder bars is the visual language of content that
               failed to load, and this is the first thing a new user ever sees.
               The finished row plays once on arrival and then rests. Looping it
               meant a completed item repeatedly un-completing itself, which reads
               as a glitch rather than as the live update it is meant to show. -->
          <!-- eslint-disable vue/no-bare-strings-in-template -- decorative emoji;
           the block is aria-hidden and the words beside them come from t() -->
          <div class="welcome-hero" aria-hidden="true">
            <ul class="wl-card">
              <li class="wl-row">
                <span class="wl-emoji">🥑</span>
                <span class="wl-name">{{ t('setup.hero.avocado') }}</span>
                <span class="wl-who wl-who--a">🧑</span>
              </li>
              <li class="wl-row wl-row--done">
                <span class="wl-emoji">🥛</span>
                <span class="wl-name">{{ t('setup.hero.milk') }}</span>
                <span class="wl-who wl-who--b">👩</span>
              </li>
              <li class="wl-row">
                <span class="wl-emoji">🍞</span>
                <span class="wl-name">{{ t('setup.hero.bread') }}</span>
                <span class="wl-who wl-who--c">🧒</span>
              </li>
            </ul>
          </div>
          <!-- eslint-enable vue/no-bare-strings-in-template -->
          <div class="card-header card-header--welcome">
            <p class="card-eyebrow">{{ t('setup.welcome.eyebrow') }}</p>
            <h2 class="heading">{{ welcomeTitle[0]
              }}<span class="heading--accent">{{ welcomeTitle[1] }}</span>{{ welcomeTitle[2] }}</h2>
            <p class="sub">{{ t('setup.welcome.sub') }}</p>
          </div>
          <AppButton variant="primary" block @click="welcomed = true">{{ t('setup.welcome.cta') }}</AppButton>
        </template>

        <!-- Picker -->
        <template v-else-if="!mode">
          <div class="card-header">
            <p class="card-eyebrow">{{ t(isAddingList ? 'setup.picker.eyebrowAdd' : 'setup.picker.eyebrowNew') }}</p>
            <h2 class="heading">{{ pickerTitle[0]
              }}<span class="heading--accent">{{ pickerTitle[1] }}</span>{{ pickerTitle[2] }}</h2>
            <!-- Three whole sentences rather than a stem with a clause appended.
                 The English original concatenated ', or create a new one.' onto
                 the end, which only reads correctly in a language that puts the
                 clause there. -->
            <p class="sub">
              {{ isAddingList
                ? (showCreate ? t('setup.picker.subAddOrCreate') : t('setup.picker.subAdd'))
                : t('setup.picker.subNew') }}
            </p>
          </div>
          <div class="choice-row">
            <ChoiceButton
              v-if="showCreate"
              icon="📝"
              :label="t('setup.picker.createLabel')"
              :description="t('setup.picker.createDescription')"
              @click="mode = 'create'"
            />
            <ChoiceButton
              icon="🔗"
              :label="t('setup.picker.joinLabel')"
              :description="t('setup.picker.joinDescription')"
              @click="mode = 'join'"
            />
          </div>
        </template>

        <!-- Create form -->
        <template v-else-if="mode === 'create'">
          <div class="card-header">
            <p class="card-eyebrow">{{ t('setup.create.eyebrow') }}</p>
            <h2 class="heading">{{ t('setup.create.title') }}</h2>
            <p class="sub">{{ t('setup.create.sub') }}</p>
          </div>
          <form @submit.prevent="createList" class="input-form">
            <InputRow v-model="listName" :aria-label="t('setup.create.nameLabel')" :placeholder="t('setup.create.namePlaceholder')" :loading="loading" required autofocus />
            <p class="field-counter" :class="{ 'field-counter--danger': listNameOverLimit }">
              {{ listNameLength }}/{{ LIST_NAME_MAX_LENGTH }}
            </p>          </form>
        </template>

        <!-- Join form -->
        <template v-else-if="mode === 'join'">
          <div class="card-header">
            <p class="card-eyebrow">{{ t('setup.join.eyebrow') }}</p>
            <h2 class="heading">{{ t('setup.join.title') }}</h2>
            <p class="sub">{{ t('setup.join.sub') }}</p>
          </div>
          <form @submit.prevent="joinList" class="input-form">
            <InputRow v-model="inviteCode" :aria-label="t('setup.join.codeLabel')" :placeholder="t('setup.join.codePlaceholder')" maxlength="8" :loading="loading" :uppercase="true" required autofocus />          </form>
        </template>

      </AppCard>
    </main>

    <ConfirmModal
      :open="limitModal.open"
      :title="limitModal.title"
      :message="limitModal.message"
      :danger="true"
      :confirm-text="t('common.ok')"
      :show-cancel="false"
      @confirm="closeLimitModal"
      @cancel="closeLimitModal"
    />

    <ErrorModal :message="error" @dismiss="error = ''" />
  </div>
</template>

<style scoped>
/* ── Layout ─────────────────────────────────────────────── */
.setup-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--color-primary-bg);
}

/* ── Main content ────────────────────────────────────────── */
.setup-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  padding-top: calc(56px + 2rem + var(--safe-top));
  padding-bottom: calc(2rem + var(--safe-bottom));
}

/* ── Welcome hero ────────────────────────────────────────── */
/* The hero is the thesis: a shared list with one item already ticked off, and
   two people beside it — FamCart in a single glance. */
.welcome-hero {
  display: flex;
  justify-content: center;
  margin: var(--space-1) 0 var(--space-7);
}

/* The list itself, sitting on the card the way it sits on the app background.
   Fixed width rather than fluid: it is a picture of a list, and a picture that
   restretches with the viewport stops reading as one. */
.wl-card {
  width: 100%;
  max-width: 272px;
  margin: 0;
  padding: var(--space-2);
  list-style: none;
  background: var(--bg-main);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-2xl);
  box-shadow: var(--elevation-card);
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.wl-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--elevation-soft);
}

.wl-emoji {
  flex-shrink: 0;
  width: 1.9rem;
  height: 1.9rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-base);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
}

.wl-name {
  flex: 1;
  text-align: left;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

/* Who put it there. The real list resolves this avatar from the row's author,
   so three different faces is the least abstract way to say "shared". */
.wl-who {
  position: relative;
  flex-shrink: 0;
  width: 1.7rem;
  height: 1.7rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  border: var(--border-width-thin) solid var(--border-main);
}

.wl-who--a { background: color-mix(in srgb, var(--color-primary) 18%, var(--bg-surface)); }
.wl-who--b { background: color-mix(in srgb, var(--warning-bg) 70%, var(--bg-surface)); }
.wl-who--c { background: color-mix(in srgb, var(--danger-bg) 80%, var(--bg-surface)); }

/* ── The one finished row ────────────────────────────────────────────────────
   Exactly what the real list does to a checked row, and nothing invented on top:
   the row drops to opacity 0.55 and the name takes a line-through in the
   disabled colour. See ShoppingListItem, .item--checked.

   An earlier attempt drew its own rule as an absolutely positioned ::after
   spanning left:0 to right:0 of the name. The name is a flex:1 child, so that
   line ran the full width of the row — past the end of the word and on through
   the empty space beside it, which read as the row being sliced rather than the
   word being crossed out. line-through hugs the glyphs, which is the whole
   reason the app uses it.

   It cycles: checked, held, unchecked, held. Both directions are real — swiping
   a row right checks it and swiping again unchecks it — so neither half of the
   loop shows something the app cannot do. The strike fades rather than retracts,
   because a line withdrawing along its own length reads as a redraw glitch where
   a fade reads as state leaving. The row stays visible throughout.

   The two keyframes share a duration and start together, which is what keeps the
   strike and the dimming in step. */
.wl-row--done {
  animation: wl-cycle 7s var(--ease-rise) infinite;
}

.wl-row--done .wl-name {
  text-decoration: line-through;
  /* Animatable, unlike the text-decoration shorthand. Transparent until the
     strike is drawn, so it arrives rather than being there all along. */
  text-decoration-color: transparent;
  animation: wl-cross 7s var(--ease-rise) infinite;
}

@keyframes wl-cycle {
  0%, 12% { opacity: 1; }
  22%, 70% { opacity: 0.55; }
  80%, 100% { opacity: 1; }
}

@keyframes wl-cross {
  0%, 12% {
    color: var(--text-primary);
    text-decoration-color: transparent;
  }
  22%, 70% {
    color: var(--text-disabled);
    text-decoration-color: var(--text-disabled);
  }
  80%, 100% {
    color: var(--text-primary);
    text-decoration-color: transparent;
  }
}

/* Asked for stillness, the row is simply already done. Same picture, no motion. */
@media (prefers-reduced-motion: reduce) {
  .wl-row--done {
    animation: none;
    opacity: 0.55;
  }
  .wl-row--done .wl-name {
    animation: none;
    color: var(--text-disabled);
    text-decoration-color: var(--text-disabled);
  }
}

.card-header--welcome {
  text-align: center;
  margin-bottom: 1.5rem;
}

/* ── Card header ─────────────────────────────────────────── */
.card-header {
  margin-bottom: 1.75rem;
}

.card-eyebrow {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-primary);
  margin: 0 0 1.5rem;
}

.heading {
  font-family: inherit;
  font-size: var(--text-xl);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  margin: 0 0 0.5rem;
  line-height: 1.2;
}

.heading--accent {
  color: var(--color-primary);
}

.sub {
  font-size: var(--text-base);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.55;
}

/* ── Back to lists ────────────────────────────────────── */
/* ── Choice list ─────────────────────────────────────────── */
.choice-row {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

/* ── Input form ──────────────────────────────────────────── */
.input-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-bottom: 0.875rem;
}

.field-counter {
  margin: -0.15rem 0 0;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

.field-counter--danger {
  color: var(--danger-main);
  font-weight: var(--weight-bold);
}
</style>
