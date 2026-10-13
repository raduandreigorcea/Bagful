<script setup lang="ts">
import { computed } from 'vue'
import { GENERIC_ICON, getProductIcon } from '../lib/productIcon'

// A product's picture wherever it is drawn, chosen from its name and maker.
// Sized in em, so each caller keeps the font-size it set for the emoji this
// replaced. The drawings are in src/assets/product-icons/, one SVG per name the
// rules in lib/productIcon.ts can return; a name with no file shows the generic
// basket, never text.
const props = defineProps({
  name: { type: String, default: '' },
  maker: { type: String, default: '' },
})

const URLS = import.meta.glob('../assets/product-icons/*.svg', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(URLS).map(([path, url]) => [path.replace(/^.*\/(.+)\.svg$/, '$1'), url]),
)

const url = computed(() => BY_NAME[getProductIcon(props.name, props.maker)] ?? BY_NAME[GENERIC_ICON])
</script>

<template>
  <img class="product-icon" :src="url" alt="" draggable="false" />
</template>

<style scoped>
.product-icon {
  display: block;
  width: 1.25em;
  height: 1.25em;
  object-fit: contain;
  border-radius: 28%;
}
</style>
