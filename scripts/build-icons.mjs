// Renders every app icon from the two drawings in resources/ (npm run icons).
//
// resources/icon.svg is the logo; resources/icon-notification.svg is its
// one-colour outline. Everything below is generated from them, so a change to
// the logo is an edit there and a re-run here, never a hand-edited PNG. The
// PNGs are committed (the build does not run this), because Android and the
// PWA manifest read them straight from disk.
//
// Chromium does the rasterising, through the Playwright the tests already
// install, so no image library is needed for a job this rare.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = (p) => join(root, 'android/app/src/main/res', p)

const logo = readFileSync(join(root, 'resources/icon.svg'), 'utf8')
const outline = readFileSync(join(root, 'resources/icon-notification.svg'), 'utf8')
const dataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

// The rounded-square corner every launcher and the web use, as a share of the side.
const CORNER = 0.225
// The splash sits on the web splash's background (--color-primary-bg in
// src/style.css) with the logo at the web splash's 84px, so the hand-over from
// the native splash to AppSplash.vue does not jump.
const SPLASH_BG = '#f0f4f1'
const SPLASH_LOGO_DP = 84

const browser = await chromium.launch()
const page = await browser.newPage()

// Draws `svg` at `size` px inside a `width` x `height` canvas and saves a PNG.
// Anything the drawing does not cover stays transparent.
async function render(out, { svg, width, height = width, size = Math.min(width, height), radius = 0, background = 'transparent' }) {
  await page.setViewportSize({ width, height })
  await page.setContent(`<body style="margin:0;width:${width}px;height:${height}px;display:grid;place-items:center;background:${background}">
    <img src="${dataUri(svg)}" style="width:${size}px;height:${size}px;border-radius:${radius * 100}%">
  </body>`)
  await page.waitForFunction(() => document.images[0].complete)
  mkdirSync(dirname(out), { recursive: true })
  await page.screenshot({ path: out, omitBackground: background === 'transparent' })
  console.log('wrote', out.slice(root.length + 1))
}

// Web and PWA. The `any` icons are the rounded tile, since the app shows
// pwa-192 in its own top bar, login and splash; the maskable and Apple icons
// are full bleed because the platform cuts its own shape out of them.
const web = (p) => join(root, 'public/icons', p)
await render(web('pwa-192.png'), { svg: logo, width: 192, radius: CORNER })
await render(web('pwa-512.png'), { svg: logo, width: 512, radius: CORNER })
await render(web('maskable-512.png'), { svg: logo, width: 512 })
await render(web('apple-touch-icon.png'), { svg: logo, width: 180 })
await render(web('favicon-32.png'), { svg: logo, width: 32, radius: CORNER })
await render(web('favicon-16.png'), { svg: logo, width: 16, radius: CORNER })
// The badge Chrome on Android puts in the status bar for a web push.
await render(web('badge-96.png'), { svg: outline, width: 96 })

// Android launcher. Adaptive icons (API 26+) are a 108dp foreground over the
// ic_launcher_background colour, of which the middle 72dp shows: the logo
// without its #bg rect, drawn at 72/108 of the canvas. ic_launcher and
// ic_launcher_round are only for Android 7 (minSdk 24, 25).
const foreground = logo.replace(/<rect id="bg"[^>]*\/>/, '')
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [name, scale] of Object.entries(DENSITIES)) {
  await render(res(`mipmap-${name}/ic_launcher.png`), { svg: logo, width: 48 * scale, radius: CORNER })
  await render(res(`mipmap-${name}/ic_launcher_round.png`), { svg: logo, width: 48 * scale, radius: 0.5 })
  await render(res(`mipmap-${name}/ic_launcher_foreground.png`), { svg: foreground, width: 108 * scale, size: 72 * scale })
}

// Android splash, the size Capacitor generated for each slot. `drawable` is
// the mdpi fallback.
const SPLASHES = {
  drawable: [480, 320, 1], 'drawable-land-mdpi': [480, 320, 1], 'drawable-land-hdpi': [800, 480, 1.5],
  'drawable-land-xhdpi': [1280, 720, 2], 'drawable-land-xxhdpi': [1600, 960, 3], 'drawable-land-xxxhdpi': [1920, 1280, 4],
  'drawable-port-mdpi': [320, 480, 1], 'drawable-port-hdpi': [480, 800, 1.5], 'drawable-port-xhdpi': [720, 1280, 2],
  'drawable-port-xxhdpi': [960, 1600, 3], 'drawable-port-xxxhdpi': [1280, 1920, 4],
}
for (const [dir, [width, height, scale]] of Object.entries(SPLASHES)) {
  await render(res(`${dir}/splash.png`), { svg: logo, width, height, size: SPLASH_LOGO_DP * scale, radius: CORNER, background: SPLASH_BG })
}

await browser.close()

// The notification icon, as a vector drawable: sharp at every density from one
// file. Android keeps only its alpha, and OneSignal tints it (see
// NotificationAccentColor in AndroidManifest.xml). VectorDrawable has no masks,
// so icon-notification.svg is written with the two things this needs: a
// clip-path group for the groceries and fill-rule for the smile.
const [vx, vy, vw, vh] = outline.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number)
const clip = outline.match(/<clipPath[^>]*>\s*<rect x="(\S+)" y="(\S+)" width="(\S+)" height="(\S+)"/).slice(1).map(Number)
const [clipped, rest] = outline.split('</g>')
const paths = (svg) =>
  [...svg.matchAll(/<path([^>]*?)d="([^"]+)"/g)].map(([, attrs, d]) => {
    const evenOdd = /fill-rule="evenodd"/.test(attrs) ? ' android:fillType="evenOdd"' : ''
    return `<path android:fillColor="#FFFFFFFF"${evenOdd} android:pathData="${d}"/>`
  })
const [cx, cy, cw, ch] = clip
const vector = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from resources/icon-notification.svg by scripts/build-icons.mjs. Do not edit. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="${vw}" android:viewportHeight="${vh}">
    <group android:translateX="${-vx}" android:translateY="${-vy}">
        <group>
            <clip-path android:pathData="M${cx} ${cy} H${cx + cw} V${cy + ch} H${cx} Z"/>
            ${paths(clipped).join('\n            ')}
        </group>
        ${paths(rest).join('\n        ')}
    </group>
</vector>
`
writeFileSync(res('drawable/ic_stat_onesignal_default.xml'), vector)
console.log('wrote android/app/src/main/res/drawable/ic_stat_onesignal_default.xml')
