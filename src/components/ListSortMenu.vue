<script setup lang="ts">
import { computed, ref, type PropType } from 'vue'
import type { ShoppingItem } from '../lib/shoppingList'
import type { ListSort } from '../lib/listSections'
import PopoverMenu from './PopoverMenu.vue'
import { t } from '../lib/i18n'
import AppIcon from './AppIcon.vue'
import ShopBadges from './ShopBadges.vue'

// The button in the list header: how the list is ordered, and (nightly) which
// shop it is narrowed to. PopoverMenu owns the panel itself.
//
// Ordering rather than a To buy / Checked filter: ticked rows have their own
// "In cart" section, so the question worth asking in a shop is "in what order
// do I walk this".
const model = defineModel<ListSort>({ default: 'added' })

// Independent of the order: "by aisle, at Lidl" is a fair question. NIGHTLY
// ONLY -- the caller passes no shops on production and the section is absent.
const shop = defineModel<string | null>('shop', { default: null })

const props = defineProps({
  items: { type: Array as PropType<ShoppingItem[]>, default: () => [] },
  // Only the shops something on THIS list is actually sold at. Derived by the
  // caller, which is the one that holds the lookup -- and derived rather than
  // fixed so the menu can never offer a shop that would empty the list.
  shops: { type: Array as PropType<string[]>, default: () => [] },
  // How many rows each shop would leave, by the same rule the list filters by.
  shopCounts: { type: Object as PropType<Record<string, number>>, default: () => ({}) },
})

const open = ref(false)
const btnEl = ref<HTMLElement | null>(null)

// A computed, so the labels follow a language change made while the app is open.
const OPTIONS = computed(() => [
  { value: 'added' as const, label: t('sort.added.label'), hint: t('sort.added.hint') },
  { value: 'aisle' as const, label: t('sort.aisle.label'), hint: t('sort.aisle.hint') },
])

// A shop filter hides rows, and a list that hides rows without saying so is how
// items get declared missing, so the button carries a mark while one is set.
// The order hides nothing, so it earns no mark.
const isFiltered = computed(() => shop.value !== null)
</script>

<template>
  <button
    ref="btnEl"
    type="button"
    class="filter-btn"
    :class="{ 'filter-btn--on': isFiltered }"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-label="isFiltered ? t('sort.buttonLabelFiltered') : t('sort.buttonLabel')"
    @click="open = !open"
  >
    <AppIcon class="filter-btn__icon" name="sliders-horizontal" />
    <span v-if="isFiltered" class="filter-btn__dot" aria-hidden="true"></span>
  </button>

  <PopoverMenu
    v-model="open"
    :trigger="btnEl"
    align="right"
    :label="t('sort.buttonLabel')"
    :heading="t('sort.heading')"
    icon-name="sliders-horizontal"
  >
    <template #default="{ close }">
      <button
        v-for="option in OPTIONS"
        :key="option.value"
        type="button"
        class="menu-item filter-option"
        :class="{ 'menu-item--active': model === option.value }"
        role="menuitemradio"
        :aria-checked="model === option.value"
        @click="((model = option.value), close())"
      >
        <!-- Always rendered, empty on the rows that are not chosen: it holds
             the space so every label starts on the same line. -->
        <AppIcon
          class="menu-check"
          :name="model === option.value ? 'check-bold' : ''"
        />
        <span class="filter-option__text">
          <span class="filter-option__label">{{ option.label }}</span>
          <span class="filter-option__hint">{{ option.hint }}</span>
        </span>
      </button>

      <!-- The second dimension. Only what this list is actually sold at, so a
           shop offered here always has something behind it.

           A separator with a name rather than a second popover: the two filters
           combine, and putting them in different panels would hide that from
           the person setting them. role="separator" is what tells a screen
           reader the same thing the line tells everyone else. -->
      <template v-if="props.shops.length > 0">
        <p class="filter-group" role="separator">{{ t('filter.shopHeading') }}</p>

        <button
          type="button"
          class="menu-item filter-option"
          :class="{ 'menu-item--active': shop === null }"
          role="menuitemradio"
          :aria-checked="shop === null"
          @click="((shop = null), close())"
        >
          <AppIcon class="menu-check" :name="shop === null ? 'check-bold' : ''" />
          <span class="filter-option__text">
            <span class="filter-option__label">{{ t('filter.shopAny.label') }}</span>
            <span class="filter-option__hint">{{ t('filter.shopAny.hint') }}</span>
          </span>
          <span class="filter-option__count">{{ props.items.length }}</span>
        </button>

        <button
          v-for="slug in props.shops"
          :key="slug"
          type="button"
          class="menu-item filter-option"
          :class="{ 'menu-item--active': shop === slug }"
          role="menuitemradio"
          :aria-checked="shop === slug"
          @click="((shop = shop === slug ? null : slug), close())"
        >
          <AppIcon class="menu-check" :name="shop === slug ? 'check-bold' : ''" />
          <span class="filter-option__text">
            <!-- No hint under a shop, unlike every other row here. Its name is
                 the whole of what it is, and the line that used to sit here
                 explained the unknowns rule -- which is a fact about how empty
                 the catalog is today, not about Auchan. -->
            <span class="filter-option__label filter-option__label--shop">
              <ShopBadges :shops="[slug]" labelled />
            </span>
          </span>
          <span class="filter-option__count">{{ props.shopCounts[slug] ?? 0 }}</span>
        </button>
      </template>
    </template>
  </PopoverMenu>
