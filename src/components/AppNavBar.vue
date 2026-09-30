<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { setStatusBarOnBrand } from '../lib/theme'
import { useClerk, useUser } from '@clerk/vue'
import AccountActionModal from './AccountActionModal.vue'
import ConfirmModal from './ConfirmModal.vue'
import AppIcon from './AppIcon.vue'
import BackButton from './BackButton.vue'
import ListSheet from './ListSheet.vue'
import MemberAvatarStack from './MemberAvatarStack.vue'
import SkeletonBlock from './SkeletonBlock.vue'
import { sortMembersSelfFirst } from '../lib/memberRoles'
import type { ListMemberProfile } from '../lib/listRealtime'
import ListIcon from './ListIcon.vue'
import { ITEM_LIMIT_DEFAULT } from '../lib/limits'
import { getUserDisplayName, getUserInitial, getUserPrimaryEmail, initialOf } from '../lib/userIdentity'
import { useSignOut } from '../lib/useSignOut'
import { useConfirm } from '../lib/useConfirm'
import { shareInvite } from '../lib/inviteShare'
import { track } from '../lib/analytics'
import type { ProductSuggestion } from '../lib/productSearch'

// The settings modal is by far the heaviest part of the topbar; load its chunk
// only when someone actually opens it.
//
// The loaders are named rather than inlined so the press handlers below can call
// them directly. Fetching the chunk at click time meant the first tap on either
// of these opened nothing at all until the request came back -- the button had
// been pressed, the dialog was mounted with open:true, and the screen sat there.
// Starting on pointerdown buys the whole press-and-release, and on a phone that
// is most of the round trip.
const loadListSettingsModal = () => import('./ListSettingsModal.vue')
const ListSettingsModal = defineAsyncComponent(loadListSettingsModal)
// Same treatment for the purchase-history modal: fetched and rendered on demand.
const loadPurchaseHistoryModal = () => import('./PurchaseHistoryModal.vue')
const PurchaseHistoryModal = defineAsyncComponent(loadPurchaseHistoryModal)
// Reporting is rare and its chunk pulls in the report library, so it stays out
// of the initial download like the two above.
const ReportIssueModal = defineAsyncComponent(() => import('./ReportIssueModal.vue'))

// Warm a modal's chunk ahead of the click. The bundler dedupes the dynamic
// import, so the real open reuses this request instead of starting a second one.
// Rejections are swallowed: a prefetch that fails must not surface as an
// unhandled rejection, and the open path re-runs the import and reports properly.
function prefetch(load: () => Promise<unknown>) {
  void load().catch(() => {})
}
// App settings loads on demand like the others (lib/theme applies the theme on
// boot), warmed when the account menu that leads to it opens.
const loadAppSettingsModal = () => import('./AppSettingsModal.vue')
const AppSettingsModal = defineAsyncComponent(loadAppSettingsModal)
import { t, tn } from '../lib/i18n'
import { IS_NIGHTLY } from '../lib/appChannel'

const props = defineProps({
  // Which screen this header is on.
  //
  // 'bar' is the list screen: the list, what is left, history and you.
  // 'header' is ListSetupView, which has no list yet, so it gets the
  // logo (or a way back) and the account button and nothing else.
  //
  // One header at every width, meaning the same thing on a phone and a desktop.
  layout: { type: String as PropType<'bar' | 'header'>, default: 'header' },
  // Whether the header's left slot is a way back rather than the brand mark.
  // Only the 'header' shell has that slot, and only a screen with a step behind
  // it asks for this -- see ListSetupView, which is every screen that draws
  // the logo today.
  back: { type: Boolean, default: false },
  listId: { type: String, default: '' },
  listName: { type: String, default: '' },
  // Every list the user belongs to ({ id, name }); the account dialog lists
  // them so you can move between them.
  lists: {
    type: Array as PropType<{ id: string; name: string; emoji?: string | null }[]>,
    default: () => [],
  },
  loading: { type: Boolean, default: false },
  // Rows on the list, and how many of them are in the cart, for the progress
  // bar under the list name.
  totalCount: { type: Number, default: 0 },
  checkedCount: { type: Number, default: 0 },
  // The same, in units: what the bar fills by. "Eggs x10" is ten of the
  // things to pick up, and a trip that has the eggs but not the bread is much
  // further along than one row of two. The words above the bar stay in rows,
  // because they say how many things are still to find.
  totalUnits: { type: Number, default: 0 },
  checkedUnits: { type: Number, default: 0 },
  // True mid list-switch: the name is already known but the roster is
  // not, so the faces show a skeleton rather than the previous list's.
  membersLoading: { type: Boolean, default: false },
  // 'offline' or 'reconnecting' puts a small pill in the header; empty says
  // nothing, which is the normal state.
  syncState: { type: String as PropType<'offline' | 'reconnecting' | ''>, default: '' },
  inviteCode: { type: String, default: '' },
  listItemLimit: { type: Number, default: ITEM_LIMIT_DEFAULT },
  listEmoji: { type: String, default: '' },
  ownerUserId: { type: String, default: '' },
  currentUserId: { type: String, default: '' },
  memberProfiles: {
    type: Array as PropType<ListMemberProfile[]>,
    default: () => [],
  },
})

const emit = defineEmits<{
  'refresh-list': []
  'list-deleted': []
  'list-left': []
  'switch-list': [id: string]
  'add-list': []
  // The bar's centre button. The search belongs to AddItemForm and its open
  // state is HomeView's, so the bar only says it was pressed.
  add: []
  // "Add again" in history: the add is HomeView's, like every other add.
  'add-product': [product: ProductSuggestion]
  // The back control above `back` draws. Where it leads is the parent's, because
  // only the parent knows which step it is on.
  back: []
}>()

