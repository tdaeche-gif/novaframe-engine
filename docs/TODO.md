# Novaframe Engine — TODO

From the 2026-08-04 audit (`docs/AUDIT-2026-08-04.md`). Code fixes are on branch `audit/2026-08-04-fixes`, uncommitted.

Status set 2026-08-05.

---

## ✅ Done

### Migration — engine_releases checksums
`docs/migrations/2026-08-04-engine-releases-checksums.sql` — **run, succeeded.**

`windows_sha256` / `mac_sha256` now exist on `engine_releases`. The release workflow's checksum PATCH will persist from the next tag onward. No further action.

*(If this didn't actually run, say so — the release still succeeds either way, the PATCH is non-fatal, but checksums silently won't be stored.)*

---

## ⏸ Deferred — your call, tracked so it doesn't get lost

### 1. Apple Developer ID + notarization
**Deferred.** Recorded consequence, stated once: unsigned `.dmg` means macOS buyers hit a Gatekeeper block before first launch, and it's the likely cause of item 3 below failing. $99/yr. Steps preserved in `docs/AUDIT-MANUAL-STEPS.md` §1 whenever you pick it up.

### 2. Azure Trusted Signing (Windows)
**Deferred.** Unsigned `.exe` triggers the SmartScreen interstitial. ~$10/mo. Steps in `docs/AUDIT-MANUAL-STEPS.md` §2.

---

## 📋 To do

### 3. Clean-machine auto-update test

**Do this one now anyway, even with signing deferred** — it answers a question you currently can't answer: *is auto-update already broken for the users I have?* A failure here is information, not a blocker.

- [ ] Get a Mac that has never run Novaframe (fresh VM is fine).
- [ ] Download the `.dmg` from the **real Supabase download URL** — not a local build. Local builds are ad-hoc signed and unquarantined, which is exactly why this bug hides in development.
- [ ] Install. Launch. Note whether Gatekeeper blocks it and what the exact wording is.
- [ ] Publish a version bump (patch is fine).
- [ ] On that machine: panel → Check for Updates → download → **Restart to Apply Update**.
- [ ] Confirm it relaunches reporting the new version.
- [ ] **Quit fully, then relaunch from Applications.** This is the step that catches Gatekeeper rejecting the replaced bundle — the update can appear to work and then fail on the *next* launch.

**Expected without signing:** steps 3 and/or 7 fail. If step 7 fails, every user who takes an update today ends up with an app that won't start — which moves items 1 and 2 from "conversion cost" to "actively breaking existing customers."

Re-run this whole checklist after signing lands.

---

### 4. Storefront navigation allowlist

`src-tauri/src/window.rs` — `on_navigation` currently returns `true` for every URL except `novaframe://`. Any link walks the user into an arbitrary page inside a native window titled "Novaframe Marketplace".

I didn't implement this because guessing the redirect hosts breaks checkout, which is worse than the bug.

**What I need from you:**

- [ ] Open the storefront from the engine, sign in, run a full **test-mode** purchase start to finish.
- [ ] Keep the network tab open, filter to document-type requests (top-level navigations only, not XHR).
- [ ] List every host that appears as a top-level navigation.

Likely set, to check against:

| Host | When |
|---|---|
| `novaframe.co.uk`, `www.novaframe.co.uk` | always |
| `checkout.stripe.com` | checkout |
| `hooks.stripe.com` | 3DS / SCA step |
| `<project>.supabase.co` | if auth redirects through it |
| `accounts.google.com` | only if you offer Google sign-in |

- [ ] Send me that list → I implement the allowlist and route everything else to the system browser via `tauri_plugin_opener`.

---

### 5. Windows verification pass

Three changes touch Windows-only paths. I have no Windows machine, so none of these are verified. Same class of failure as the dev-server 403 I hit and fixed on macOS — compile checks don't catch it.

**`theme://` origin check** — highest risk of the three:
- [ ] Launch the engine, confirm wallpapers render (not blank).
- [ ] WebView2 sends a different `Origin` for custom schemes than WKWebView. If wallpapers are blank, this is why.
- [ ] Check `%APPDATA%\com.novaframe.desktop.wallpaper\engine-debug.log` for `403 DENIED (origin not allowed)` — it logs the exact rejected value, which is all I need to fix it. Send me that line.

**`desktop_is_covered` backoff:**
- [ ] Maximize a window → wallpaper pauses within ~1s. Restore → resumes.
- [ ] Leave the desktop untouched a while, then repeat. First transition after an idle stretch may take up to 3s — that's the intended backoff, not a bug.

**Hover proximity backoff:**
- [ ] Mouse to the right screen edge → panel expands. Should feel identical to before.

**Also, while you're there** (covers the `set_focus` removal):
- [ ] Panel dropdowns open and commit a selection.
- [ ] Delete-wallpaper confirm dialog: Enter and Escape both work.

---

## 🔍 Also worth doing at some point

- [ ] **macOS verification pass** — the activation-policy change is unverified by me beyond "app launches". Confirm: no Dock icon, no menu-bar takeover, tray "Show Settings" still focuses the panel, hovering the right edge does **not** steal focus while typing in another app, and fonts render as Outfit **with wifi off** (that's the whole point of self-hosting).
- [ ] **Mouse relay → opt-in.** `themeManager.js` attaches a `mousemove` listener for every theme. I grepped your wallpaper sources: nothing reads `novaframe-pointer` except docs — but I could only see 8 of ~48 themes. Confirm with:
  ```bash
  grep -rl "novaframe-pointer" ~/Novaframe-Wallpapers ~/wallpaper-marketplace
  ```
  If clean, it's a two-line change to gate on `manifest.interactive === true`.
- [ ] **three.js upgrade.** Bundled copy is r13x from 2021, 603 KB, shared by every theme. Multiple breaking API changes since — needs re-testing all 48 wallpapers. Its own project; flagged so it doesn't drift another two years.
- [ ] **rustfmt.** Left advisory in CI (would rewrite ~970 lines). If you want it blocking, do the reformat as one isolated commit first, then drop `continue-on-error` from `.github/workflows/ci.yml`.
- [ ] **Delete `GeochronEngine.dmg`** from the repo root — 8.9 MB, untracked, named after the old product.

---

## Branch state

`audit/2026-08-04-fixes` — 22 files, uncommitted.

Verified: `cargo clippy --all-targets -- -D warnings` clean · 9/9 tests pass · bundle builds · app ran live on macOS (55 themes scanned, active theme rendering, 0 protocol denials).

Not verified: anything Windows-only (item 5), and the macOS UX changes beyond "it launches".