</template>

<style scoped>
/* Names the second group of rows. Not a menu item, so it takes none of their
   padding rules -- only their left edge, so the labels below still line up. */
.filter-group {
  margin: 0.35rem 0 0.15rem;
  padding: 0.35rem 1rem 0.15rem;
  border-top: var(--border-width-thin) solid var(--border-light);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-disabled);
}

/* The label slot holds a mark and a name here rather than plain text. */
.filter-option__label--shop {
  display: inline-flex;
  min-width: 0;
}

/* Carries the same surface as the topbar's history and settings buttons -- a
   filled pill with a border -- one size down, because this sits in a meta line
   rather than the chrome. Bare icons in a row of muted text read as labels;
   this one has to read as something you press. */
.filter-btn {
  position: relative;
  flex-shrink: 0;
  width: var(--size-control-md);
  height: var(--size-control-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--border-width-base) solid var(--border-main);
  background: var(--bg-hover);
  color: var(--text-secondary);
  border-radius: var(--radius-pill);
  cursor: pointer;
  padding: 0;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    color var(--transition-fast);
}

.filter-btn:hover,
.filter-btn[aria-expanded='true'] {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary-soft);
  color: var(--text-primary);
}

.filter-btn--on {
  border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
  color: var(--color-primary);
}

.filter-btn__icon {
  width: 15px;
  height: 15px;
  display: block;
}

/* The asset ships at stroke-width 1, too fine to read at this size. */
.filter-btn__icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

/* Sits on the rim rather than inside it, so the border stays unbroken. The ring
   is the page showing through, not a surface: .list-meta paints nothing, so what
   is behind the dot is the body's --bg-main.

   It read --bg-page until now, which this app has never defined. A var() with no
   fallback invalidates the whole shorthand, so the dot has been drawn with no
   ring at all since the filter button was added -- visible, but merging into the
   button's own border exactly as the line above says it must not. */
.filter-btn__dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-primary);
  border: var(--border-width-base) solid var(--bg-main);
}

/* Row internals; the row's own box comes from PopoverMenu's .menu-item. */
.filter-option__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.filter-option__label {
  line-height: 1.3;
}

.filter-option__hint {
  font-size: var(--text-2xs);
  font-weight: var(--weight-regular);
  color: var(--text-secondary);
  line-height: 1.3;
}

.filter-option__count {
  flex-shrink: 0;
  min-width: 1.5rem;
  text-align: right;
  font-size: var(--text-sm);
  color: var(--text-disabled);
  font-variant-numeric: tabular-nums;
}
</style>