// On the list the header is brand green and runs up behind the status bar, so
// the clock and battery need light icons while it is on screen. Given back on
// the way out so every other screen follows the theme again. The setup screen
// draws this header plain, so it asks for nothing.
onMounted(() => {
  if (props.layout === 'bar') setStatusBarOnBrand(true)
})
onBeforeUnmount(() => {
  if (props.layout === 'bar') setStatusBarOnBrand(false)
})

const clerk = useClerk()
const { user } = useUser()

const accountMenuOpen = ref(false)

// The list sheet: members, invite, and which list you are on. It is
// what the list name opens, on every width.
const listSheetOpen = ref(false)

function openListSheet() {
  prefetch(loadListSettingsModal)
  listSheetOpen.value = true
}

// Closes the sheet itself; the switch is the parent's to perform, because it
// owns which list is active and everything that has to be refetched with
// it. The sheet has already dropped a pick of the list you are on.
function switchList(id: string) {
  listSheetOpen.value = false
  emit('switch-list', id)
}

function addList() {
  listSheetOpen.value = false
  emit('add-list')
}

const settingsOpen = ref(false)
// Stays true after the first open so the async chunk keeps its close transition.
const settingsEverOpened = ref(false)

const appSettingsOpen = ref(false)
const appSettingsEverOpened = ref(false)

const historyOpen = ref(false)
const historyEverOpened = ref(false)

const reportOpen = ref(false)
const reportEverOpened = ref(false)

function openAppSettings() {
  accountMenuOpen.value = false
  appSettingsEverOpened.value = true
  appSettingsOpen.value = true
}

function openHistory() {
  historyEverOpened.value = true
  historyOpen.value = true
}

function openAccountMenu() {
  prefetch(loadAppSettingsModal)
  accountMenuOpen.value = true
}

function openAccountSettings() {
  accountMenuOpen.value = false
  clerk.value?.openUserProfile()
}

function openReportIssue() {
  accountMenuOpen.value = false
  reportEverOpened.value = true
  reportOpen.value = true
}

// One door: "Manage list" in the list sheet.
function openListSettings() {
  listSheetOpen.value = false
  settingsEverOpened.value = true
  settingsOpen.value = true
}

// Hands the invite to whatever the device sends things with: the share sheet on
// a phone, the clipboard on a desktop. See lib/inviteShare for why that is three
// paths rather than one.
//
// Not awaited before the call — the web share sheet only opens inside the user
// activation from the tap, and an await here would spend it.
function inviteMembers() {
  if (!props.inviteCode) {
    // No code to send yet. The overview panel is where one is minted, so that is
    // where this has to end up.
    openListSettings()
    return
  }

  void shareInvite(props.listName, props.inviteCode).then((outcome) => {
    // Backing out of the sheet is an answer, not a failure: stay exactly where
    // they were so a second try is one tap away.
    if (outcome === 'cancelled') return
    if (outcome !== 'unavailable') track('invite_sent')
    if (outcome === 'unavailable') {
      openListSettings()
      return
    }
    listSheetOpen.value = false
  })
}

// Signing out is four subsystems torn down in a fixed order, and none of that
// is a navigation shell's business — see lib/useSignOut, which owns the order
// and the reasons for it. What stays here is the one thing that IS this
// component's: closing the menu the press came from.
const { signingOut, signOut: handleSignOut } = useSignOut({
  userId: () => props.currentUserId,
  onSignedOut: () => {
    accountMenuOpen.value = false
  },
})

// Asked first, like every other action that is hard to take back: the row sits
// where the account menu opens, so one stray tap would sign someone out
// mid-shop, and signing back in takes an emailed code.
const { state: signOutConfirm, confirm, resolveWith } = useConfirm()
async function confirmSignOut() {
  const sure = await confirm({
    title: t('account.confirmSignOutTitle'),
    message: t('account.confirmSignOutMessage'),
    confirmText: t('account.signOut'),
    danger: true,
  })
  if (sure) await handleSignOut()
}

// Offline (cold-booted from cache) Clerk can't load, so `user` is null. The
// cached list roster still holds this user's profile, so fall back to it for
// the account button and menu rather than showing an empty "Account".
const cachedProfile = computed(() =>
  props.currentUserId
    ? props.memberProfiles.find((m) => m.user_id === props.currentUserId) || null
    : null,
)

const userAvatarUrl = computed(() => user.value?.imageUrl || cachedProfile.value?.image_url || '')
const userDisplayName = computed(
  () => getUserDisplayName(user.value) || cachedProfile.value?.display_name || t('account.fallbackName'),
)
const userEmail = computed(() => getUserPrimaryEmail(user.value))
const userInitial = computed(() => {
  const clerkInitial = user.value ? getUserInitial(user.value) : ''
  if (clerkInitial && clerkInitial !== '?') return clerkInitial
  return initialOf(cachedProfile.value?.display_name)
})

// The emoji the owner picked for this list. It already identifies each row
// inside the panel; showing it on the bar too means the thing you tap and the
// row you land on are the same object, and gives the left-hand block a fixed
// anchor to start from instead of beginning with ragged text.

// Whether the bottom bar is on screen, which decides whether the list
// name has to be a way in. Followed live, so a window resized across the
// desktop boundary gets the right one.
const DESKTOP_QUERY = '(min-width: 900px)'
const desktopMedia =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DESKTOP_QUERY)
    : null
