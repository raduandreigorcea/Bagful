# Builds the NIGHTLY Android APK: web build -> capacitor sync -> gradle.
# Run via `npm run build:apk`.
#
# WHY THIS COMMAND ONLY EVER BUILDS NIGHTLY
#
# Production APKs come from .github/workflows/release-apk.yml and nowhere else.
# That workflow is the only place holding the production secrets, checks that
# the version moved, and signs with the key every installed Bagful was signed
# with. A laptop that can also produce a production APK is a second, unchecked
# route to the thing people install -- and the mistake it invites is silent: an
# APK that looks right, is signed right, and quietly carries whatever was in
# this machine's env files.
#
# So this builds the second app instead: Bagful Nightly, application id
# com.bagful.app.nightly, pointed at famcart-dev. It installs BESIDE the real
# app rather than over it, so the phone you shop with keeps working while you
# test on the same device.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# Gradle needs a JDK; Android Studio ships one. Respect an existing JAVA_HOME.
if (-not $env:JAVA_HOME) {
  $studioJbr = 'C:\Program Files\Android\Android Studio\jbr'
  if (Test-Path "$studioJbr\bin\java.exe") {
    $env:JAVA_HOME = $studioJbr
  } else {
    Write-Error 'No JAVA_HOME set and Android Studio JDK not found. Install Android Studio or set JAVA_HOME.'
  }
}

# THE DEV CREDENTIALS COME FROM THE FILE `npm run dev` ALREADY USES
#
# .env.development.local is only read by Vite in development mode, and this is a
# production-mode build, so its values have to be carried in by hand. Reading
# that same file rather than introducing a .env.nightly is deliberate: two files
# holding the same credentials drift, and the one that drifts is always the one
# nobody opens.
#
# Vite gives a VITE_ variable found in the environment precedence over every
# .env file (see loadEnv), which is what lets these win over the production
# values sitting in .env without that file being touched.
$devEnvFile = Join-Path $root '.env.development.local'
if (-not (Test-Path $devEnvFile)) {
  Write-Error "No .env.development.local in $root. It holds the famcart-dev credentials this build needs; without it the APK would be built against the production database."
}

Get-Content $devEnvFile | ForEach-Object {
  # KEY=VALUE, skipping comments and blanks. Values in this file are unquoted;
  # a quoted one would arrive with its quotes still attached.
  if ($_ -match '^\s*(VITE_[A-Za-z0-9_]+)\s*=\s*(.*)$') {
    Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2].Trim()
  }
}

$env:VITE_APP_CHANNEL = 'nightly'

# THE GUARD THAT MAKES THE ABOVE MEAN SOMETHING
#
# Everything so far is a convention: a file that could be missing a key, a
# regex, an env var that could be overridden by the shell. This is the check
# that a nightly build cannot be talking to production, and it is worth having
# because the failure it prevents is invisible -- a purple app, badged NIGHTLY,
# writing to real lists.
$productionProjectRef = 'qwpyiperbjaeykrvilhf'
if (-not $env:VITE_SUPABASE_URL) {
  Write-Error 'VITE_SUPABASE_URL is not set after reading .env.development.local. Add the famcart-dev URL to that file.'
}
if ($env:VITE_SUPABASE_URL -like "*$productionProjectRef*") {
  Write-Error "VITE_SUPABASE_URL points at the production project ($productionProjectRef). A nightly build must not. Check .env.development.local."
}

Write-Host "Building nightly against $env:VITE_SUPABASE_URL"

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# assembleNightlyRelease, not assembleRelease: with two product flavours the
# latter builds both, and the production one built from this machine is exactly
# what the note at the top of this file is about.
#
# Release rather than debug so a local build is the same shape as the published
# one: not debuggable, and signed with the release key if FAMCART_KEYSTORE_FILE
# and its three companions are set in this shell. Without them the build falls
# back to the debug key (see android/app/build.gradle) -- fine here, since a
# nightly APK is only ever installed by hand, but it does mean a nightly built
# on another machine will not install over this one.
Set-Location (Join-Path $root 'android')
.\gradlew.bat assembleNightlyRelease
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apk = Join-Path $root 'android\app\build\outputs\apk\nightly\release\app-nightly-release.apk'
Write-Host ''
Write-Host "Nightly APK ready: $apk"
Write-Host 'Installs as "Bagful Nightly", alongside the production app.'
