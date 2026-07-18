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
