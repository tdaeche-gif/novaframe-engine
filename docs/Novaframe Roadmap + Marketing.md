# Novaframe Platform Roadmap & Marketing Strategy (Solo Studio Model)

## 1. Product & Architecture

Novaframe operates as a **1st-party studio platform**. All wallpapers, shaders, and engine releases are developed and published in-house, with 100% of revenue flowing directly through the platform Stripe account.

### Dual-Free Tier Strategy (Acquisition & Conversion)
- **Pre-Bundled Theme (Breathing Gradient):** Included inside the `.dmg` installer out of the box. Zero friction, zero account needed on first launch. Proves engine stability and low CPU/RAM impact.
- **Showcase Procedural Freebie (Silk Aurora):** Available on `/free` and the store catalog for $0. Demonstrates high-performance 3D GPU WebGL rendering at 60fps. Proves visual horsepower and drives users to create an account and explore the catalog.
- **Engine Bundle Independence:** Keep the installer bundle lightweight. Only Breathing Gradient is pre-packaged; additional free or paid themes are delivered dynamically via the engine's token/download stream.

### Engine Architecture Priorities
- **Privacy & Security:** Telemetry pings send sanitized hardware IDs via POST to the backend API; raw hardware IDs are stripped from browser URLs to prevent leakage into browser history and edge logs.
- **Multi-Monitor & Clamshell Support:** Display reconfiguration hooks dynamically handle MacBook lid closure and external 4K/5K displays without WindowServer desync.
- **Power Optimization:** Automatic pause when occluded and pause on battery mode to preserve MacBook battery life.

---

## 2. Go-To-Market & Growth Playbook

### Visual Content Marketing (TikTok, Reels, YouTube Shorts)
- **Format:** High-aesthetic 10–15s videos featuring dimmed ambient desk setups with Novaframe running on MacBook Pro and external displays.
- **Messaging:** Highlight butter-smooth 60fps motion combined with silent fans and low battery draw.
- **Soundtracks:** Trending lofi, synthwave, ambient soundscapes.

### Community Infiltration (Organic Reddit & Niche Forums)
- **Subreddits:** `r/macsetups`, `r/MacOS`, `r/desktops`.
- **Angle:** Share authentic setup photos and performance benchmarks (0.8–2.1% CPU vs. 12% for video loops).

### Organic SEO Engine
- **Programmatic Pages (pSEO v2):** Covering core procedural themes, aspect ratios (16:9, 21:9 ultrawide, 32:9 super-ultrawide), and display categories.
- **High-Intent Technical Articles:** Benchmarking battery consumption, Rainmeter alternatives on macOS, dual-monitor setup guides, and macOS Sequoia troubleshooting.
