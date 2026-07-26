/*
 * novaframe-wallpaper.js — shared runtime for Novaframe wallpapers.
 *
 * Zero dependencies. Loads as a plain script and attaches a global:
 *   <script src="./novaframe-wallpaper.js"></script>
 *   <script>
 *     const wp = NovaframeWallpaper.createWallpaper({ ... });
 *     wp.start();
 *   </script>
 *
 * It owns the pieces every theme used to hand-roll (and often got wrong):
 *   - a frame-rate-capped requestAnimationFrame loop
 *   - HARD pause when the wallpaper is hidden/occluded (document.hidden OR the
 *     engine's `novaframe-occlusion` message) — loop fully stops, ~0 cost
 *   - `novaframe-settings` message plumbing
 *   - resize + devicePixelRatio (clamped) handling, incl. the engine's
 *     `novaframe-theme-ready` / `novaframe-theme-resize` viewport messages
 *   - `?preview=true` handling (lower fps for marketplace thumbnails)
 *
 * The engine already broadcasts all of the above messages into the theme
 * iframe — this just makes every theme consume them the same, correct way.
 *
 * Callbacks (all optional):
 *   onResize({ width, height, dpr })      — size your canvases here
 *   onFrame({ now, dt, frame, width, height, dpr, preview })  — draw one frame
 *   onSettings(settings)                  — a novaframe-settings payload
 */
(function (global) {
  'use strict';

  function createWallpaper(options) {
    var opts = options || {};
    var fps = opts.fps != null ? opts.fps : 30;
    var pauseWhenHidden = opts.pauseWhenHidden !== false; // default true
    var maxDpr = opts.maxDpr != null ? opts.maxDpr : 2;
    var onResize = opts.onResize || function () {};
    var onFrame = opts.onFrame || function () {};
    var onSettings = opts.onSettings || function () {};

    var isPreview = false;
    try {
      isPreview = new URLSearchParams(global.location.search).get('preview') === 'true';
    } catch (_) {}

    // Previews (marketplace grid thumbnails) don't need full fps.
    var effectiveFps = isPreview ? Math.min(fps || 30, 10) : fps;
    var frameInterval = effectiveFps > 0 ? 1000 / effectiveFps : 0;

    var rafId = null;
    var running = false;         // start() called, not destroyed
    var occluded = false;        // engine reports hidden / behind fullscreen / paused
    // Whether we're running inside the Novaframe engine (vs a plain browser tab,
    // e.g. a marketplace preview). The engine posts novaframe-* messages; the
    // FIRST one flips this on. It matters because a desktop-underlay webview can
    // report document.hidden === true even while it IS the visible wallpaper —
    // so once engine-controlled we trust `occluded` alone and ignore
    // document.hidden, otherwise we'd pause the wallpaper forever.
    var engineControlled = false;
    var lastDraw = -Infinity;
    var lastTs = 0;
    var frameCount = 0;
    var width = 0, height = 0, dpr = 1;

    function computeSize() {
      dpr = Math.min(maxDpr, global.devicePixelRatio || 1);
      width = global.innerWidth;
      height = global.innerHeight;
      return { width: width, height: height, dpr: dpr };
    }

    function isActive() {
      if (!running) return false;
      if (occluded) return false; // engine-authoritative pause (always honored)
      // document.hidden only when NOT engine-controlled (i.e. a real browser tab
      // like a marketplace preview); the underlay's hidden flag is unreliable.
      if (pauseWhenHidden && !engineControlled && global.document.hidden) return false;
      return true;
    }

    function loop(now) {
      // When inactive, do NOT reschedule — this is what makes pause truly free.
      if (!isActive()) { rafId = null; return; }
      rafId = global.requestAnimationFrame(loop);
      if (frameInterval && now - lastDraw < frameInterval) return;
      var dt = lastTs ? now - lastTs : 0;
      lastDraw = now;
      lastTs = now;
      frameCount++;
      onFrame({
        now: now, dt: dt, frame: frameCount,
        width: width, height: height, dpr: dpr, preview: isPreview
      });
    }

    function ensureLoop() {
      if (rafId == null) {
        lastDraw = -Infinity; // draw immediately on resume
        rafId = global.requestAnimationFrame(loop);
      }
    }
    function stopLoop() {
      if (rafId != null) { global.cancelAnimationFrame(rafId); rafId = null; }
    }
    function syncLoop() {
      if (isActive()) ensureLoop(); else stopLoop();
    }

    function handleResize() { onResize(computeSize()); }

    function handleMessage(e) {
      var d = e && e.data;
      if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
      // Any engine message means we're inside the engine → trust `occluded`,
      // stop gating on document.hidden.
      if (d.type.indexOf('novaframe-') === 0) {
        if (!engineControlled) { engineControlled = true; syncLoop(); }
      }
      if (d.type === 'novaframe-settings' && d.settings) {
        onSettings(d.settings);
      } else if (d.type === 'novaframe-occlusion') {
        occluded = !!d.occluded;
        syncLoop();
      } else if (d.type === 'novaframe-theme-ready' || d.type === 'novaframe-theme-resize') {
        handleResize();
      }
    }

    function handleVisibility() { syncLoop(); }

    return {
      start: function () {
        if (running) return this;
        running = true;
        global.addEventListener('resize', handleResize);
        global.addEventListener('message', handleMessage);
        global.document.addEventListener('visibilitychange', handleVisibility);
        handleResize();   // initial size before first frame
        syncLoop();
        return this;
      },
      pause: function () { occluded = true; stopLoop(); },
      resume: function () { occluded = false; syncLoop(); },
      destroy: function () {
        running = false;
        stopLoop();
        global.removeEventListener('resize', handleResize);
        global.removeEventListener('message', handleMessage);
        global.document.removeEventListener('visibilitychange', handleVisibility);
      },
      get size() { return { width: width, height: height, dpr: dpr }; },
      get preview() { return isPreview; }
    };
  }

  global.NovaframeWallpaper = { createWallpaper: createWallpaper };
})(window);
