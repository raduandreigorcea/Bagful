<script setup lang="ts">
import type { PropType } from 'vue'
import AppIcon from './AppIcon.vue'
import { shopLabel, shopBrand } from '../lib/shopBadges'

// Which shops carry a product, as their logos. Renders whatever it is given.
//
// Where a row came from is the one thing you cannot tell by looking at it: a
// product scraped from Auchan and one somebody in the list typed in render
// identically. No logo means nobody scraped it, not that no shop sells it.
//
// A LOGO RATHER THAN THE NAME, because the shop and the maker are frequently the
// same word -- Auchan sells products branded Auchan -- and "Auchan Auchan" reads
// as a rendering bug. A mark next to text cannot be misread as more text.
//
// Extracted from AddItemForm when the same discs were wanted on the list rows.
// The two callers size them differently through their own scoped CSS, which is
// the convention every other icon here already follows.

const props = defineProps({
  shops: { type: Array as PropType<string[]>, default: () => [] },
  // Show the shop's name beside its mark instead of only to a screen reader.
  //
  // For the two filters, where the mark is what you recognise but the name is
  // what you are choosing. On a product row it stays hidden: the name there
  // would sit next to a maker that is frequently the same word, which is the
  // thing the disc exists to avoid.
  labelled: { type: Boolean, default: false },
})

// The logos live in src/assets/brands/ and go through AppIcon like every other
// icon, so they are inlined at build time -- no request per row, under 4 KB for
// the set, and they work offline.
//
// A shop with no logo file renders its initial rather than a broken image:
// AppIcon yields '' for a name it does not have, and the monogram below fills
// the gap. That is the right failure for a retailer added to the registry before
// somebody draws its mark -- which is exactly what Mega Image was for a day.
// The names live in lib/shopBadges beside the shop list, because the filters
// label the same shops these discs do and two copies would drift.
const label = shopLabel

// Marks that are ALREADY a disc, and so should fill this one rather than sit
// inside it.
//
// Lidl's is a roundel and its asset is LIDL'S OWN FAVICON, taken from
// lidl.ro rather than from an icon set. That matters: the icon-set version is
// flattened to one blue, which throws away the yellow and red that make the mark
// recognisable, and what was left was a faint ring with four unreadable letters
// in it. Their favicon is the mark they themselves ship for a 16-pixel browser
// tab, so it is drawn to survive being tiny -- the colour does the work and the
// lettering is a detail rather than the whole thing.
//
// Mega Image's is their app tile, the gull glyph on white, minus the red
// rounded-square border the real tile has: in a disc it read as a red ring.
// It bleeds so the glyph keeps its size, but a white tile has no edge of its
// own, so it keeps the grey rim every inset logo has (WHITE_TILE). The disc's
// overflow clips the tile's corners, which is what an app icon expects anyway.
// The wordmark under the glyph was dropped from the asset: it is four letters
// tall at 20 pixels and reads as a smudge, the same trap Lidl's icon-set version
// fell into. The glyph is nudged down to sit centred without it.
//
// Aldi's is the Aldi Sued stripes on navy, recoloured from the one-colour
// icon-set version for the same reason as Lidl; every Aldi the catalog scrapes
// is Aldi Sued. Delhaize's is their app tile, the white lion on red.
//
// Auchan's bird (their own favicon), Carrefour's two arrows and MPreis's M have
// no background of their own and keep the inset, or they would touch the rim.
const FULL_BLEED = new Set(['aldi', 'delhaize', 'lidl', 'mega-image'])
const WHITE_TILE = new Set(['mega-image'])

// A retailer is one line in a registry and drawing its logo is a separate job,
// so a shop with no asset gets its initial rather than an empty circle that
// looks like a bug.
const KNOWN_LOGOS = new Set(['aldi', 'auchan', 'carrefour', 'delhaize', 'lidl', 'mega-image', 'mpreis'])

// Hofer is Aldi Sued's name in Austria and wears the same stripes.
const SAME_MARK: Record<string, string> = { hofer: 'aldi' }

// Logos belong to the CHAIN: Lidl Germany wears the Lidl roundel. See shopBrand.
function mark(slug: string): string {
  const brand = shopBrand(slug)
  return SAME_MARK[brand] ?? brand
}

