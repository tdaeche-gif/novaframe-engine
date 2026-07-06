# Engine Distribution & Auto-Updates — Plan

Goal: a new user can go from "click Download" to "engine running with a working
default view" in under two minutes, with zero manual steps (no dependency
installs, no config editing, no picking the right installer). Once installed,
both the **engine app itself** and **installed wallpaper themes** should update
themselves with minimal friction.

This plan does not implement anything yet — it's the roadmap for 3.1 (engine
distribution) and 3.3 (content auto-updates), plus fixes to auto-update
plumbing for the engine binary that already exists but is broken.

## Audit: what already exists (better starting point than expected)

- The Tauri **updater plugin** is registered and permissioned
  (`src-tauri/src/main.rs:428`, `capabilities/desktop.json`), with a signing
  pubkey already baked into `tauri.conf.json`.
- A manual **"Check for Updates" button** in the settings panel
  (`src/app.js:1087-1130`) calls `updater.check()` and does a full
  download-and-install with a progress readout. This works today — it's just
  not automatic and depends on a working release pipeline (see below).
- A backend endpoint, `GET /api/engine/updates/[target]/[current_version]`
  ([route.ts](../marketplace-backend/src/app/api/engine/updates/%5Btarget%5D/%5Bcurrent_version%5D/route.ts)),
  already reads the latest GitHub Release, picks the right asset per platform,
  and returns the `{version, url, signature}` payload the updater plugin expects.
- A GitHub Actions release workflow (`.github/workflows/release.yml`) builds on
  tag push using `tauri-apps/tauri-action`.
- First-run experience already has a sane fallback: `ThemeManager.loadTheme()`
  with no saved theme renders a built-in legacy view, so the app is never
  blank on first launch — it just has no premium themes installed yet (that's
  what 3.4, the free trial theme, is for).

## Audit: what's broken or missing in the pipeline

These block auto-updates today, independent of any new work in this plan:

1. **`releaseDraft: true`** in `release.yml` — GitHub drafts don't appear via
   the public `releases/latest` API. The backend's updates endpoint queries
   exactly that API, so it will always see nothing, and any "download latest"
   link on the storefront would also come up empty. **Fix: set to `false`,**
   or add a "publish release" step gated on a manual approval if you want a
   review step before going live.
2. **No signing secrets wired into CI.** `release.yml` never sets
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without
   them, `tauri-action` can't produce the `.sig` files the updater needs, even
   once artifacts are generated.
3. **`bundle.createUpdaterArtifacts` is missing** from `tauri.conf.json`. In
   Tauri v2 this must be `true` (or `"v1Compatible"`) or the bundler won't
   produce updater-compatible archives (`.nsis.zip`, `.app.tar.gz`) at all —
   you'd get plain installers with no matching `.sig`.
4. **CI only builds `windows-latest`.** `bundle.targets: "all"` and the
   updates route already branch on `target.includes('darwin')`, but nothing
   builds a macOS artifact. A `GeochronEngine.dmg` existed in the repo
   (removed from git tracking in Phase 2 cleanup) — implying a macOS build was
   done manually outside CI at some point. **Decision made: build both
   platforms, ship Mac unsigned for now** — see Decisions section for why
   that works and what the one-time Gatekeeper step costs users.
5. ~~**The `geochron-wallpaper` GitHub repo appears private**~~ — **RESOLVED:
   repo is now public**, so the backend's updates route can read releases
   with no token. (A repo rename to "Novaframe Engine" is planned — see
   Part D for doing that without breaking this route.)
6. **Update checks are manual-button-only.** There's no check on app launch or
   on an interval — a user has to know the button exists and click it.
7. **No public download page exists.** There's no "Download Novaframe Engine"
   link anywhere in `wallpaper-marketplace` yet, and nothing points at a
   specific installer for the user's OS.

None of this needs new architecture — it's finishing wiring that's already
mostly in place. Recommend fixing all seven before building anything new in
this plan, since content auto-updates (3.3) will reuse the same signing/release
discipline.

## Decisions (locked in 2026-07-06)