const isDesktop = ref(desktopMedia?.matches ?? false)
const onDesktopChange = (event: MediaQueryListEvent) => {
  isDesktop.value = event.matches
}
onMounted(() => desktopMedia?.addEventListener?.('change', onDesktopChange))
onBeforeUnmount(() => desktopMedia?.removeEventListener?.('change', onDesktopChange))

const nameOpensSheet = computed(() => props.layout !== 'bar' || isDesktop.value)

const progressPercent = computed(() =>
  props.totalUnits > 0 ? Math.round((props.checkedUnits / props.totalUnits) * 100) : 0,
)
const progressDone = computed(() => props.totalCount > 0 && props.checkedCount >= props.totalCount)
const progressLabel = computed(() =>
  progressDone.value
    ? t('list.meta.allPicked')
    : tn('list.meta.itemCount', props.totalCount - props.checkedCount),
)

// Bumped when the cart grows, never when it shrinks: the shine means "one more
// in", and playing it for an untick or a checkout would say the opposite.
const shineKey = ref(0)
watch(
  () => props.checkedUnits,
  (next, previous) => {
    if (next > previous) shineKey.value++
  },
)

// The active list's members, ordered for the stack that sits under the name.
const orderedActiveMembers = computed(() =>
  sortMembersSelfFirst(props.memberProfiles || [], props.ownerUserId, props.currentUserId),
)
</script>

