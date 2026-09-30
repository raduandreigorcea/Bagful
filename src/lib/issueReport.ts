// What a bug report is made of, and where it goes.
//
// The design premise, which is why this file exists at all rather than the
// dialog just holding a string: a report is only worth sending if someone can
// act on it, and almost everything that makes it actionable is something the
// app already knows. Version, connection, platform, whether there is stuck
// offline work — asking a person shopping in a supermarket to type any of that
// is asking them to do the app's job. So the dialog collects the two things
// only they can answer (where, and what happened) and this assembles the rest.
//
// The places below are named the way someone using Bagful would name them, not
// the way the code is organised: "Adding items", not AddItemForm. A report that
// says "Barcode scanner" narrows the search to two files without the reporter
// knowing either of them exists.

import { Capacitor } from '@capacitor/core'
import { isCurrentlyOffline } from './connectivity'
import { hasQueuedOfflineMutations } from './offlineQueue'
import { captureReport } from './errorReporting'
import { t } from './i18n'

export type ReportKind = 'bug' | 'idea'

export interface ReportSurface {
  id: string
  label: string
}

// Ordered by how often people are likely to be standing in them, not
// alphabetically — the list is scanned, not searched. "Somewhere else" stays
// last as the escape hatch; a report that lands there is a signal that this
// list is missing a place.
export const REPORT_SURFACES: ReportSurface[] = [
  { id: 'list', label: 'Shopping list' },
  { id: 'add', label: 'Adding items' },
  { id: 'scan', label: 'Barcode scanner' },
  { id: 'history', label: 'Checkout & history' },
  { id: 'settings', label: 'List & members' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'signin', label: 'Signing in' },
  { id: 'other', label: 'Somewhere else' },
]

export function surfaceLabel(id: string): string {
  return REPORT_SURFACES.find((surface) => surface.id === id)?.label || 'Somewhere else'
}

export interface ReportContext {
  listId?: string
  userId?: string
}

// No connection field. Sending requires a connection, so every report that
// arrives would carry "online" — a fact with one possible value tells the
// reader nothing and costs them a line to read past. Whether there are edits
// stuck in the offline queue is the connectivity fact worth having, and that
// one does vary.
export interface ReportDiagnostics {
  version: string
  platform: string
  pendingOfflineEdits: boolean
  listId: string
  userId: string
}

// Where the app is actually running. Three cases worth telling apart, because
// each one has bugs the others cannot have: the Android build (Capacitor
// WebView, native push, hardware back button), an installed PWA (its own
// service worker and update cycle), and a plain browser tab.
function detectPlatform(): string {
  try {
    if (Capacitor.isNativePlatform()) return `${Capacitor.getPlatform()} app`
  } catch {
    // Plugin unavailable — fall through to the web answers.
  }
  const standalone =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  return standalone ? 'installed app' : 'browser'
}

// Everything attached to a report without anyone typing it. Shown to the
// reporter before they send, in the same words used here — nothing travels that
// they were not told about.
export function collectDiagnostics(
  context: ReportContext = {},
  storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage,
): ReportDiagnostics {
  const userId = context.userId || ''
  return {
    version: __APP_VERSION__,
    platform: detectPlatform(),
    // A list that will not sync is the single most common thing behind "my
    // items keep disappearing", and it is invisible from the outside.
    pendingOfflineEdits: Boolean(storage && userId && hasQueuedOfflineMutations(storage, userId)),
    listId: context.listId || '',
    userId,
  }
}

// The plain-language version of the above, for the disclosure in the dialog.
// Deliberately not a key/value dump: someone deciding whether to send this
// should be able to read it as a sentence.
// Translated, unlike surfaceLabel above: these lines are shown to the person
// filling in the form, under "Sent with your report". What actually travels in
// the payload is the ReportDiagnostics object itself, which stays as it is.
export function describeDiagnostics(diagnostics: ReportDiagnostics): string[] {
  const lines = [
    t('report.diag.version', { version: diagnostics.version, platform: diagnostics.platform }),
  ]
  if (diagnostics.pendingOfflineEdits) lines.push(t('report.diag.pendingEdits'))
  if (diagnostics.listId) lines.push(t('report.diag.ids'))
  return lines
}

export interface IssueReport {
  kind: ReportKind
  // Empty for an idea: "where" is a question about a defect, and asking it of
  // someone proposing a feature is a form they did not come to fill in.
  surface: string
  message: string
  diagnostics: ReportDiagnostics
}

export const REPORT_MAX_LENGTH = 1000

export function isReportSendable(report: {
  kind: ReportKind
  surface: string
  message: string
}): boolean {
  if (report.message.trim().length < 4) return false
  if (report.kind === 'bug' && !report.surface) return false
  return true
}

// Sends the report. Today that means Sentry's feedback inbox — one entry per
// report, beside the crashes but not mixed into them — which is why this ships
// before the table it will eventually also write to: the button is worth having
// now, and nothing here changes when that table arrives except a second write
// below.
//
// The place is tagged by its label rather than its id, because the tag is read
// by a person: "Barcode scanner" says what "scan" only implies.
//
// Resolves false when there is nowhere to send: offline, or a build with no
// Sentry DSN. The caller keeps the dialog open and says so rather than
// pretending a report was filed.
export async function submitReport(report: IssueReport): Promise<boolean> {
  if (isCurrentlyOffline()) return false

  return captureReport(report.message.trim().slice(0, REPORT_MAX_LENGTH), {
    kind: report.kind,
    place: report.surface ? surfaceLabel(report.surface) : '',
    ...report.diagnostics,
  })
}