function logo(slug: string): string {
  return `brands/${mark(slug)}`
}

function bleeds(slug: string): boolean {
  return FULL_BLEED.has(mark(slug))
}

function monogram(slug: string): { letter: string; colour: string } | null {
  if (KNOWN_LOGOS.has(mark(slug))) return null
  return { letter: (slug[0] ?? '?').toUpperCase(), colour: 'var(--text-secondary)' }
}
</script>

<template>
  <!-- Two shapes, because the name belongs OUTSIDE the disc when it is visible
       and inside it when it is only announced. A wrapper in both cases would
       put a span around every badge on every list row for nothing. -->
  <template v-for="shop in props.shops" :key="shop">
  <span
    v-if="labelled"
    class="shop-badges__labelled"
  >
    <span
      class="shop-badge"
      :class="{ 'shop-badge--mono': monogram(shop), 'shop-badge--bleed': bleeds(shop), 'shop-badge--rimmed': WHITE_TILE.has(mark(shop)) }"
      :style="monogram(shop) ? { background: monogram(shop)!.colour } : undefined"
      aria-hidden="true"
    >
      <span v-if="monogram(shop)" class="shop-badge__letter">{{ monogram(shop)!.letter }}</span>
      <AppIcon v-else :name="logo(shop)" />
    </span>
    <span class="shop-badges__name">{{ label(shop) }}</span>
  </span>
  <span
    v-else
    class="shop-badge"
    :class="{ 'shop-badge--mono': monogram(shop), 'shop-badge--bleed': bleeds(shop), 'shop-badge--rimmed': WHITE_TILE.has(mark(shop)) }"
    :style="monogram(shop) ? { background: monogram(shop)!.colour } : undefined"
    :title="label(shop)"
  >
    <span v-if="monogram(shop)" class="shop-badge__letter" aria-hidden="true">{{
      monogram(shop)!.letter
    }}</span>
    <AppIcon v-else :name="logo(shop)" />
    <!-- A logo says nothing on its own. Same visually-hidden pattern the list
         and the suggestions already use for their own announcements. -->
    <span class="shop-badge__name">{{ label(shop) }}</span>
  </span>
  </template>
</template>

<style scoped>
/* A disc carrying the shop's mark, which reads as a different KIND of thing from
   the maker beside it -- the point being that the two are often the same word
   and must not look like one repeated.

   Shrink-proof: this sits on rows whose name already truncates, and a mark
   squashed into an ellipse is worse than no mark. */
.shop-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  border: var(--border-width-thin) solid var(--border-light);
  /* White in both themes: an inset logo sits on a plate, and Carrefour navy on
     the dark surface was a mark nobody could read. */
  background: #fff;
  /* Lidl's mark is a filled square reaching the edge of its own viewBox, so
     without this it pokes out of the circle it is sitting in. */
  overflow: hidden;
}

/* Inset, so a square logo reads as a logo inside a disc rather than as a square
   fighting the border. The glyphs keep their own brand colours instead of taking
   currentColor -- the one place in this app where a mark is not tinted by the
   theme, because a recoloured Carrefour blue is not Carrefour. */
.shop-badge :deep(svg) {
  width: 1rem;
  height: 1rem;
  display: block;
}

/* A mark that is its own disc fills this one, and the rim would double its
   outline. */
.shop-badge--bleed {
  border-color: transparent;
}

.shop-badge--bleed.shop-badge--rimmed {
  border-color: var(--border-light);
}

.shop-badge--bleed :deep(svg) {
  width: 100%;
  height: 100%;
}

/* An initial on a flat colour, for a shop whose logo nobody has drawn yet. */
.shop-badge--mono {
  border-color: transparent;
  color: #fff;
}

.shop-badge__letter {
  font-size: 0.78rem;
  font-weight: var(--weight-bold);
  line-height: 1;
  /* The cap sits slightly high in most faces; nudging it down centres the letter
     in the circle rather than in its own line box. */
  transform: translateY(0.02em);
}

.shop-badge__name {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/* The mark and its name, for the filters. The disc keeps every rule above; all
   this adds is the pairing and the gap. */
.shop-badges__labelled {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.shop-badges__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