<template>
  <!-- The phone's action bar: List, History, Add, Switch, You. Hidden
       from the desktop column up, where the header carries history and the
       account and AddItemForm is an inline field. Switch opens the list
       sheet (members, invite, switching); List goes straight to its
       settings, as it always did. -->
  <nav v-if="layout === 'bar'" class="navbar" :aria-label="t('nav.label')">
    <!-- Every slot here carries an aria-label, for the same reason the centre
         disc does: the visible labels are single words because they sit under a
         24px mark in six languages, and a single word is not always a name. The
         list's is the one that matters most — the emoji that says WHICH
         list is decorative, so without this a screen reader gets
         "List" for each of the three you might belong to. -->
    <button
      class="nav-slot"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="settingsOpen"
      :aria-label="
        listName ? t('topbar.listSettings', { name: listName }) : t('nav.list')
      "
      @pointerdown="prefetch(loadListSettingsModal)"
      @click="openListSettings"
    >
      <span class="nav-slot__mark nav-slot__mark--emoji" aria-hidden="true">
        <ListIcon :value="listEmoji" />
      </span>
      <span class="nav-slot__label">{{ t('nav.list') }}</span>
    </button>

    <button
      class="nav-slot"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="historyOpen"
      :aria-label="t('topbar.history')"
      @pointerdown="prefetch(loadPurchaseHistoryModal)"
      @click="openHistory"
    >
      <span class="nav-slot__mark">
        <AppIcon name="history-bold" />
      </span>
      <span class="nav-slot__label">{{ t('nav.history') }}</span>
    </button>

    <!-- The disc stays inside the bar's top edge. A notched, protruding FAB is
         the default here and it would have collided with the checkout slider,
         which is the one thing on this screen with a stronger claim to the
         bottom edge. A solid green knob riding a neutral track is already this
         app's vocabulary — see .buy-bar__thumb — so the bar borrows from the
         slider rather than from Material.

         aria-label carries the full sentence; the visible label is only the
         verb, because it has to fit under a 44px disc in six languages. -->
    <button
      class="nav-slot nav-slot--add"
      type="button"
      :aria-label="t('nav.addLabel')"
      @click="emit('add')"
    >
      <span class="nav-add__disc" aria-hidden="true">
        <AppIcon name="add" />
      </span>
      <span class="nav-slot__label">{{ t('nav.add') }}</span>
    </button>

    <!-- Which list you are looking at. Drawn even for the account
         that has one, which is most of them: with nothing to switch to the menu
         is still the way to a second list, and a slot that comes and goes
         is a bar that changes shape under you.

         "Switch", not "Lists": the first slot is already "List" and
         the two would read as the same word. -->
    <button
      class="nav-slot"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="listSheetOpen"
      :aria-label="t('nav.switchLabel')"
      @click="openListSheet"
    >
      <span class="nav-slot__mark">
        <AppIcon name="menu-bold" />
      </span>
      <span class="nav-slot__label">{{ t('nav.switch') }}</span>
    </button>

    <button
      class="nav-slot"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="accountMenuOpen"
      :aria-label="t('topbar.account')"
      @click="openAccountMenu"
    >
      <!-- aria-hidden, unlike the topbar's copy of this, because there the
           button's own aria-label overrode the img's alt and here the two would
           be concatenated: "Your avatar You" with a photo and "You" without, so
           the same control announced differently depending on whether somebody
           had uploaded one. The label above is the name; this is decoration. -->
      <span class="nav-slot__mark nav-slot__mark--avatar" aria-hidden="true">
        <img
          v-if="userAvatarUrl"
          :src="userAvatarUrl"
          alt=""
          class="nav-avatar-img"
        />
        <span v-else class="nav-avatar-fallback" aria-hidden="true">{{ userInitial }}</span>
      </span>
      <span class="nav-slot__label">{{ t('nav.you') }}</span>
    </button>
  </nav>

  <header class="topbar" :class="{ 'topbar--list': layout === 'bar' }">
    <div class="topbar-left">
      <template v-if="listName">
        <!-- Which list this is, who is in it, and how far this
             trip has got. On a phone it is only that: the bottom bar's
             List and Switch are the ways in, so the block is a label, not
             a third door. Where there is no bar (the desktop column, and the
             setup screen) it opens the list sheet, since nothing else
             would. One element either way, so the two cannot drift apart. -->
        <component
          :is="nameOpensSheet ? 'button' : 'div'"
          class="list-btn"
          :class="{ 'list-btn--static': !nameOpensSheet }"
          v-bind="
            nameOpensSheet
              ? {
                  type: 'button',
                  'aria-haspopup': 'dialog',
                  'aria-expanded': listSheetOpen,
                  'aria-label': t('list.open', { name: listName }),
                }
              : {}
          "
          @click="nameOpensSheet && openListSheet()"
        >
          <span class="list-emoji" aria-hidden="true"><ListIcon :value="listEmoji" /></span>
          <div class="list-info">
            <p class="list-name">
              <span class="list-name__text">{{ listName }}</span>
              <AppIcon v-if="nameOpensSheet" class="list-name__chevron" name="chevron-right" />
            </p>
            <div v-if="layout === 'bar'" class="list-subrow">
              <MemberAvatarStack :members="orderedActiveMembers" :loading="membersLoading" />
            </div>
          </div>
        </component>
      </template>
      <template v-else-if="loading">
        <!-- Stands in for the real block above, tile included: without the
             square the name and the faces would start at the left edge and then
             jump right by its width the moment the list lands. -->
        <div class="list-meta" aria-hidden="true">
          <SkeletonBlock class="list-emoji-skeleton" width="34px" height="34px" radius="var(--radius-md)" />
          <div class="list-info">
            <SkeletonBlock width="7.5rem" height="1rem" />
            <div v-if="layout === 'bar'" class="list-subrow">
              <MemberAvatarStack loading />
            </div>
          </div>
        </div>
      </template>
      <!-- The way back takes the logo's place instead of sitting inside the
           card below it. Both cannot have this corner, and between them only one
           is a control: the mark names an app you are already inside, while the
           left edge of the bar is where a phone puts the way out of a step. -->
      <BackButton v-else-if="back" class="topbar-back" @click="emit('back')" />
      <template v-else>
        <!-- eslint-disable-next-line vue/no-bare-strings-in-template -- brand name, the same in every language -->
        <img src="/icons/pwa-192.png" alt="Bagful" class="topbar-logo" />
      </template>
    </div>

    <div class="topbar-actions">
      <!-- How much of this trip is in the cart, on the header's right: a
           fixed-width block in the layout rather than one floated over the
           middle, so a long list name or a big list's faces can
           never run into it. The name ellipsizes first. Rows, like every
           count here. -->
      <div
        v-if="layout === 'bar' && listName && totalCount > 0"
        class="list-progress"
        :class="{ 'list-progress--done': progressDone }"
        role="progressbar"
        :aria-label="t('header.progressLabel')"
        :aria-valuenow="checkedUnits"
        aria-valuemin="0"
        :aria-valuemax="totalUnits"
      >
        <!-- What is left, centred over the bar that shows it going.
             The list's own header used to carry this count; one place
             for it is enough, and here it sits with the progress it
             describes. -->
        <span class="list-progress__label">{{ progressLabel }}</span>
        <span class="list-progress__track">
          <span class="list-progress__fill" :style="{ width: `${progressPercent}%` }">
            <!-- Re-keyed on every tick, so the shine replays each time
                 something goes into the cart: the bar answers the tap
                 even when the step is too small to see. -->
            <span v-if="shineKey" :key="shineKey" class="list-progress__shine"></span>
          </span>
        </span>
      </div>
      <!-- The nightly build says so, in the one place that is on screen whatever
           you are doing. Sits at the head of the actions rather than beside the
           list name, which ellipsizes and would have had to give up width
           for it. Untranslated on purpose, like the manifest: it names a build
           channel, not anything the app does. -->
      <!-- eslint-disable-next-line vue/no-bare-strings-in-template -- build channel, the same word in every language -->
      <span v-if="IS_NIGHTLY" class="channel-badge">NIGHTLY</span>

      <!-- Said once, in the header, rather than as an error: offline the app
           still works (writes wait and sync), so this is information about
           what is happening, not a problem to dismiss. -->
      <span v-if="syncState === 'offline'" class="sync-pill" role="status">
        <AppIcon class="sync-pill__icon" name="wifi-off" />
        {{ t('sync.offline') }}
      </span>
      <!-- Reconnecting is only a spinner: it fixes itself, usually within
           seconds, and a worded pill for that was more alarm than it was worth.
           The words stay for a screen reader. -->
      <span
        v-else-if="syncState === 'reconnecting'"
        class="sync-spinner"
        role="status"
        :aria-label="t('sync.reconnecting')"
      ></span>

      <button
        v-if="listName"
        class="topbar-icon-btn"
        type="button"
        :aria-label="t('topbar.history')"
        @pointerdown="prefetch(loadPurchaseHistoryModal)"
        @click="openHistory"
      >
        <span class="history-icon" aria-hidden="true"></span>
      </button>

      <button
        class="user-avatar-btn"
        type="button"
        :aria-label="t('topbar.account')"
        @click="openAccountMenu"
      >
        <img
          v-if="userAvatarUrl"
          :src="userAvatarUrl"
          :alt="t('topbar.avatarAlt')"
          class="user-avatar-img"
        />
        <span v-else class="user-avatar-fallback">{{ userInitial }}</span>
      </button>
    </div>
  </header>


  <PurchaseHistoryModal
    v-if="historyEverOpened"
    :open="historyOpen"
    :list-id="listId"
    :current-user-id="currentUserId"
    :member-profiles="memberProfiles"
    @close="historyOpen = false"
    @add-again="emit('add-product', $event)"
  />

  <ListSettingsModal
    v-if="settingsEverOpened"
    :open="settingsOpen"
    :list-id="listId"
    :list-name="listName"
    :invite-code="inviteCode"
    :list-item-limit="listItemLimit"
    :list-emoji="listEmoji"
    :owner-user-id="ownerUserId"
    :member-profiles="memberProfiles"
    @close="settingsOpen = false"
    @refresh-list="emit('refresh-list')"
    @list-deleted="emit('list-deleted')"
    @list-left="emit('list-left')"
  />

  <ListSheet
    :open="listSheetOpen"
    :lists="lists"
    :list-id="listId"
    :list-name="listName"
    :list-emoji="listEmoji"
    :members="orderedActiveMembers"
    :owner-user-id="ownerUserId"
    :current-user-id="currentUserId"
    @close="listSheetOpen = false"
    @switch-list="switchList"
    @add-list="addList"
    @invite="inviteMembers"
    @manage="openListSettings"
  />

  <AccountActionModal
    :open="accountMenuOpen"
    :loading-sign-out="signingOut"
    :avatar-url="userAvatarUrl"
    :display-name="userDisplayName"
    :email="userEmail"
    :initial="userInitial"
    @close="accountMenuOpen = false"
    @edit-account="openAccountSettings"
    @app-settings="openAppSettings"
    @report-issue="openReportIssue"
    @sign-out="confirmSignOut"
  />

  <ConfirmModal
    :open="signOutConfirm.open"
    :title="signOutConfirm.title"
    :message="signOutConfirm.message"
    :danger="signOutConfirm.danger"
    :confirm-text="signOutConfirm.confirmText"
    :cancel-text="signOutConfirm.cancelText"
    :show-cancel="signOutConfirm.showCancel"
    @confirm="resolveWith(true)"
    @cancel="resolveWith(false)"
  />

  <ReportIssueModal
    v-if="reportEverOpened"
    :open="reportOpen"
    :list-id="listId"
    :user-id="currentUserId"
    @close="reportOpen = false"
  />

  <AppSettingsModal
    v-if="appSettingsEverOpened"
    :open="appSettingsOpen"
    @close="appSettingsOpen = false"
  />
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* Always keep breathing room between the list name and the action buttons,
     so the name can never butt up against (or slide under) them. */
  gap: 0.75rem;
  /* The bar's surface extends up behind the phone's status bar; its content
     keeps a 64px strip below it (72px from the desktop column up). The height
     is --header-height, which the list pads itself by. */
  padding: var(--safe-top) 0.75rem 0 0.5rem;
  height: calc(var(--header-height) + var(--safe-top));
  /* Brand green, up behind the status bar (whose icons go light for it, see
     setStatusBarOnBrand). The one saturated band on the screen says which app
     and which list before anything is read. */
  background: var(--color-primary-strong);
  color: var(--color-on-strong);
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--z-header);
}

