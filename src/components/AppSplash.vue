<script setup lang="ts">
// Shown while the very first navigation resolves (connectivity + Clerk), so the
// app never flashes a blank screen on cold start — especially offline, where the
// router has to make a decision before any route can mount.
</script>

<template>
  <div class="splash">
    <!-- eslint-disable-next-line vue/no-bare-strings-in-template -- brand name, the same in every language -->
      <img src="/icons/pwa-192.png" alt="Bagful" class="splash-logo" />
    <span class="splash-spinner"></span>
  </div>
</template>

<style scoped>
.splash {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  background: var(--color-primary-bg);
  padding: var(--safe-top) 1rem var(--safe-bottom);
}

.splash-logo {
  width: 84px;
  height: 84px;
  object-fit: contain;
}

.splash-spinner {
  width: 26px;
  height: 26px;
  border: 3px solid color-mix(in srgb, var(--color-primary) 25%, transparent);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: splash-spin 0.7s linear infinite;
}

@keyframes splash-spin {
  to { transform: rotate(360deg); }
}
</style>
