# Engine & Tauri Rules
- CRITICAL: Updater signing keys (`generate_keys.exp`) are SACRED. Never regenerate, inspect, or commit private keys. Breaking key continuity bricks auto-updates for all active installations.
- UI Layout: Single-row `.panel-header` (Logo + Title + Red X). Labels in `#ffffff` (13px, font-weight: 600). System toggles inside `.system-toggles-group` with 10px row gaps (no `<hr>` dividers between toggles).