/* Green is the list's. Anywhere else this header is drawn (the setup screen)
   it is the page's own plain surface. Everything inside is coloured from the
   --color-on-strong family, so re-pointing those four here is the whole change:
   text goes dark, the washes go grey. */
.topbar:not(.topbar--list) {
  --color-on-strong: var(--text-primary);
  --color-on-strong-muted: var(--text-secondary);
  --color-on-strong-fill: var(--bg-hover);
  --color-on-strong-fill-strong: var(--bg-press);
  background: var(--bg-surface);
  border-bottom: var(--border-width-thin) solid var(--border-main);
}

/* Desktop: keep the bar full-width but align its content with the centered
   dashboard column, so the list name and buttons don't hug the far corners
   of a wide screen. 100% is the bar's own width, which matches the base the
   column is centered against. */
@media (min-width: 900px) {
  .topbar {
    padding-inline: max(1.25rem, calc((100% - var(--desktop-column)) / 2));
  }
}

/* ─── The bottom action bar ──────────────────────────────────────────────────
   Five equal cells and one baseline. Every slot is a bottom-aligned column, so
   the labels line up whatever sits above them: a 26px mark in four of them and
   a 44px disc in the fifth. That is the whole layout, and it is why the disc
   can be much bigger than the icons without needing a position of its own. */
.navbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-composer);
  display: flex;
  align-items: stretch;
  height: calc(var(--nav-height) + var(--safe-bottom));
  /* The surface runs down behind the phone's home bar, the way the topbar's
     runs up behind the status bar. */
  padding-bottom: var(--safe-bottom);
  background: var(--bg-surface);
  /* Above the list and just above the checkout slider's layer (39), whose
     fade runs underneath this bar. The slider itself sits clear of the bar, so
     it stays reachable. */
  /* A sheet resting on the bottom edge: rounded where it meets the list, and
     lifted off it by a shadow rather than a hairline, which would stop dead at
     the start of each curve. */
  border-radius: var(--radius-3xl) var(--radius-3xl) 0 0;
  box-shadow: 0 -4px 16px var(--shadow-ink-06);
  /* Load-bearing, and the default, which is exactly why it is written down: the
     centre disc is taller than the bar and hangs over its top edge. Clipping
     here would cut the primary action in half. */
  overflow: visible;
}

.nav-slot {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  /* Equal top and bottom, which is the whole of the bar's height calculation:
     a small slot's mark, gap and label come to 42px, and these two 8px bands
     are the rest of --nav-height. flex-end rather than center so the labels of
     all five slots share one baseline whatever sits above them -- which is what
     lets the disc be 44px in a 42px box without moving anything. */
  padding: 0.5rem 0.25rem;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--transition-fast), color var(--transition-fast),
    transform var(--transition-fast) var(--ease-rise);
}

