# Agent Instructions

Read the modular rules in  before writing code:

- @.agents/rules/00-identity.md

- @.agents/rules/01-ponytail.md

- @.agents/rules/10-stack.md

- @.agents/rules/20-engine.md

- @.agents/rules/40-graphify.md

Refer to repo-specific rules in  for architecture, compliance, and security bounds.

---

# NovaframeEngine — Tauri v2 desktop wallpaper engine (GeochronEngine)

Desktop client of the Novaframe product (see `~/wallpaper-marketplace` + `~/marketplace-backend`).

## Stack
Tauri v2 (Rust in `src-tauri/`) · frontend in `src/` · plugins: fs, store, updater · themes in `themes/`

## Commands
- `npm run tauri dev` — run app
- `npm run tauri build` — produces .dmg; `cargo-wrapper.sh` wraps cargo when needed

## Rules
- **Updater signing keys are sacred.** Never regenerate, print, or commit private keys (`generate_keys.exp` exists for setup only). Breaking the key chain bricks auto-update for existing users.
- Rust changes: keep `src-tauri` warnings clean; run `cargo check` before claiming done.
- Distribution/update flow: `PLAN-engine-distribution-and-updates.md`. Settings work: `PLAN-settings-final-touches.md`, `PLAN-wallpaper-settings-and-asset-fixes.md`.
- DRM/device locking must match `~/marketplace-backend/PLAN-drm-device-locking.md`.

## Settings Panel UI & Layout Rules
- **Header Layout**: `.panel-header` must align 22px Logo + 14px "Novaframe Engine" title (`#ffffff`, `white-space: nowrap`) + 24px Red X button on 1 single row.
- **Control Labels**: All labels (`Active Theme`, `Theme Settings`, custom controls) MUST use high-contrast solid white `#ffffff` (13px, `font-weight: 600`).
- **System Toggles**: Group "Rotate wallpapers", "Launch on startup", and "Pause on battery" inside `.system-toggles-group` with `10px` row gaps. Do NOT place `<hr>` dividers between individual toggles.
- **Section Dividers**: Standardized `<hr class="section-divider">` with `margin: 12px 0` and `background: rgba(255, 255, 255, 0.08)`.




---

## Anti-Bloat & Ponytail Guidelines (Lazy Senior Dev Mode)
- **Ruthless Minimalism (YAGNI):** The best code is code never written. Before writing code, climb the Ponytail ladder:
  1. Does this need to be built at all? (Eliminate speculative abstractions, unused configs, dead wrappers).
  2. Does it already exist in this codebase? Reuse existing helpers, utils, and patterns.
  3. Does the standard library already cover this? Use it.
  4. Does an installed dependency or native platform API solve it? Use it.
  5. Can this be a single pure function rather than a class? Keep it flat.
  6. Only then: write the minimum code that works.
- **Zero Phantom Code:** Never write helper functions, classes, models, or configurations without immediate, active callers.
- **Shortest Working Diff:** Deletion over addition. Boring over clever. Fewest files and fewest lines possible while maintaining strict data integrity and error handling.
- **Non-Negotiables:** Never compromise security, input validation at trust boundaries, or error handling that prevents data loss.
