<script setup lang="ts">
// Add a product the catalog doesn't have. This only builds the product and hands
// it to the caller; contributing it to the catalog is HomeView's job, via the
// add_custom_product RPC (006_product_catalog.sql) once the add itself succeeds. This is
// also the only way to give a hand-typed item a maker, which otherwise arrives
// solely from a catalog pick.
import { ref, computed, watch, nextTick } from 'vue'
import AppButton from './AppButton.vue'
import AppModal from './AppModal.vue'
import { ITEM_NAME_MAX_LENGTH, PRODUCT_MAKER_MAX_LENGTH } from '../lib/limits'
import { t } from '../lib/i18n'

const props = defineProps({
  open: { type: Boolean, default: false },
  // What was already typed into the add form, so the modal continues that
  // thought instead of making the user type it a second time.
  initialName: { type: String, default: '' },
  // Mirror the DB's length check (004_shopping_list.sql) so the form rejects
  // what the row would reject anyway. Passed in because the caller already holds
  // it; the maker's own cap is read straight from lib/limits below, since no
  // caller ever passed one and a database constraint should not be a component
  // default. The fallback here comes from the same place for the same reason —
  // a literal would be a second copy of the migration's bound, free to drift.
  nameMaxLength: { type: Number, default: ITEM_NAME_MAX_LENGTH },
  // The code this dialog opens with — set when it was reached from a scan the
  // catalog could not answer, empty when the user typed their way here. Either
  // way the field below is editable: a misread digit is worth correcting, and a
  // product on the counter is worth typing a code for even without scanning it.
  initialBarcode: { type: String, default: '' },
})

const emit = defineEmits<{
  submit: [product: { name: string; maker: string | null; barcode: string | null }]
  cancel: []
}>()

// What product_catalog_barcode_format accepts (006_product_catalog.sql). The
// server drops anything else silently, which is right for a fire-and-forget RPC
// and wrong for a field someone is looking at — so the same rule is enforced
// here, where it can still be corrected.
const BARCODE_RE = /^[0-9]{8,14}$/

const name = ref('')
const maker = ref('')
const barcode = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

// Every open starts from the add form's text with a blank maker, so a previous
// visit can never leave a stale manufacturer attached to a different product.
// The barcode starts from whatever the scan found, which is empty for a product
// reached by typing.
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    name.value = props.initialName
    maker.value = ''
    barcode.value = props.initialBarcode
    await nextTick()
    nameInput.value?.focus()
    nameInput.value?.select()
  },
)

// Empty is fine — the field is optional. Half a barcode is not: it would be
// dropped on the way to the database, and the user would have no way of knowing
// their scan shortcut was never saved.
const barcodeInvalid = computed(
  () => barcode.value.trim().length > 0 && !BARCODE_RE.test(barcode.value.trim()),
)

const canSubmit = computed(() => name.value.trim().length > 0 && !barcodeInvalid.value)

function submit() {
  const productName = name.value.trim()
  if (!productName || barcodeInvalid.value) return
  emit('submit', {
    name: productName,
    maker: maker.value.trim() || null,
    barcode: barcode.value.trim() || null,
  })
}
</script>

<template>
  <AppModal
    :open="open"
    overlay-class="custom-product-overlay"
    transition="custom-product-fade"
    @close="emit('cancel')"
  >
      <div
        class="custom-product-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-product-title"
      >
        <div class="custom-product-dialog__icon-wrap">
          <span class="custom-product-dialog__icon" aria-hidden="true"></span>
        </div>

        <div class="custom-product-dialog__body">
          <!-- One name, whichever way you got here. This dialog is reached from
               the suggestion list's "Add your own" and from a scan the catalog
               could not answer, and it used to rename itself for the second —
               which made one dialog look like two features and left the app with
               three labels for a single action. What actually differs between
               the two routes is one field's starting value, so that is all that
               differs now. -->
          <h4 id="custom-product-title" class="custom-product-dialog__title">{{ t('add.addYourOwn') }}</h4>
          <p class="custom-product-dialog__message">{{ t('custom.message') }}</p>
        </div>

        <form class="custom-product-form" @submit.prevent="submit" @keydown.esc="emit('cancel')">
          <label class="custom-product-field">
            <span class="custom-product-label">{{ t('custom.productLabel') }}</span>
            <input
              ref="nameInput"
              v-model="name"
              type="text"
              :placeholder="t('custom.productPlaceholder')"
              :maxlength="nameMaxLength"
              autocomplete="off"
            />
          </label>

          <label class="custom-product-field">
            <span class="custom-product-label">
              {{ t('custom.makerLabel') }}
              <span class="custom-product-optional">{{ t('custom.optional') }}</span>
            </span>
            <input
              v-model="maker"
              type="text"
              :placeholder="t('custom.makerPlaceholder')"
              :maxlength="PRODUCT_MAKER_MAX_LENGTH"
              autocomplete="off"
            />
          </label>

          <!-- Optional, and last, because it is the field fewest people will
               touch: filled already when a scan brought you here, blank and
               skippable when you typed your way in. inputmode numeric so a phone
               offers digits without type="number"'s spinners and its habit of
               eating leading zeros — which a barcode can start with.

               The placeholder describes the format rather than showing a
               specimen code, unlike the two fields above. A plausible 13-digit
               number here would be indistinguishable at a glance from one that
               really was scanned, and checking it against the package is the
               entire reason this field is visible. -->
          <label class="custom-product-field">
            <span class="custom-product-label">
              {{ t('custom.barcodeLabel') }}
              <span class="custom-product-optional">{{ t('custom.optional') }}</span>
            </span>
            <input
              v-model="barcode"
              type="text"
              inputmode="numeric"
              :placeholder="t('custom.barcodePlaceholder')"
              maxlength="14"
              autocomplete="off"
              class="custom-product-barcode"
              :class="{ 'custom-product-barcode--invalid': barcodeInvalid }"
              :aria-invalid="barcodeInvalid"
              aria-describedby="custom-product-barcode-hint"
            />
            <!-- What filling this in actually buys, said once and always. It
                 carried the barcode route's whole reason for existing back when
                 the dialog renamed itself; the field it is about is a better
                 place for it than the title. -->
            <span
              v-if="!barcodeInvalid"
              id="custom-product-barcode-hint"
              class="custom-product-note"
            >
              {{ t('custom.barcodeNote') }}
            </span>
            <!-- Says what a barcode is rather than that this one is wrong: the
                 user is mid-typing, and the count is the thing they can act on. -->
            <span
              v-if="barcodeInvalid"
              id="custom-product-barcode-hint"
              class="custom-product-hint"
            >
              {{ t('custom.barcodeInvalid') }}
            </span>
          </label>

          <div class="custom-product-dialog__actions">
            <AppButton variant="secondary" block type="button" @click="emit('cancel')">{{ t('common.cancel') }}</AppButton>
            <AppButton variant="primary" block type="submit" :disabled="!canSubmit">{{ t('custom.submit') }}</AppButton>
          </div>
        </form>
      </div>
  </AppModal>