.nav-slot__mark {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* AppIcon renders a bare <span> around the SVG and deliberately carries no
   styles of its own, so left alone that span is an inline box and the icon
   inside it sits on a text baseline. That put every mark in this bar a few
   pixels high with a descender's worth of dead space beneath it, which reads as
   the icons floating away from their labels. Both halves are needed: the span
   has to stop being a line box, and the SVG has to stop being inline content. */
.nav-slot__mark > span,
.nav-add__disc > span {
  display: flex;
}

/* The bold assets (history-bold, menu-bold) carry their own stroke-width of
   2, which is 1.67px at this size. There is deliberately no stroke-width here:
   the bar used to force the hairline weight of the old desktop history icon,
   and next to a filled disc, an emoji and a photo that read as the faintest
   thing on screen. Change the weight by changing the file. */
.nav-slot__mark :deep(svg) {
  display: block;
  width: 20px;
  height: 20px;
  opacity: 0.86;
}

/* The topbar lifted the same icon in dark mode, where a hairline against a dark
   surface has less to hold onto. It had to force white to do it, because a mask
   needs an explicit background-color; currentColor follows --text-secondary
   here, so only the opacity is left to carry it. */
:global(:root[data-theme='dark']) .nav-slot__mark :deep(svg) {
  opacity: 0.96;
}

.nav-slot__mark--emoji {
  font-size: var(--text-xl);
  line-height: 1;
}

/* The picture fills its square edge to edge, where an emoji glyph has air
   around it, so it is pinned a step inside the 26px slot rather than sized
   off the font. */
.nav-slot__mark--emoji :deep(.list-icon) {
  width: 24px;
  height: 24px;
}

.nav-slot__mark--avatar {
  border-radius: var(--radius-pill);
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--bg-hover);
  overflow: hidden;
}

.nav-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.nav-avatar-fallback {
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
}

