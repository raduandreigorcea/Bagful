import { t } from './i18n'

// Minimal structural view of a Clerk user, so lib stays free of @clerk imports.
export interface UserLike {
  fullName?: string | null
  firstName?: string | null
  imageUrl?: string | null
  primaryEmailAddress?: { emailAddress?: string | null } | null
  emailAddresses?: ReadonlyArray<{ emailAddress?: string | null }> | null
}

// The two identity fields the profiles table stores, derived from a Clerk user.
// The one authority the client uses for both the create/join writes and the
// keep-fresh upsert, so they can never disagree. Mirrors the clamping the DB
// applies (003_lists_and_members.sql): name capped at 80 chars, avatar https-only.
export interface ProfileFields {
  display_name: string
  image_url: string | null
}

// The only host an avatar may come from.
//
// Clerk serves every profile image from here, whatever the original source — an
// uploaded photo and a Google or Apple OAuth avatar all come back as an
// img.clerk.com URL. So this is not a restriction on what users may have, it is
// a statement of where the app's own avatars actually live.
//
// Why it is not simply "any https URL", which is what it used to be: a member
// can write their own profiles row, and every co-member's browser fetches
// whatever is in it. An arbitrary https host is therefore a beacon — it hands
// the person who chose it the IP address, device and viewing time of everyone
// else in the list. 003 spotted this and closed the scheme half of it
// (https only); this is the host half.
const CLERK_IMAGE_HOST = 'img.clerk.com'

function clerkImageUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.host !== CLERK_IMAGE_HOST) return null
    return raw
  } catch {
    return null
  }
}

export function deriveProfileFields(user: UserLike | null | undefined): ProfileFields {
  const name = getUserDisplayName(user) || getUserPrimaryEmail(user) || MEMBER_FALLBACK_NAME
  // Clamped to null rather than passed through for the database to reject, and
  // that direction matters: if Clerk ever moves its image host, this degrades to
  // "no avatar" instead of failing the profile upsert — which runs on every app
  // boot and would otherwise turn a cosmetic change into a broken sign-in.
  // The constraint in 003 stays the authority; it only ever sees a hand-built
  // request, which is exactly the case it is there for.
  return { display_name: name.slice(0, 80), image_url: clerkImageUrl(user?.imageUrl) }
}

export function getUserDisplayName(user: UserLike | null | undefined): string {
  return user?.fullName || user?.firstName || ''
}

export function getUserPrimaryEmail(user: UserLike | null | undefined): string {
  return (
    user?.primaryEmailAddress?.emailAddress
    || user?.emailAddresses?.[0]?.emailAddress
    || ''
  )
}

// What to call a member whose profile has no name on it.
//
// 'Member' is a shared contract, not a local default: it is the profiles column
// default, the fallback buy_items() archives into purchase_history, and what
// join_list_with_code() writes for a joiner with no name — all in
// 003/005. It was also written out inline in six components, which is one
// spelling away from a roster that says "Member" and a history that says
// "Unknown" for the same person.
//
// So it is NOT translated, and deriveProfileFields above still writes this
// exact string: it is a value the database stores, and a German user's profile
// row must not read "Mitglied" where every query and every other member's app
// expects "Member".
const MEMBER_FALLBACK_NAME = 'Member'

// The display side of the same idea, and the only place the two part company.
// A member with no name is described in the reader's language rather than in
// the column default's.
//
// The seam is real and worth naming: a row where the DATABASE already wrote
// 'Member' has a display_name, so it takes the first branch and still shows
// English. Nothing here can fix that without treating a stored name as absent,
// which would rename anyone who genuinely calls themselves Member. Accepted:
// it affects rows created before a name was known, and it corrects itself the
// moment that person's profile syncs.
export function memberDisplayName(
  member: { display_name?: string | null } | null | undefined,
): string {
  return member?.display_name || t('common.memberFallback')
}

/** The letter an avatar shows when there is no photo, or '?' for no name. */
export function initialOf(name: string | null | undefined): string {
  return (name || '?').slice(0, 1).toUpperCase()
}

export function getUserInitial(user: UserLike | null | undefined): string {
  return initialOf(getUserDisplayName(user) || getUserPrimaryEmail(user))
}