</template>

<style scoped>
.custom-product-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark-strong);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) calc(var(--space-4) + var(--safe-bottom));
}

.custom-product-dialog {
  width: 100%;
  max-width: 400px;
  /* Three fields and a keyboard leave very little of a small phone. Bounded by
     the overlay's box (which already subtracts the safe areas) and scrolled
     inside itself, so the actions stay reachable instead of being clipped off
     the bottom of the screen. */
  max-height: 100%;
  overflow-y: auto;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  border: var(--border-width-thin) solid var(--border-main);
  box-shadow: var(--elevation-dialog);
  padding: var(--space-7) var(--space-7) var(--space-6);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  text-align: center;
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

.custom-product-dialog__icon-wrap {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  color: var(--color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* Masked rather than inlined, so the icon is the asset on disk and takes the
   wrap's colour (the same pattern as .add-icon in AddItemForm). */
.custom-product-dialog__icon {
  width: 26px;
  height: 26px;
  background-color: currentColor;
  mask: url('../assets/icons/package-search.svg') no-repeat center / contain;
  -webkit-mask: url('../assets/icons/package-search.svg') no-repeat center / contain;
}

.custom-product-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.custom-product-dialog__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.custom-product-dialog__message {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

/* Digits, and read as digits: a scanned code is checked against the package by
   eye, which tabular figures and a little tracking make possible. */
.custom-product-barcode {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}

/* But only the digits. The placeholder here is a sentence, not a code, and
   inheriting the tracking made it read as a different typeface from the
   placeholders in the two fields above it. */
.custom-product-barcode::placeholder {
  font-variant-numeric: normal;
  letter-spacing: normal;
}

/* Qualified by the field wrapper so it outranks `.custom-product-field input:focus`
   — which is more specific than a bare class and would otherwise keep the border
   green while the value in it is one the database would refuse. */
.custom-product-field input.custom-product-barcode--invalid,
.custom-product-field input.custom-product-barcode--invalid:focus {
  border-color: var(--danger-border);
}

.custom-product-hint {
  font-size: var(--text-xs);
  color: var(--danger-text);
  line-height: var(--leading-snug);
}

/* Same slot as the error, quieter: this one is not a correction, it is the
   answer to "why would I fill this in". */
.custom-product-note {
  font-size: var(--text-xs);
  color: var(--text-disabled);
  line-height: var(--leading-snug);
}

.custom-product-form {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  width: 100%;
}

.custom-product-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  text-align: left;
}

.custom-product-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
  letter-spacing: 0.01em;
}

.custom-product-optional {
  font-weight: var(--weight-semibold);
  color: var(--text-disabled);
  text-transform: lowercase;
  letter-spacing: 0;
}

.custom-product-field input {
  width: 100%;
  padding: 0.7rem 0.85rem;
  background: var(--bg-surface);
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-lg);
  font-family: inherit;
  font-size: var(--text-md);
  color: var(--text-primary);
  outline: none;
  transition: border-color var(--transition-fast);
}

.custom-product-field input:focus {
  border-color: var(--color-primary);
}

.custom-product-field input::placeholder {
  color: var(--text-disabled);
}

.custom-product-dialog__actions {
  display: flex;
  gap: 0.65rem;
  width: 100%;
  margin-top: 0.25rem;
}

.custom-product-fade-enter-active,
.custom-product-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.custom-product-fade-enter-from,
.custom-product-fade-leave-to {
  opacity: 0;
}

/* Beats the entrance animation on the base class, which by now has finished. */
.custom-product-fade-leave-active .custom-product-dialog {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}
</style>