.nav-slot__label {
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: 0;
  /* The centre slot asks for more height than it has, on purpose — that is the
     disc's overhang. Something has to absorb the difference, and a flex item
     gives way by default, so without this the label was the thing that gave:
     squeezed to zero height, and the word "Add" simply did not render. */
  flex-shrink: 0;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─── The centre disc ────────────────────────────────────────────────────────
   The only saturated thing along the bottom edge of the screen, and the only
   place in this bar where boldness is spent. Nothing else here is coloured. */
.nav-add__disc {
  width: 44px;
  height: 44px;
  /* Without this the column would shrink it to the 34px its slot has spare,
     since a flex item's default is to give way. The overhang IS the design. */
  flex-shrink: 0;
  border-radius: var(--radius-pill);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
  color: var(--text-inverse);
  box-shadow: var(--elevation-primary);
  transition: transform var(--transition-fast) var(--ease-rise),
    box-shadow var(--transition-fast);
}

/* The one mark in the bar that should be noticed, so it stays the heaviest:
   2.7px against the small slots' 1.67. add.svg ships at 3, which on a filled
   disc this size reads as a slab rather than a plus. */
.nav-add__disc :deep(svg) {
  display: block;
  width: 26px;
  height: 26px;
  stroke-width: 2.5;
}

.nav-slot--add .nav-slot__label {
  color: var(--color-primary);
}

/* ─── How the bar answers a press ────────────────────────────────────────────
   The same rule the header below uses, for the same two reasons written out
   there: the press is not transitioned on the way in, because easing into a
   pressed state is how a button comes to feel slower than the finger; and it
   moves to --bg-press, which is a real step away from the surface in both
   themes where --border-light was not.

   The fill is a pill behind the mark rather than the whole cell: a full-height
   rectangle lighting up under a thumb reads as the bar breaking into panels. */
.nav-slot:active {
  color: var(--text-primary);
  transform: scale(0.92);
  transition-duration: 0s;
}

.nav-slot:not(.nav-slot--add):active .nav-slot__mark {
  box-shadow: 0 0 0 8px var(--bg-press);
  border-radius: var(--radius-pill);
  transition-duration: 0s;
}

/* Less travel than the small slots: the same ratio that reads as a press on a
   26px mark reads as a lurch on a 44px disc. It recedes and its shadow tightens
   with it, so the disc settles toward the bar rather than just shrinking. */
.nav-slot--add:active {
  transform: none;
}

.nav-slot--add:active .nav-add__disc {
  transform: scale(0.94);
  box-shadow: var(--elevation-soft);
  transition-duration: 0s;
}

/* Colour only. There was a ring around the mark here too, matching the press
   state, and it was decoration nobody was ever going to see: a phone has no
   hover, and the bar is display:none at the desktop column, so the only place it
   could fire was a desktop window narrowed past 900px. The press ring stays --
   that one answers a real finger. */
@media (hover: hover) {
  .nav-slot:hover {
    color: var(--text-primary);
  }
}

/* Every one of these opens a dialog, and AppModal hands focus back to whatever
   opened it when it closes — so keyboard focus lands on a nav slot after every
   close, more often than on any other control in the app. The ring goes on the
   mark rather than the cell for the same reason the press fill does: a
   full-height rectangle lighting up reads as the bar breaking into panels.

   The disc is already a filled shape, so it takes the ring outside itself
   instead of inside a 26px circle that is not there. */
.nav-slot:focus-visible {
  outline: none;
}

.nav-slot:focus-visible .nav-slot__mark {
  border-radius: var(--radius-pill);
  box-shadow: var(--focus-ring-primary-soft);
}

.nav-slot--add:focus-visible .nav-add__disc {
  box-shadow: var(--elevation-primary), var(--focus-ring-primary-soft);
}

@media (prefers-reduced-motion: reduce) {
  .nav-slot:active,
  .nav-slot--add:active .nav-add__disc {
    transform: none;
  }
}

/* The bar is the phone shell. At the desktop column the header takes over, so
   this goes and the header stops hiding. */
@media (min-width: 900px) {
  .navbar {
    display: none;
  }
}

/* On a phone the list screen's history and account live in the bottom bar,
   so the header gives their width to the list name. */
@media (max-width: 899.98px) {
  .topbar--list .topbar-icon-btn,
  .topbar--list .user-avatar-btn {
    display: none;
  }
}

/* The build stamp belongs to the desktop header only: on a phone the header's
   width goes to the list name, and the About screen already says which
   build this is. */
@media (max-width: 899.98px) {
  .channel-badge {
    display: none;
  }
}

/* ─── How the bar answers a press ─────────────────────────────────────────────
   Every control up here summons something — a panel, a sheet, a dialog — so they
   all give way the same way: recede under the finger while the thing they called
   for comes forward. Same direction as the empty state's chips, which press in
   "rather than lifting" for the same reason.

   Two things about it are load-bearing, and both were what made this bar feel
   like it lagged behind the finger:

   1. The press is NOT transitioned. Easing INTO a pressed state is the classic
      way to build a button that feels slow — the finger is down and the pixels
      are still on their way. In instantly, out over --transition-fast.
   2. It has to be visible. The two controls that had an :active state painted
      --border-light, which in light mode is the same #f3f4f6 as --bg-hover and
      in dark is lighter than it, so a press either changed nothing or moved the
      wrong way. The other two had no :active at all — and the list block,
      the biggest target in the bar, also suppresses the tap highlight, so a tap
      on it changed nothing on screen at all until its dialog arrived. --bg-press is a real step in the right direction in both
      themes.

   Scale is inverse to size: the same ratio that reads as a press on a 40px
   circle reads as a lurch on a block the width of the screen. */
.list-btn:active,
.topbar-icon-btn:active,
.user-avatar-btn:active {
  background: var(--color-on-strong-fill-strong);
  transition-duration: 0s;
}

.topbar-icon-btn:active,
.user-avatar-btn:active {
  transform: scale(0.92);
}

.list-btn:active {
  transform: scale(0.97);
}

/* The tile holds its own against the pressed fill, same as on hover. */
.list-btn:active .list-emoji {
  background: var(--color-on-strong-fill-strong);
}

@media (prefers-reduced-motion: reduce) {
  .list-btn:active,
  .topbar-icon-btn:active,
  .user-avatar-btn:active {
    transform: none;
  }
}

.topbar-left {
  display: flex;
  flex: 1;
  align-items: center;
  /* min-width:0 lets this region shrink below its content width so the name can
     ellipsize; overflow:hidden guarantees nothing ever spills over the buttons,
     which paint on top of it (they come later in the DOM). */
  min-width: 0;
  overflow: hidden;
}

/* Matches .list-btn's own gap and padding, so the placeholder
   sits exactly where the button it stands in for will. */
.list-meta {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.4rem 0.5rem;
  min-width: 0;
}

.list-emoji-skeleton {
  flex-shrink: 0;
}

/* A stamp, not a control: no press state and no tap target, because there is
   nothing to do with it. Drawn from the brand tokens, like the rest of the bar. */
.channel-badge {
  flex-shrink: 0;
  padding: 0.15rem 0.4rem;
  border: 1px solid color-mix(in srgb, var(--color-primary) 45%, transparent);
  border-radius: var(--radius-xs);
  background: var(--color-primary-bg);
  color: var(--color-primary-text);
  font-size: var(--text-2xs);
  font-weight: var(--weight-extrabold);
  letter-spacing: 0.08em;
  line-height: 1.5;
}

/* Shared BackButton. Its top margin is for standing alone at the top of a card;
   here the bar centres it, and the left inset it keeps matches .list-btn's
   own padding, so whichever of the three things can hold this slot starts in the
   same place. A negative margin would be clipped by .topbar-left anyway. */
.topbar-back {
  margin-top: 0;
}

.topbar-logo {
  height: 36px;
  width: auto;
  object-fit: contain;
}

/* flex:1 so the name takes the slack and ellipsizes before the caret after it
   is pushed off the edge. */
.list-info {
  flex: 1;
  min-width: 0;
}

.list-name {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  margin: 0;
  color: inherit;
  font-family: inherit;
  font-size: var(--text-md);
  font-weight: var(--weight-bold);
  /* Tighter than the body default: the name and the stack under it are one
     block, and a 1.5 line-height pushed that block past the 72px bar. */
  line-height: 1.25;
  letter-spacing: -0.01em;
  /* A long list name must never shove the account button off the edge: cap it
     to the available width and ellipsize the overflow. min-width:0 lets it
     shrink inside the block's flex row rather than forcing it wider. */
  max-width: 100%;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-tap-highlight-color: transparent;
  box-sizing: border-box;
}

/* The text alone ellipsizes, so the chevron after it never goes. */
.list-name__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Says the name opens something. Turned down, the way a disclosure points at
   what it will show. */
.list-name__chevron {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: var(--color-on-strong-muted);
  transform: rotate(90deg);
}

.list-name__chevron :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2.4;
  fill: none;
}



/* ─── List block ────────────────────────────────────────────────────────── */
.list-btn {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex: 1;
  min-width: 0;
  font: inherit;
  color: inherit;
  border: none;
  background: transparent;
  /* Real padding on every side so the hover fill has room. No negative margins:
     .topbar-left has overflow:hidden and would clip them, which is exactly why
     the hover looked like it had no padding. */
  padding: 0.4rem 0.5rem;
  border-radius: var(--radius-lg);
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-fast),
    transform var(--transition-fast) var(--ease-rise);
  -webkit-tap-highlight-color: transparent;
}

