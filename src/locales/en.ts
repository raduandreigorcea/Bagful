// The English catalog, and the source of truth for what a catalog IS.
//
// Every other file in this directory is annotated `const xx: Catalog` against a
// type derived from this one, so a key added here and forgotten there fails
// `npm run typecheck` rather than shipping a screen that says
// 'setup.language.title' to somebody. English is also the static import and the
// runtime fallback — the other five are fetched lazily — so this file must stay
// complete and must never be the one that lags.
//
// Keys are flat and dotted, not nested. Three reasons, all small and all real:
// the catalog-parity test is `Object.keys()` equality rather than a tree walk,
// `t()` needs no path resolution, and `keyof typeof en` types the whole thing
// in one line.
//
// Naming is `<surface>.<component-or-state>.<thing>`. Errors are the exception:
// they all live under a flat `error.*` regardless of which module raises them,
// because the same sentence is reused from several call sites and filing it
// under the first one to need it makes the second look like a duplicate.
//
// A value is either a string or a plural entry `{ one?, few?, many?, other }`.
// See tn() in lib/i18n for which categories a language actually asks for —
// they are not the same set per language, and Romanian in particular needs
// three where English needs two.
//
// Square brackets in a heading mark the word that takes the accent colour. See
// tAccent() in lib/i18n: the marker is inside the sentence so each translator
// can put the accented word where their grammar puts it, rather than having
// its position fixed by a split into two keys. The brackets are read off this
// template before any {placeholder} is filled in, so they are the translator's
// to place and nobody else's.