1. **Platforms: Windows AND macOS, both from day one.**

   On the "is Mac possible like how I run it now (`npm run tauri dev`)"
   question — yes, and it's important to separate the two things going on:

   - Your current Mac setup works because *you built it yourself*. macOS
     Gatekeeper only blocks apps downloaded from the internet (they get a
     "quarantine" flag from the browser); anything compiled locally runs
     freely. So dev mode proves the app itself is fully Mac-capable — the
     only obstacle is distribution, not the code.
   - **An unsigned Mac build from CI is possible and free** — CI just runs the
     same build you run locally and uploads the `.dmg`/`.app.tar.gz`. The
     catch is the recipient's first launch: because *their* copy came from a
     browser download, Gatekeeper flags it, and on current macOS versions the
     user must go to System Settings → Privacy & Security → "Open Anyway"
     once (right-click → Open no longer suffices on macOS 15+). One-time,
     ~20 seconds, but it looks scary to non-technical users ("Apple could not
     verify this app is free of malware").
   - **Auto-updates still work on an unsigned Mac app** — the Tauri updater
     verifies our own minisign signature (the pubkey already in
     `tauri.conf.json`), not Apple's, and files the app downloads itself
     don't get the browser quarantine flag. So the Gatekeeper friction is
     first-install only, never on updates.
   - **Signed + notarized ($99/yr Apple Developer Program)** removes the
     first-install warning entirely.

   **Approach: ship unsigned Mac builds now** (with a short "Open Anyway"
   note next to the Mac download button), **and treat notarization as a
   drop-in upgrade later** — it's only CI secrets + a cert, zero code changes,
   and existing installs are unaffected when it lands.

2. **Update cadence: automatic check every 24 hours, plus the existing
   manual "Check for Updates" button.** First automatic check runs shortly
   after launch (~1 min delay so startup isn't slowed), then every 24h while
   running.

3. **Auto-install flow: when the automatic check finds an update, download
   and install it immediately, then prompt "Restart to update".** The engine
   swaps to the new version on that restart (or the next natural app
   restart, whichever comes first). The manual button keeps its current
   click-through progress UI.

4. **Repo: now public** ✅ (unblocks audit item 5 — the backend's updates
   endpoint can read releases without a token). A rename to "Novaframe
   Engine" is wanted ASAP — handled as Part D below so it can't break the
   pipeline.

## Plan — Part A: fix the engine binary update pipeline (prerequisite)

Each step is independent and testable.

1. **`release.yml`:** set `releaseDraft: false`. Add
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the
   `env:` block, sourced from repo secrets (the private key half of the
   pubkey already in `tauri.conf.json` — if that key was never saved, a new
   keypair needs generating via `tauri signer generate`, which means
   re-pointing `tauri.conf.json`'s `pubkey` too and invalidating any
   already-shipped installs' ability to verify old updates — low risk since
   nothing has auto-updated successfully yet).
2. **`tauri.conf.json`:** add `"createUpdaterArtifacts": true` under `bundle`.
3. **`release.yml`: add macOS to the build matrix.** Change the matrix to
   `platform: [windows-latest, macos-latest]`, with `--target
   universal-apple-darwin` args on the mac leg (one artifact covering both
   Apple Silicon and Intel; requires adding both Rust targets via
   `rust-toolchain`'s `targets:` input). No Apple signing secrets for now —
   builds ship unsigned per decision 1; when notarization lands later it's
   just extra `APPLE_*` env vars on this same step.
4. **Backend repo access:** ~~public vs token~~ — resolved, repo is public.
   No route change needed until the Part D rename.
5. **Verify end-to-end:** push a test tag (e.g. `app-v0.1.1`), confirm the
   Actions run produces signed updater artifacts for BOTH platforms
   (`.nsis.zip` + `.sig`, `.app.tar.gz` + `.sig`) on a published release,
   then hit the updates endpoint directly for each target
   (`curl https://api.novaframe.co.uk/api/engine/updates/windows-x86_64/0.1.0`
   and `.../darwin-aarch64/0.1.0`) and confirm each returns a
   `{version, url, signature}` payload instead of 204.
6. **Manual test:** install the previous version on a real machine (one per
   OS), click "Check for Updates," confirm it downloads and restarts into
   the new version. On the Mac, also confirm the first browser-downloaded
   install opens after "Open Anyway" and that the subsequent auto-update
   applies with no Gatekeeper prompt.
7. **24h auto-check + restart prompt (decisions 2–3):** in `app.js`, extract
   the existing button handler's check/download logic into a reusable
   `checkAndInstallUpdate({ silent })`. On startup, `setTimeout(~60s)` then
   `setInterval(24h)` calling it with `silent: true`: no UI until an update
   is found; when found, download + install in the background, then show a
   small non-blocking banner in the settings panel — "Update ready, restart
   to apply" with a Restart button (`relaunch()` from
   `@tauri-apps/plugin-process`, or plain `process.exit` + OS relaunch if the
   plugin isn't present — check `Cargo.toml`; add `tauri-plugin-process` if
   missing). The manual button keeps its existing verbose progress flow.

## Plan — Part B: frictionless first-download (3.1)

1. **Storage:** create a Supabase bucket `engine-releases` (public-read,
   per the decision already made). This is for the **installer** the very
   first download link points at — GitHub Releases remains the source of
   truth for auto-updates (Part A), Supabase is just a stable, branded URL
   for first-time downloads that doesn't require understanding GitHub's UI.
2. **Sync step in `release.yml`:** after a successful release build, add a
   step that uploads the latest Windows installer AND the macOS `.dmg` to
   `engine-releases/latest/` in Supabase, overwriting the previous
   files. Use the Supabase REST API with a service-role key stored as a GitHub
   secret. This keeps "download the latest engine" a single stable URL
   (`https://<project>.supabase.co/storage/v1/object/public/engine-releases/latest/NovaframeEngine-Setup.exe`)
   that never changes between versions — nothing on the storefront needs to
   know the current version number.
3. **Storefront: "Download Novaframe Engine" button.** Add to
   [vault/page.tsx](../wallpaper-marketplace/src/app/(storefront)/vault/page.tsx),
   pointing at the stable Supabase URL from step 2. Detect the visitor's OS
   via `navigator.userAgent` (or `navigator.platform`) client-side and label
   the button accordingly ("Download for Windows" / "Download for Mac"),
   falling back to a neutral "Download Novaframe Engine" with both links
   listed if OS detection is inconclusive. Next to the Mac link, show a
   one-line note: "First launch: System Settings → Privacy & Security →
   Open Anyway (one time only)" — needed until builds are notarized
   (decision 1); remove the note when that lands.
4. **Product-page banner.** On any wallpaper page where `requires_engine =
   true`, show the existing amber "Requires Novaframe Engine" notice (already
   built — see [ProductClient.tsx](../wallpaper-marketplace/src/app/(storefront)/product/ProductClient.tsx))
   with a direct download link added, so a user who lands on a themed
   wallpaper via a shared link isn't stuck if they don't have the engine yet.
5. **First-run zero-setup:** confirmed already true — a fresh install renders
   the built-in legacy globe immediately, no config needed. The only
   "friction" left post-install is getting the user's *first* premium theme,
   which is exactly what 3.4 (free trial theme) solves — recommend building
   3.4 in the same pass as this, since a working install with zero themes to
   try feels incomplete even though it isn't broken.
6. **Installer UX (Windows):** confirm the NSIS installer (Tauri's default)
   doesn't ask any per-dependency questions — it shouldn't, since Tauri
   bundles the WebView2 runtime bootstrapper automatically on Windows and
   installs it silently if missing. No manual step needed here, just a
   verification pass on a clean VM/user account without WebView2 preinstalled.

## Plan — Part C: auto-updates for installed wallpaper themes (3.3)

This is separate from the engine binary updater (Part A/B) — it updates the
*content* (theme zips) a user has already installed, not the app itself.

1. **Schema:** no new table needed — `wallpapers.engine_manifest` already
   carries a `version` field (seen in `verify-token`'s response).
2. **Backend: new `POST /api/engine/check-theme-updates`.** Body:
   `{ installed: { [themeId]: version } }` (the engine's local manifest
   versions). Response: array of `{ themeId, latestVersion, downloadUrl }`
   for any theme where `latestVersion !== installedVersion`. Requires the
   same ownership check pattern as `inventory` (Engine API key in
   `Authorization` header) — a user shouldn't be able to probe version info
   for themes they don't own, though version numbers alone are low-sensitivity.
3. **Engine: on launch (and after `scanThemes()`),** read each installed
   theme's local `manifest.json` version, POST the map to
   `check-theme-updates`, and store the result in memory.
4. **Settings panel UI:** small "Update available" badge per theme in the
   theme selector, reusing the existing `download_and_install_theme` Rust
   command — a click re-downloads and overwrites the theme folder in place
   (same command already does directory creation/renaming per
   `PLAN-wallpaper-settings-and-asset-fixes.md`'s prior fixes).
5. **Silent vs. prompted:** recommend prompted-by-badge for themes (unlike
   the engine binary auto-download recommendation in question 3 above) —
   theme updates change visual behavior a user is actively looking at, so a
   silent swap could be jarring mid-session. A visible "Update available,
   click to install" badge is the friendlier default here.

## Plan — Part D: rename repo to "Novaframe Engine" without breaking anything

Wanted ASAP. GitHub makes this nearly safe by default — renaming a repo sets
up permanent redirects for web URLs, `git` remotes, AND REST API calls to the
old name. So nothing breaks the moment you rename. But redirects die the
instant anyone creates a *new* repo named `geochron-wallpaper` under your
account, so treat them as a grace period, not a permanent solution. Do the
rename in this order:

1. **GitHub:** repo Settings → rename `geochron-wallpaper` → `novaframe-engine`
   (kebab-case is the GitHub convention; display name "Novaframe Engine" goes
   in the repo description). Everything keeps working via redirects.
2. **Backend, same day:** update the hardcoded URL in
   [updates/[target]/[current_version]/route.ts](../marketplace-backend/src/app/api/engine/updates/%5Btarget%5D/%5Bcurrent_version%5D/route.ts)
   from `tdaeche-gif/geochron-wallpaper` to `tdaeche-gif/novaframe-engine`.
   This is the ONLY code reference to the repo name outside the repo itself
   (verified by grep across all three projects). It works via redirect even
   before this change, so there is zero downtime — this just stops relying
   on the redirect.
3. **Local remote:** `git remote set-url origin
   https://github.com/tdaeche-gif/novaframe-engine.git` on this machine.
4. **Installed engines are unaffected:** the updater endpoint baked into
   shipped `tauri.conf.json` points at `marketplace-backend-gamma.vercel.app`
   (our API), not GitHub — the GitHub URL only lives server-side in step 2's
   route, so old installs keep updating fine. (Separately, consider migrating
   that endpoint to `api.novaframe.co.uk` in the next release so shipped
   configs stop referencing a Vercel-internal hostname — cosmetic, not
   urgent, and old installs would still work via the Vercel domain
   regardless.)
5. **Don't** create any new repo under the old name, ever — that kills the
   redirects for anything missed.

Also worth renaming at the same time (cosmetic, zero pipeline impact):
`releaseName: 'Geochron Engine v__VERSION__'` in `release.yml` →
`'Novaframe Engine v__VERSION__'`, and the local folder is already
`NovaframeEngine`.

## Priority / value / risk checklist

| # | Task | Priority | Value | Effort | Risk |
|---|---|---|---|---|---|
| D.1–D.3 | Repo rename to `novaframe-engine` (+ backend URL, local remote) | **P0** | Medium — wanted ASAP; cheapest right now, cost grows with every new reference | XS | Low — GitHub redirects cover any missed reference |
| A.1–A.3 | Fix release pipeline (draft flag, signing secrets, artifact flag, add macOS to matrix) | **P0** | Very high — nothing else in this plan works without it | S | Low — config-only changes, testable via a throwaway tag push |
| A.5–A.6 | Verify pipeline end-to-end, both platforms | P0 | High — confirms the fix actually works | S | Low (Mac "Open Anyway" check needs a physical Mac — you have one) |
| A.7 | 24h auto-check + auto-install + "Restart to update" banner | P1 | High — decisions 2–3; makes updates actually reach users | S-M | Low-Medium — restart plumbing may need `tauri-plugin-process` added |
| B.1–B.2 | Supabase `engine-releases` bucket + CI sync step (Win + Mac artifacts) | P1 | High — stable branded download URL | S | Low |
| B.3 | Storefront download button, OS-detected, with Mac "Open Anyway" note | P1 | Very high — this is the actual "frictionless download" ask | S | Low |
| B.4 | Product-page download banner | P1 | Medium — catches users arriving via shared links | XS | Low |
| B.6 | Verify WebView2 bootstrap on clean machine | P1 | Medium — confirms zero-dependency claim | XS | Low |
| 3.4 (existing) | Free trial theme, bundled with this pass | P1 | High — makes first-run feel complete, not just "not broken" | S | Low |
| C.1–C.4 | Theme auto-update check + UI badge | P2 | Medium — retention, keeps published content current | M | Low-Medium (touches install path already fixed once before) |
| macOS notarization upgrade | P2 | Medium — removes the one remaining Mac friction ("Open Anyway") | S (plus $99/yr + cert setup) | Medium — notarization failures are fiddly to debug first time; drop-in when ready, no code changes |

**Recommended sequencing:** Part D first (rename is cheapest *right now* —
every week of delay adds references to migrate, and it's a 15-minute job with
redirects as a safety net). Then Part A including the 24h auto-update flow,
then B.1–B.4 + 3.4 together as one release (that's the actual "frictionless
onboarding" deliverable), then C (content updates) once the binary-update path
has been proven live for at least one real release cycle. Notarization slots
in whenever Apple Developer enrollment happens — nothing waits on it.