/* Faces and the trip's progress, side by side under the name. */
.list-subrow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: 0.3rem;
  min-height: 20px;
}

.list-subrow :deep(.member-stack) {
  --member-avatar-size: 22px;
  /* A pale ring, mixed from the white and the bar's own green: enough to cut
     each face out where a pure green gap let them blur together, not so much
     that the stack reads as white outlines. Solid rather than translucent, so
     an overlapping face still covers the one under it. */
  --member-avatar-ring: color-mix(in srgb, var(--color-on-strong) 40%, var(--color-primary-strong));
}

.list-subrow :deep(.member-avatar) {
  border-width: 1.5px;
}

/* The letter faces and the "+n" become white discs with green letters, so they
   read as faces rather than as holes in the bar. */
.list-subrow :deep(.member-avatar--fallback),
.list-subrow :deep(.member-avatar--more) {
  background: var(--color-on-strong);
  color: var(--color-primary-strong);
  font-size: 0.6rem;
  font-weight: var(--weight-extrabold);
}

.list-progress {
  flex-shrink: 0;
  width: 8.5rem;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.2rem;
}

.list-progress__label {
  text-align: center;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  line-height: 1.2;
  color: var(--color-on-strong-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.list-progress__track {
  position: relative;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--color-on-strong-fill-strong);
  overflow: hidden;
}

/* The fill leads with a slightly brighter edge, so its front reads as moving
   forward rather than as a flat block. */
.list-progress__fill {
  position: relative;
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(
    to right,
    color-mix(in srgb, var(--color-on-strong) 62%, transparent),
    color-mix(in srgb, var(--color-on-strong) 92%, transparent)
  );
  overflow: hidden;
  transition: width 420ms var(--ease-rise);
}

/* A soft glint that runs along the fill once per tick. */
.list-progress__shine {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 20%,
    var(--color-on-strong) 50%,
    transparent 80%
  );
  transform: translateX(-100%);
  animation: progress-shine 700ms var(--ease-standard) 120ms;
}

@keyframes progress-shine {
  to {
    transform: translateX(100%);
  }
}

/* Everything in the cart: one breath of the bar, then still. */
.list-progress--done .list-progress__track {
  animation: progress-done 520ms var(--ease-rise);
}

@keyframes progress-done {
  40% {
    transform: scaleY(1.7);
  }
}

@media (prefers-reduced-motion: reduce) {
  .list-progress__fill {
    transition: none;
  }

  .list-progress__shine,
  .list-progress--done .list-progress__track {
    animation: none;
  }
}

/* The phone's label version: same box, so nothing shifts between the two,
   but nothing that invites a press. */
.list-btn--static,
.list-btn--static:active {
  background: transparent;
  cursor: default;
  transform: none;
}

.list-btn--static:active .list-emoji {
  background: var(--color-on-strong-fill);
}

/* The list's emoji, in the same square it wears inside the panel. It leads
   the block: the name is variable-width text and the avatar stack under it is a
   ragged row of circles, so before this there was nothing holding the left edge
   and the block started at a different place for every list. */
.list-emoji {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-lg);
  line-height: 1;
  background: var(--color-on-strong-fill);
}




.sync-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: 28px;
  padding: 0 0.6rem;
  border-radius: var(--radius-pill);
  background: var(--warning-bg);
  color: var(--warning-text);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  white-space: nowrap;
}

.sync-pill__icon {
  width: 14px;
  height: 14px;
}

.sync-pill__icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2.2;
  fill: none;
}

.sync-spinner {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin: 0 var(--space-2);
  border-radius: 50%;
  border: 2px solid var(--color-on-strong-fill-strong);
  border-top-color: var(--color-on-strong);
  animation: sync-spin 0.9s linear infinite;
}

@keyframes sync-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Still turning, since it is the only sign anything is happening, but slowly
   enough not to draw the eye. */
@media (prefers-reduced-motion: reduce) {
  .sync-spinner {
    animation-duration: 2.4s;
  }
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  /* Never let the list name squeeze the action buttons. */
  flex-shrink: 0;
}

/* Borderless on purpose. Three outlined circles in a row gave the eye nothing
   to land on; the avatar keeps its ring and is the only focal point out here,
   while history reads as a plain icon until you reach for it. */
.topbar-icon-btn {
  width: var(--size-control-md);
  height: var(--size-control-md);
  border-radius: var(--radius-pill);
  border: none;
  background: transparent;
  color: var(--color-on-strong);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background var(--transition-fast), color var(--transition-fast),
    transform var(--transition-fast) var(--ease-rise);
  -webkit-tap-highlight-color: transparent;
}

.topbar-icon-btn:hover {
  background: var(--color-on-strong-fill);
  color: var(--color-on-strong);
}

.history-icon {
  width: 20px;
  height: 20px;
  display: inline-block;
  background-color: currentColor;
  opacity: 0.86;
  mask: url('../assets/history.svg') no-repeat center / contain;
  -webkit-mask: url('../assets/history.svg') no-repeat center / contain;
}

:global(:root[data-theme='dark']) .history-icon {
  background-color: var(--text-inverse);
  opacity: 0.96;
}

.user-avatar-btn {
  width: var(--size-control-md);
  height: var(--size-control-md);
  border-radius: var(--radius-pill);
  border: var(--border-width-thick) solid var(--color-on-strong-fill-strong);
  background: var(--color-on-strong-fill);
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast),
    transform var(--transition-fast) var(--ease-rise);
  flex-shrink: 0;
  -webkit-tap-highlight-color: transparent;
}

.user-avatar-btn:hover {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary-soft);
}

.user-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-pill);
}

.user-avatar-fallback {
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
}
</style>
