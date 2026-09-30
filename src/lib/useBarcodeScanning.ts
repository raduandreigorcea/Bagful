import { ref, type Ref } from 'vue'
import {
  canScanBarcodes,
  nativeScanAvailable,
  scanWithNativeScanner,
} from './barcodeScanner'
import type { ProductSuggestion } from './productSearch'
import { track } from './analytics'
import { isCurrentlyOffline } from './connectivity'

// Reading a barcode and deciding what it means.
//
// A scan is a suggestion arrived at with the camera instead of the keyboard, so
// a hit takes the tapped-suggestion path exactly and lands the same
// confirmation. Only the miss is new, and it is handed to the "add your own"
// dialog that already exists for the typed version of the same problem.
//
// Two ways to obtain the code, one way to act on it. In the app that is Google's
// scanner: auto-zoom, and no camera permission of our own (see
// lib/barcodeScanner). In a browser, where that does not exist, it is our own
// camera screen. Everything from the code onwards — resolveScannedCode below —
// is shared, so the two differ only in how the barcode is read.
//
// Extracted from HomeView, where it was one of the last concerns still inline.
// The naming dialog deliberately stays with the view: it serves the typed
// "Can't find it?" path as well, so it belongs to neither half on its own. This
// reports a miss through onUnknownCode and lets the view decide what to open.

export interface BarcodeScanning {
  /** Whether this device can scan at all. */
  canScan: boolean
  /** Our own camera screen is up. Never true for the native scanner. */
  scannerOpen: Ref<boolean>
  /** A lookup is in flight; holds the scanner still so one code cannot start a
   *  second lookup over its own. */
  scanBusy: Ref<boolean>
  /** The last code the catalog had no product for, shown on our own screen. */
  scannedUnknown: Ref<string>
  openScanner: () => Promise<void>
  closeScanner: () => void
  /** From our own camera screen, which reads continuously. */
  onBarcodeDetected: (code: string) => Promise<void>
  /** The view's "name this code" action, from the row our screen shows. */
  reportUnknown: (code: string) => void
}

export function useBarcodeScanning(options: {
  /** Find the product a code names, or null if no database has one. */
  lookupBarcode: (code: string) => Promise<ProductSuggestion | null>
  /** Put a found product on the list — the same call a tapped suggestion makes. */
  addProduct: (product: ProductSuggestion & { barcode: string }) => void
  /** Clear the search dropdown, so a camera does not open over a list of matches. */
  clearSuggestions: () => void
  /**
   * No database knows this code. The view opens its naming dialog; this
   * composable does not own that dialog, because the same one is reached by
   * typing a product nothing matched.
   */
  onUnknownCode: (code: string) => void
}): BarcodeScanning {
  const { lookupBarcode, addProduct, clearSuggestions, onUnknownCode } = options

  // Asked once rather than per render: it cannot change while the view is
  // mounted, and the answer decides whether the add form offers the button at
  // all. A browser that cannot scan is never shown a control that would fail.
  const canScan = canScanBarcodes()
  const scannerOpen = ref(false)
  const scanBusy = ref(false)
  const scannedUnknown = ref('')
  // Every code that has missed while this scanner has been open. The set is what
  // keeps a barcode lying in frame from re-querying every couple of seconds for
  // an answer that has not changed.
  const unknownCodes = new Set<string>()

  async function openScanner(): Promise<void> {
    clearSuggestions()
    // Codes that missed are only remembered for the length of one scanning
    // session. Naming one makes it findable, so the next session must ask the
    // catalog again rather than trusting an answer from before it was told.
    unknownCodes.clear()
    scannedUnknown.value = ''

    if (nativeScanAvailable()) {
      const result = await scanWithNativeScanner()
      // Its UI is already gone by now: one scan, then it closes itself. Which is
      // why a miss goes straight to the naming dialog rather than to the row our
      // own screen shows — there is no screen left to show it on.
      if (result.ok) {
        if (result.code) await resolveScannedCode(result.code, 'native')
        return
      }
      // No Play Services, or the module would not install. Our own camera screen
      // is the fallback, and it reports its own failures if it cannot start
      // either.
    }

    scannerOpen.value = true
  }

  function closeScanner(): void {
    scannerOpen.value = false
    scanBusy.value = false
    scannedUnknown.value = ''
  }

  // Naming a code is a detour off the camera, so the camera goes away: the item
  // lands on the list, which is where the answer belongs and where the user ends
  // up.
  function reportUnknown(code: string): void {
    closeScanner()
    onUnknownCode(code)
  }

  // What a barcode means, whichever scanner read it.
  //
  // `source` is not cosmetic: it decides where a miss goes, and whether the user
  // can still walk away mid-lookup. Our own screen stays open and reads
  // continuously, so it can be closed while a lookup is in flight and a miss has
  // somewhere to be shown. The native scanner has already closed itself by the
  // time we have a code, so neither is true of it.
  async function resolveScannedCode(code: string, source: 'screen' | 'native'): Promise<void> {
    const reportMiss = () => {
      unknownCodes.add(code)
      if (source === 'screen') scannedUnknown.value = code
      else reportUnknown(code)
    }

    // Already asked about, and the answer does not change within a session.
    // Re-asserting it rather than querying again is what stops a barcode lying in
    // front of our own camera from firing a lookup every couple of seconds.
    if (unknownCodes.has(code)) {
      reportMiss()
      return
    }

    scanBusy.value = true
    scannedUnknown.value = ''
    const product = await lookupBarcode(code)
    scanBusy.value = false
    // Left our camera screen while the lookup ran. Adding behind a screen they
    // have closed is not what they asked for.
    if (source === 'screen' && !scannerOpen.value) return
    // Here and not in reportMiss, which re-fires for a code already known to
    // miss every time it sits in front of the camera.
    //
    // Offline, a lookup that failed looks the same as one that found nothing,
    // and counting it would make the catalog's miss rate track the shops'
    // signal instead of what the catalog holds. The miss is still shown.
    if (product || !isCurrentlyOffline()) track('barcode_scanned', { found: !!product })

    if (product) {
      // The scan IS the add, with no confirming tap: a barcode is an exact key,
      // and even a fuzzy search result commits outright when tapped. The
      // quantity is corrected on the list row.
      //
      // Same call a tapped suggestion makes, so the maker rides onto the row by
      // the same route. The add form is not touched at all: writing the name into
      // it would leave the query sitting there afterwards, suppressing suggestions
      // until it was edited by hand.
      //
      // Then the screen goes, and the list behind it is the confirmation -- the row
      // is there with its own stepper on it. One code per scan, on both scanners:
      // ours could have kept reading and Google's could have been reopened, but a
      // camera that comes back on its own after every item is a thing to dismiss
      // rather than a thing to use.
      addProduct({ ...product, barcode: code })
      closeScanner()
      return
    }

    reportMiss()
  }

  async function onBarcodeDetected(code: string): Promise<void> {
    if (!scannerOpen.value) return
    await resolveScannedCode(code, 'screen')
  }

  return {
    canScan,
    scannerOpen,
    scanBusy,
    scannedUnknown,
    openScanner,
    closeScanner,
    onBarcodeDetected,
    reportUnknown,
  }
}
