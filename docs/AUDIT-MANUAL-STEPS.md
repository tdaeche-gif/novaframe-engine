# Manual steps — audit 2026-08-04

Everything I could implement is on branch `audit/2026-08-04-fixes`. This file is only the work that needs your accounts, your money, your hardware, or a decision I shouldn't make for you.

Ordered by what costs you most to leave undone.

---

## 1. Code signing — macOS  ⚠️ blocks the next release

**Why:** unsigned + un-notarized `.dmg` means every macOS buyer hits a Gatekeeper block, and it very likely breaks auto-update for anyone already installed (Gatekeeper re-evaluates the replaced bundle). This does not reproduce locally — dev builds are ad-hoc signed and never quarantined.

**Cost:** $99/year (Apple Developer Program).

**Steps:**

1. Enrol at <https://developer.apple.com/programs/> if you haven't. Takes 24–48h to approve.
2. In Xcode → Settings → Accounts → Manage Certificates → **+** → **Developer ID Application**.
3. Open Keychain Access, find `Developer ID Application: <your name> (<TEAMID>)`, right-click → Export → `.p12`, set a password.
4. Base64 it:
   ```bash
   base64 -i certificate.p12 | pbcopy
   ```
5. Create an app-specific password at <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords. This is **not** your Apple ID password.
6. Add these GitHub secrets at `Settings → Secrets and variables → Actions`:

   | Secret | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | the base64 blob from step 4 |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password from step 3 |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <your name> (<TEAMID>)` |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_PASSWORD` | the app-specific password from step 5 |
   | `APPLE_TEAM_ID` | your 10-character Team ID |

7. Add them to the `build tauri app` step's `env:` block in `.github/workflows/release.yml`. `tauri-action` notarizes automatically once `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` are all present.

**Verify — do not skip this:**

```bash
spctl -a -vvv -t install /Applications/Novaframe.app
```

Must print `accepted` and `source=Notarized Developer ID`. Test on a Mac that has never run the app, using the `.dmg` downloaded from the real Supabase URL (not a local build).

---

## 2. Code signing — Windows

**Why:** unsigned `.exe` triggers the full-screen SmartScreen interstitial where "Run anyway" is hidden behind "More info".

**Cost:** ~$10/month. Azure Trusted Signing is the cheap path — no hardware token, no EV certificate purchase, and unlike a fresh OV cert it does not need to accumulate SmartScreen reputation.

**Steps:**

1. Azure Portal → create a **Trusted Signing** account (needs a verified business or individual identity; individual verification is possible and takes a few days).
2. Create a Certificate Profile under that account.
3. Create a service principal with the **Trusted Signing Certificate Profile Signer** role.
4. Add `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` as GitHub secrets.
5. Add a `signCommand` to `bundle.windows` in `src-tauri/tauri.conf.json` pointing at the Trusted Signing CLI.

**Verify:** right-click the `.exe` → Properties → Digital Signatures tab shows a valid signature, and running it produces no SmartScreen interstitial.

---

## 3. Auto-update end-to-end test  ⚠️ do this immediately after signing

Signing is what makes this work, so test it right after, before shipping anything else.

1. Build and publish version N with signing enabled.
2. On a **clean** Mac (fresh VM or a machine that has never had Novaframe), download the `.dmg` from the real Supabase download URL. Install. Launch.
3. Publish version N+1.
4. On that same machine: open the panel → Check for Updates → let it download → click **Restart to Apply Update**.
5. Confirm the app relaunches and reports N+1.
6. Quit fully and relaunch from the Applications folder — this is the step that catches a Gatekeeper rejection of the replaced bundle.

If step 6 fails, the signing configuration is wrong. Do not tag another release until it passes.

---

## 4. Run the Supabase migration

```bash
docs/migrations/2026-08-04-engine-releases-checksums.sql
```

Adds nullable `windows_sha256` / `mac_sha256` columns to `engine_releases`. Per your rules I have not run this — apply it yourself via the Supabase SQL editor.

