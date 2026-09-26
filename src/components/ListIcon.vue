<script setup lang="ts">
import { computed } from 'vue'
import { DEFAULT_LIST_EMOJI, listIconUrl } from '../lib/listEmoji'

// A list's icon wherever it is drawn. Sized in em, so each caller keeps the
// font-size it already set for the emoji this replaced.
const props = defineProps({
  value: { type: String, default: '' },
})

const shown = computed(() => props.value || DEFAULT_LIST_EMOJI)
const url = computed(() => listIconUrl(shown.value))
</script>

<template>
  <img v-if="url" class="list-icon" :src="url" alt="" draggable="false" />
  <template v-else>{{ shown }}</template>
</template>

<style scoped>
.list-icon {
  display: block;
  width: 1.25em;
  height: 1.25em;
  object-fit: contain;
}
</style>