export default {
  'common.back': 'Back',
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.closeModal': 'Close modal',
  'common.closeMenu': 'Close menu',
  'common.confirm': 'Confirm',
  'common.continue': 'Continue',

  // The language picker itself. The six language names are NOT here: a language
  // is listed under its own name (see LOCALE_ENDONYMS in lib/locale), which is
  // the whole point — someone hunting for "Română" is not reading the English
  // catalog to find it.
  'language.groupLabel': 'Choose a language',

  'setup.language.eyebrow': 'Welcome 🌍',
  'setup.language.title': 'Pick your [language]',
  'setup.language.sub': 'You can change this any time in App Settings.',

  'setup.welcome.eyebrow': 'Welcome to Bagful 🛒',
  'setup.welcome.title': 'One list for [everyone] who shops',
  'setup.welcome.sub':
    'Everyone adds, everyone checks off, and it all updates for everyone the moment it happens, so nothing gets forgotten at the store.',
  'setup.welcome.cta': 'Get started',

  'setup.picker.eyebrowAdd': 'Add a list',
  'setup.picker.eyebrowNew': 'Welcome aboard 👋',
  'setup.picker.titleAdd': 'Add another [list]',
  'setup.picker.titleNew': 'Set up your [list]',
  // Two whole sentences rather than one plus an appended clause. The English
  // original built this by concatenating ', or create a new one.' onto a stem,
  // which only works because English puts the clause last.
  'setup.picker.subAdd': 'Join another list with its invite code.',
  'setup.picker.subAddOrCreate':
    'Join another list with its invite code, or create a new one.',
  'setup.picker.subNew':
    'Create a shared shopping list, or join one using an invite code.',
  'setup.picker.createLabel': 'Create a list',
  'setup.picker.createDescription': 'Start a new list and get a shareable invite code',
  'setup.picker.joinLabel': 'Join a list',
  'setup.picker.joinDescription': 'Paste the invite code someone shared with you',

  'setup.create.eyebrow': 'New list',
  'setup.create.title': 'What should your list be called?',
  'setup.create.sub': 'This is the name everyone on the list will see.',
  'setup.create.nameLabel': 'List name',
  'setup.create.namePlaceholder': 'e.g. Weekly shop',

  'setup.join.eyebrow': 'Join a list',
  'setup.join.title': 'Enter your invite code',
  'setup.join.sub': 'Ask someone on the list for its invite code.',
  'setup.join.codeLabel': 'Invite code',
  'setup.join.codePlaceholder': 'e.g. AB3K7XYZ',

  'settings.title': 'App Settings',
  'settings.subtitle': 'How Bagful looks and behaves on this device',
  'settings.close': 'Close app settings',
  'settings.appearance': 'Appearance',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.system': 'System',
  'settings.notifications': 'Notifications',
  'settings.notifications.on': 'On',
  'settings.notifications.off': 'Off',
  'settings.replay': 'Screen recording',
  'settings.replay.hint': 'Share recordings of how I use the app, with all text hidden, to help fix bugs.',
  'settings.replay.on': 'On',
  'settings.replay.off': 'Off',
  'settings.language': 'Language',
  'settings.about': 'About',
  'settings.aboutHint': 'Bagful v{version}',

  'about.versionLine': 'v{version}',
  'about.close': 'Close about',
  'about.checkUpdates': 'Check for updates',
  'about.checking': 'Checking…',
  'about.upToDate': 'Bagful is up to date.',
  'about.checkFailed': "Couldn't reach GitHub to check. Try again when you're back online.",
  // The product-data credit, in three fragments because the shop names are
  // links and a link cannot be a {placeholder}. The names are proper nouns and
  // stay untranslated; only the connective text moves. All six languages keep
  // the "from A, B and C" order, which is what makes splitting it this way safe.
  //
  // There used to be a fourth fragment, ', under', because this was an ODbL
  // licence notice naming Open Food Facts and its two siblings. The catalog is
  // built from retailer listings now, so there is no licence to name.
  'about.creditLead': 'Product data from',
  'about.creditAnd': 'and',
  'about.creditEnd': '.',

  'error.genericTitle': 'Something went wrong',
  'error.offline': 'You appear to be offline. Check your connection and try again.',
  'error.nameTooLongTitle': 'Name Too Long',
  'error.listNameTooLong': 'List name must be {max} characters or fewer.',
  'error.nameRequiredTitle': 'Name Required',
  'error.listNameRequired': 'Give your list a name before saving.',
  'error.ownOneList':
    'You can only own one list. Leave or delete your current one before creating another.',
  'error.membershipCapCreate':
    'You can be part of at most {cap} lists. Leave one before creating another.',
  'error.membershipCapJoin':
    'You can be part of at most {cap} lists. Leave one before joining another.',
  'error.createListFailed': 'Failed to create list.',
  'error.joinListFailed': 'Failed to join list.',
  'error.inviteCodeInvalid': 'Invite code must be 8 characters, letters and numbers only.',
  'error.noListForCode': 'No list found with that invite code.',
  'error.notificationsBlocked':
    'Notifications are blocked for Bagful in your device or browser settings.',
  'error.notificationsFailed': 'Could not enable notifications. Please try again.',

  'list.meta.toBuy': 'To buy',
  'list.meta.itemCount': { one: '{n} item', other: '{n} items' },
  'list.filteredEmpty.shop': 'Nothing on this list is sold at {shop}.',
  'list.empty.titleShopped': 'All bought',
  'list.empty.titleNew': 'Nothing here yet',
  'list.empty.textShopped': 'Nothing left to pick up.',
  'list.empty.textNew': 'Add the first thing and everyone on the list sees it straight away.',
  'list.buyAgain': 'Buy again',
  'list.addProduct': 'Add {name}',
  'list.buyBar.checkedOut': 'Checked out!',
  'list.buyBar.slide': {
    one: 'Slide to check out {n} item',
    other: 'Slide to check out {n} items',
  },
  'list.buyBar.checkOut': { one: 'Check out {n} item', other: 'Check out {n} items' },

  'item.gotIt': 'Got it',
  'item.uncheck': 'Uncheck',
  'item.remove': 'Remove',
  'item.oneFewer': 'One fewer',
  'item.oneMore': 'One more',
  'item.quantity': 'Quantity {n}',
  'item.quantityDone': 'Quantity {n}. Done',
  'item.quantityChange': 'Quantity {n}. Change',

  'switcher.heading': 'Your lists',

  'filter.shopHeading': 'Shop',
  'filter.shopAny.label': 'Any shop',
  'filter.shopAny.hint': 'Everything, wherever it comes from',

  'add.inputLabel': 'Add an item',
  'add.inputPlaceholder': 'Add an item…',
  'add.scanLabel': 'Scan a barcode',
  'add.submitLabel': 'Add',
  'add.listRecents': 'Products you buy often',
  'add.listSuggestions': 'Product suggestions',
  'add.onYourList': 'on your list',
  'add.addYourOwn': 'Add your own',
  'add.typeToSearch': 'Type a product name to search.',
  'add.shopFilter': 'Filter by shop',
  'add.shopAll': 'All shops',
  'add.announced': '{name} added to your list',

  'custom.message':
    'Describe it and it goes straight on your list. Next time, everyone on the list gets it as a suggestion.',
  'custom.productLabel': 'Product',
  'custom.productPlaceholder': 'Olive Oil 500ml',
  'custom.makerLabel': 'Manufacturer',
  'custom.makerPlaceholder': 'Bertolli',
  'custom.optional': 'optional',
  'custom.barcodeLabel': 'Barcode',
  'custom.barcodePlaceholder': '8 to 14 digits',
  'custom.barcodeNote': 'Saved with the product, so the next scan finds it.',
  'custom.barcodeInvalid': 'A barcode is 8 to 14 digits. Clear the field to skip it.',
  'custom.submit': 'Add to list',

  'scanner.pointCamera': 'Point the camera at a barcode',
  'scanner.starting': 'Starting the camera',
  'scanner.tryAgain': 'Try again',
  'scanner.notInCatalog': 'Not in the catalog',
  'scanner.lookingUp': 'Looking it up',
  'scanner.denied.title': 'Bagful has no camera access',
  'scanner.denied.detail': 'Allow the camera for this app, then try again.',
  'scanner.unavailable.title': "This device can't scan",
  'scanner.unavailable.detail': 'Add the item by name instead.',
  'scanner.error.title': "The camera didn't start",
  'scanner.error.detail': 'Another app may be using it.',
  'scanner.timeout.title': 'The camera never answered',
  'scanner.timeout.detail':
    "If nothing asked for camera access, check Bagful's camera permission in your device settings.",

  'common.save': 'Save',
  'common.saved': 'Saved',
  'common.avatarAlt': '{name} avatar',

  'topbar.history': 'Checkout history',
  'topbar.account': 'Your account',
  'topbar.avatarAlt': 'Your avatar',

  'account.title': 'Account Settings',
  'account.subtitle': 'Manage your profile and preferences',
  'account.close': 'Close account modal',
  'account.editProfile': 'Edit your profile: name, photo, password',
  'account.noEmail': 'No email available',
  'account.manageList': 'Manage list',
  'account.listFallback': 'List',
  'account.memberCount': { one: '{n} member', other: '{n} members' },
  'account.appSettings': 'App settings',
  'account.appSettingsHint': 'Appearance, notifications, language',
  'account.joinOrCreate': 'Join or create a list',
  'account.reportIssue': 'Report an issue',
  'account.reportHint': 'Bugs and feedback',
  'account.signOut': 'Sign out',
  'account.signingOut': 'Signing out',
  'account.confirmSignOutTitle': 'Sign out?',
  'account.confirmSignOutMessage': 'You will need to sign in again to see your lists on this device.',

  'list.title': 'List Settings',
  'list.close': 'Close settings',
  'list.sections': 'Settings sections',
  'list.tab.overview': 'Overview',
  'list.tab.preferences': 'Preferences',
  'list.tab.members': 'Members',
  'list.tab.danger': 'Danger Zone',

  'overview.summary': 'List Summary',
  'overview.name': 'List Name',
  'overview.createdBy': 'Created By',
  'overview.owner': 'Owner',
  'overview.totalMembers': 'Total Members',
  'overview.activeCount': '{n} active',
  'overview.inviteTitle': 'Invite New Members',
  'overview.inviteDesc': 'Share this code so people can join your list.',
  'overview.inviteCode': 'INVITE CODE',
  'overview.copyCode': 'Copy Code',
  'overview.copied': 'Copied!',

  'prefs.title': 'General Preferences',
  'prefs.nameTitle': 'List Name',
  'prefs.nameDesc': 'Choose a name everyone on the list can recognize quickly.',
  'prefs.namePlaceholder': 'Weekly shop',
  'prefs.emojiTitle': 'List Icon',
  'prefs.emojiDesc': 'Pick an icon for your list. It shows in the top bar.',
  'prefs.limitTitle': 'Item Limit Per User',
  'prefs.limitDesc': 'Control how many active (unchecked) items each member can add.',
  'prefs.limitSlider': 'Item limit slider',

  'members.title': 'People on this list ({n})',
  'members.desc': 'Below are the people who have access to this shopping list.',
  'members.you': '(You)',
  'members.openActions': 'Open member actions',
  'members.promote': 'Promote to moderator',
  'members.promoteHint': 'Can manage items and members',
  'members.demote': 'Demote to member',
  'members.demoteHint': 'Removes moderator permissions',
  'members.remove': 'Remove from list',
  'members.removeHint': 'Loses access to this list',
  'members.roleModerator': 'Moderator',
  'members.roleMember': 'Member',
  'members.confirmRemoveTitle': 'Remove Member?',
  'members.confirmRemoveMessage':
    'This person will immediately lose access to this list. They can join again with the invite code.',

  'danger.inviteTitle': 'Invite Code Administration',
  'danger.inviteDesc':
    'Immediately invalidates the current invite code. Existing members are unaffected, but future members must use the new code.',
  'danger.regenerate': 'Regenerate',
  'danger.regenerated': 'Regenerated',
  'danger.leaveTitle': 'Leave List',
  'danger.leaveDesc':
    'This will remove you from the list, and you will no longer have access to it.',
  'danger.deleteTitle': 'Delete List',
  'danger.deleteDesc':
    'Permanently deletes [{name}], removes everyone on it, and erases its items and history. This cannot be undone.',
  'danger.confirmRegenerateTitle': 'Regenerate Invite Code?',
  'danger.confirmRegenerateMessage':
    'This will immediately invalidate the current invite code. Existing members are unaffected, but anyone with the old code will no longer be able to join.',
  'danger.confirmLeaveTitle': 'Leave List?',
  'danger.confirmLeaveMessage':
    'You will lose access to this list and will need a new invite code to rejoin.',
  'danger.confirmDeleteTitle': 'Delete List?',
  'danger.confirmDeleteMessage':
    'Deleting "{name}" will permanently remove everyone on it, its items, and its history. This action cannot be undone.',

  'history.buttonLabel': 'Purchase history',
  'history.title': 'Checkout history',
  'history.subtitle': 'Your recent checkouts',
  'history.close': 'Close history',
  'history.empty': 'No checkouts yet. Items you check out will show up here.',
  'history.you': 'You',
  'history.someone': 'Someone',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',

  'error.roleUpdateFailed': "Could not update that member's role.",
  'error.removeMemberFailed': 'Could not remove that member.',
  'error.regenerateCodeFailed': 'Could not regenerate the invite code. Please try again.',
  'error.leaveListFailed': 'Could not leave the list.',
  'error.deleteListFailed': 'Could not delete the list.',
  'error.renameListFailed': 'Could not rename the list.',
  'error.saveEmojiFailed': 'Could not save the list icon.',
  'error.saveLimitFailed': 'Could not save the item limit.',
  'error.loadHistoryFailed': 'Could not load history. Check your connection and try again.',

  'common.reload': 'Reload',
  'common.copy': 'Copy',

  'crash.text':
    'Bagful hit an error and had to stop. Your list is safe. It lives on the server, not in this page.',

  'notify.title': 'Turn on notifications?',
  'notify.message':
    'Know the moment someone on your list adds something or checks items off, so nothing gets forgotten at the store.',
  'notify.notNow': 'Not now',
  'notify.turnOn': 'Turn on',

  'tour.skip': 'Skip tour',
  'tour.next': 'Next',
  'tour.start': 'Start shopping',
  'tour.inviteCodeLabel': 'Invite code',
  'tour.copyInviteCode': 'Copy invite code {code}',
  'tour.add.title': 'Search for anything',
  'tour.add.body':
    'Start typing and pick from the matching products. One tap and it is on the list.',
  'tour.scan.title': 'Or just scan it',
  'tour.scan.body':
    'With the search box empty, its button opens the camera. Point it at a barcode and the product lands on your list.',
  'tour.qty.title': 'Need more than one?',
  'tour.qty.body':
    'Tap the number on a row to bring up − and +. It closes by itself once you stop.',
  'tour.swipe.title': 'Swipe to check or remove',
  'tour.swipe.body':
    'Swipe a row right once it is in your cart, or left to take it off the list. No small buttons to aim at.',
  'tour.checkout.title': 'Slide to check out',
  'tour.checkout.body':
    'Checked rows wait in the cart until you slide the bar at the bottom. That clears them and saves the trip to your history, so next time your usual items are one tap away.',
  'tour.invite.title': 'Bring your people in',
  'tour.invite.body':
    'Share your invite code so everyone shops from the same list, and every change shows up for all of you instantly. You can keep more than one list and switch between them any time.',

  'common.done': 'Done',
  'common.close': 'Close',
  'common.tryAgain': 'Try again',

  'login.tagline': 'Shared Groceries, [fresh together daily]',
  'login.logoAlt': 'Bagful logo',
  'login.emailLabel': 'Email address',
  'login.emailPlaceholder': 'your@email.com',
  'login.codeHint': 'Enter the 6-digit code sent to',
  'login.codeGroupLabel': '6-digit verification code',
  'login.digitLabel': 'Digit {i} of {n}',
  'login.or': 'or',
  'login.alreadyTitle': "You're already signed in",
  'login.alreadyMessage': 'This device already has an active Bagful session.',
  'login.goToList': 'Go to my list',
  'login.errorTitle': 'Could not sign in',

  'error.oauthFailed': 'Could not sign in with that provider.',
  'error.noEmailCode': 'This account cannot sign in with an email code.',
  'error.generic': 'Something went wrong.',
  'error.verificationIncomplete': 'Verification incomplete. Please try again.',
  'error.invalidCode': 'Invalid code.',

  'offline.title': 'No connection',
  'offline.text':
    "Bagful can't reach the internet right now. Check your connection and your list will load as soon as you're back online.",
  'offline.stillOffline': 'Still no connection. Check your Wi-Fi or mobile data, then try again.',

  'update.availableTitle': 'Update available',
  'update.permissionTitle': 'One permission first',
  'update.readyToInstall': 'Bagful {version} is ready to install.',
  'update.currentVersion': "You're on {version}.",
  'update.permissionMessage':
    'Android only lets an app install updates once you allow it. Turn on [Allow from this source] for Bagful, then come back and press Update.',
  'update.downloadingMessage': 'Downloading Bagful {version}…',
  'update.installingMessage':
    'Android is taking over from here. Follow the install prompt to finish. Your list stays exactly as it is.',
  'update.failedMessage':
    "The update couldn't be downloaded. It may just be the connection. Try again, or get the APK from the releases page.",
  'update.progressLabel': 'Download progress',
  'update.later': 'Later',
  'update.install': 'Update',
  'update.notNow': 'Not now',
  'update.openSettings': 'Open settings',
  'update.downloading': 'Downloading…',
  'update.openReleases': 'Open releases',

  'report.title': 'Report an issue',
  'report.subtitle': 'Goes straight to the developer',
  'report.close': 'Close report',
  'report.sentTitle': 'Report sent',
  'report.sentBody': "Nothing else to do. Reports don't get a reply, but they do get read.",
  'report.kindGroupLabel': 'What kind of report is this?',
  'report.kindBug': "Something's broken",
  'report.kindIdea': 'Something could be better',
  'report.whereLabel': 'Where in the app?',
  'report.promptBug': 'What happened?',
  'report.promptIdea': 'What could be better?',
  'report.placeholderBug':
    'I ticked off milk and it came back on the list when I reopened the app.',
  'report.placeholderIdea': "It's not obvious how to remove someone from the list.",
  'report.charsLeft': '{n} characters left',
  'report.attachedTitle': 'Sent with your report',
  'report.send': 'Send',
  'report.sending': 'Sending',
  'report.failureTitle': 'Report not sent',
  'report.surface.list': 'Shopping list',
  'report.surface.add': 'Adding items',
  'report.surface.scan': 'Barcode scanner',
  'report.surface.history': 'Checkout & history',
  'report.surface.settings': 'List settings & people',
  'report.surface.notifications': 'Notifications',
  'report.surface.signin': 'Signing in',
  'report.surface.other': 'Somewhere else',
  'report.offlineFailure':
    "Nothing was sent because you're offline. Your text is still here, so try again once you're back.",
  'report.sendFailure':
    "Nothing was sent. The report couldn't reach us. Your text is still here, so try again. If it keeps failing, a browser privacy extension may be blocking it.",
  'report.diag.version': 'Bagful {version}, {platform}',
  'report.diag.pendingEdits': 'Has edits waiting to sync',
  'report.diag.ids': 'Your list and account IDs',

  'common.gotIt': 'Got it',

  'error.limitReachedTitle': 'Limit reached',
  'error.limitReached':
    'You reached your limit of {n} active items. Check or delete items before adding more.',
  'error.offlineSyncFailed': 'Some changes made offline could not be synced.',
  'error.loadListsFailed': 'Could not load your lists.',

  'sso.title': 'Almost there',
  'sso.text': 'Taking you back to the Bagful app…',
  'sso.open': 'Open Bagful',

  'setup.hero.avocado': 'Avocado',
  'setup.hero.milk': 'Milk',
  'setup.hero.bread': 'Bread',

  // ── The sweep the lint rule could not do ─────────────────────────────────
  // vue/no-bare-strings-in-template never flagged any of these, and could not
  // have: they came from src/lib modules, which it does not read, and from
  // expressions inside bindings, which it cannot see through. Filed together
  // because that is what they have in common.

  'common.memberFallback': 'Member',
  'account.fallbackName': 'Account',
  'members.sheetLabel': 'Actions for {name}',
  'members.sheetLabelGeneric': 'Actions for this member',
  'preferences.useEmoji': 'Use {emoji} for this list',
  'listIcon.bag': 'bag',
  'listIcon.heart': 'heart',
  'listIcon.star': 'star',
  'listIcon.key': 'key',
  'listIcon.gift': 'gift',
  'listIcon.tea-cup': 'tea cup',
  'listIcon.takeaway-cup': 'coffee to go',
  'listIcon.glass': 'glass',
  'listIcon.boy': 'boy',
  'listIcon.girl': 'girl',
  'listIcon.crown': 'crown',
  'listIcon.sun': 'sun',
  'listIcon.moon': 'moon',
  'listIcon.fire': 'fire',
  'listIcon.trophy': 'trophy',
  'listIcon.medal': 'medal',
  'listIcon.map-pin': 'map pin',
  'listIcon.travel': 'suitcase',
  'listIcon.umbrella': 'umbrella',
  'listIcon.rocket': 'rocket',
  'history.addedBy': 'Added by {name}',
  'history.addedThis': '{name} added this',

  // A list row's whole screen-reader label, written out four times rather than
  // assembled from a verb plus a sentence. "check" and "uncheck" differ by a
  // prefix in English and by clause position in half the other five, so
  // composing them would read as machine translation in exactly the place
  // nobody can see it.
  'item.swipeLabelCheck': '{name}. Swipe right to check, left to remove',
  'item.swipeLabelUncheck': '{name}. Swipe right to uncheck, left to remove',
  'item.swipeLabelCheckQty': '{name}, quantity {n}. Swipe right to check, left to remove',
  'item.swipeLabelUncheckQty': '{name}, quantity {n}. Swipe right to uncheck, left to remove',

  // The invite is read by somebody who may not use Bagful yet, so it is the
  // one message here whose reader is not the person who set the language. It
  // goes in the sender's language anyway: that is the language they are
  // writing the surrounding chat message in.
  'invite.shareTitle': 'Join {name} on Bagful',
  'invite.shareTitleGeneric': 'Join my list on Bagful',
  'invite.shareBody':
    'Join "{name}" on Bagful so we can shop from the same list. Your invite code is {code}.',
  'invite.shareBodyGeneric':
    'Join my list on Bagful so we can shop together. Your invite code is {code}.',
  'invite.shareDialogTitle': 'Invite to Bagful',

  'error.loadListFailed': 'Could not load your list. Please try again.',
  'error.addItemFailed': 'Could not add that item.',
  'error.addItemGeneric': 'Failed to add item.',
  'error.addTooFast': 'You are adding items too quickly. Wait a minute and try again.',
  'error.updateItemFailed': 'Could not update that item.',
  'error.mergeItemsFailed': 'Could not merge those items.',
  'error.deleteItemFailed': 'Could not delete that item.',
  'error.checkoutFailed': 'Could not complete the checkout.',
  'error.itemNameTooLong': 'Item name must be {max} characters or fewer.',
  'error.notificationsFromSettings':
    'Could not enable notifications. You can try again from Account Settings.',
  'common.undo': 'Undo',
  'item.removedToast': 'Removed {name}',
  'sort.buttonLabel': 'Sort and filter',
  'sort.buttonLabelFiltered': 'Sort and filter (filtered)',
  'sort.heading': 'Order',
  'sort.added.label': 'As added',
  'sort.added.hint': 'Newest at the bottom',
  'sort.aisle.label': 'By aisle',
  'sort.aisle.hint': 'In the order you walk the shop',
  'aisle.produce': 'Fruit & veg',
  'aisle.bakery': 'Bakery',
  'aisle.dairy': 'Dairy & eggs',
  'aisle.meat': 'Meat & fish',
  'aisle.prepared': 'Frozen & ready meals',
  'aisle.pantry': 'Pantry',
  'aisle.sweets': 'Sweets & snacks',
  'aisle.drinks': 'Drinks',
  'aisle.household': 'Household',
  'aisle.personal': 'Personal care',
  'aisle.other': 'Other',
  'list.cart.heading': 'In cart',
  'list.meta.allPicked': "Everything's in the cart",
  'list.buyBar.slideHint': 'Slide to finish',
  'add.addTyped': 'Add “{name}”',
  'add.addTypedHint': 'Just as you typed it',
  'add.noteOffline': "You're offline. Showing what you've bought before.",
  'add.noteDegraded': "Couldn't reach every shop. Some products may be missing.",
  'list.roleOwner': 'Owner',
  'list.roleModerator': 'Moderator',
  'list.you': 'You',
  'list.aloneHint': "Just you so far. Invite someone and you'll both see the list change as it happens.",
  'list.open': '{name}: members, invite, switch list',
  'history.searchPlaceholder': 'Did we buy…?',
  'history.noMatch': 'Nothing called “{query}” in your recent trips.',
  'history.addAgain': 'Add {name} to the list again',
  'history.readded': '{name} is back on the list',
  'sync.offline': 'Offline',
  'sync.reconnecting': 'Reconnecting',
  'realtime.checkedOut': { one: "{n} item was checked out on another device", other: "{n} items were checked out on another device" },
  'history.addTrip': 'Add all',
  'history.addTripLabel': { one: "Add the {n} item from this trip to the list again", other: "Add all {n} items from this trip to the list again" },
  'history.tripReadded': 'This trip is back on the list',
  'history.tripReaddedShort': 'Added',
  'list.invite': 'Invite',
  'nav.label': 'Main actions',
  'nav.list': 'List',
  'nav.history': 'History',
  'nav.add': 'Add',
  'nav.addLabel': 'Add an item',
  'nav.you': 'You',
  'nav.switch': 'Switch',
  'nav.switchLabel': 'Switch list',
  'topbar.listSettings': '{name} settings',
  'header.progressLabel': 'How much of the list is in the cart',
}