**Not blocking.** The release workflow computes checksums either way and the PATCH that writes them is deliberately non-fatal, so a release still succeeds if this hasn't run. Until it does, checksums appear in CI logs but aren't persisted.

---

## 5. Storefront navigation allowlist (B2)

**Why:** `src-tauri/src/window.rs`'s `on_navigation` currently returns `true` for every URL except `novaframe://`. Any link walks the user into an arbitrary page inside a native window titled "Novaframe Marketplace" — a strong phishing surface, and how an attacker origin would get into position to read `theme://` assets.

**Why I didn't do it:** I'd have to guess which third-party hosts your checkout and sign-in legitimately redirect through. Guess wrong and purchases break — worse than the bug.

**What I need from you:** the actual redirect chain. Open the storefront, sign in, and run a full test-mode purchase with the network tab open, then list every host that appears as a top-level navigation. Typically:

- `novaframe.co.uk`, `www.novaframe.co.uk`
- `checkout.stripe.com` (and possibly `hooks.stripe.com` for 3DS)
- `<project>.supabase.co` if auth redirects through it
- `accounts.google.com` if you offer Google sign-in

Send me that list and I'll implement the allowlist, routing everything else to the system browser via `tauri_plugin_opener`.

---

## 6. Windows verification pass

Three changes touch Windows-only code paths and I have no Windows machine:

| Change | What to check |
|---|---|
| `theme://` origin check (B1) | Themes still load. WebView2 sends different `Origin` values for custom schemes than WKWebView — if wallpapers render blank, this is the cause. Check `engine-debug.log` for `403 DENIED (origin not allowed)`, which logs the exact rejected value. |
| `desktop_is_covered` backoff (C3) | Maximize a window → wallpaper pauses within ~1s. Restore → resumes. Then leave it stable a while and repeat: first transition after an idle period may take up to 3s, which is expected. |
| Hover proximity backoff (C4) | Move the mouse to the right screen edge → panel expands promptly. It should feel identical to before. |

Also confirm the settings panel's dropdowns still open and commit a selection — that exercises the `set_focus` removal (B6).

---

## 7. macOS verification pass

The activation-policy change (B6) is the one to look at:

- **No Dock icon** for Novaframe, and no menu-bar takeover when the panel opens.
- Tray icon still present; **Show Settings** from it still opens and focuses the panel.
- Hovering the right screen edge expands the panel **without** stealing focus — test by typing in another app while brushing the edge.
- Panel dropdowns and the colour picker still open and commit.
- Fonts render as Outfit, not a fallback. Test with wifi **off** — that's the whole point of self-hosting.

---

## 8. Decision — make the mouse relay opt-in (D5)

`themeManager.js` attaches a `mousemove` listener for every theme, though the header claimed it only did so for interactive ones. I grepped your wallpaper sources: nothing reads `novaframe-pointer` except documentation. But I could only see 8 of ~48 themes locally, so I left the behaviour alone rather than risk silently breaking one.

**If you confirm no shipped theme consumes pointer messages**, the change is two lines: gate the `enableMouseRelay()` call in `themeManager.js` on `manifest.interactive === true`, and add that flag to any theme that does need it.

```bash
grep -rl "novaframe-pointer" ~/Novaframe-Wallpapers ~/wallpaper-marketplace
```

---

## 9. Backlog — not urgent

- **three.js upgrade (D7).** Bundled copy is r13x from 2021, 603 KB, shared by every theme. Multiple breaking API changes since; upgrading means re-testing all 48 wallpapers. Schedule as its own project — flagged so it doesn't drift another two years.
- **rustfmt.** Left advisory in CI. Running it would rewrite ~970 lines; if you want it blocking, do the reformat as one isolated commit first, then flip `continue-on-error`.
- **`GeochronEngine.dmg`** (8.9 MB) in the repo root. Untracked, stale, named after the old product. Delete when convenient.
