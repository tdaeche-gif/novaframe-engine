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
    var isDebug = false;
    try {
      var params = new URLSearchParams(global.location.search);
      isPreview = params.get('preview') === 'true';
      isDebug = params.get('debug') === 'true';
    } catch (_) {}

    // Previews (marketplace grid thumbnails) don't need full fps.
    var effectiveFps = isPreview ? Math.min(fps || 30, 10) : fps;
    var frameInterval = effectiveFps > 0 ? 1000 / effectiveFps : 0;

    // Measured display refresh period, learned from the gap between consecutive
    // rAF callbacks. The pacing gate needs to know this: rAF only fires on
    // refresh boundaries, which almost never line up with the requested
    // interval, so a naive `now - lastDraw < frameInterval` test always lands on
    // the boundary AFTER the one it wanted and undershoots the target. Seeded at
    // 60Hz and corrected within the first few frames.
    var refreshMs = 1000 / 60;
    var lastRafTs = 0;

    var rafId = null;
    var timerId = null;
    var running = false;         // start() called, not destroyed
    var occluded = false;        // engine reports hidden / behind fullscreen / paused
    // Whether we're running inside the Novaframe engine (vs a plain browser tab,
    // e.g. a marketplace preview). The engine posts novaframe-* messages; the
    // FIRST one flips this on. It matters because a desktop-underlay webview can
    // report document.hidden === true even while it IS the visible wallpaper —
    // so once engine-controlled we trust `occluded` alone and ignore
    // document.hidden, otherwise we'd pause the wallpaper forever.
    var engineControlled = false;
    var nextDrawAt = 0;   // deadline for the next draw, advanced on a fixed grid
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

    var fpsWindowStart = 0;
    var fpsWindowFrames = 0;

    // Schedule the next frame.
    //
    // Previously this was an unconditional requestAnimationFrame every frame,
    // with an early return when under the interval. That skips the DRAW but not
    // the WAKE: at a 30fps target on a 120Hz display the JS thread and the
    // compositor still woke 120x/second, so "30 FPS (Power Saver)" saved far
    // less than the label implies.
    //
    // When the target is meaningfully below the display refresh rate, sleep the
    // remaining time on a timer first and only then ask for a frame. The loop
    // genuinely idles between draws. When the target is at or above refresh
    // (frameInterval 0, or shorter than one frame) it falls through to plain
    // rAF, which is already optimal.
    function schedule(now) {
      var wait = frameInterval ? nextDrawAt - refreshMs / 2 - now : 0;
      // Only take the timer path when it actually skips at least one refresh.
      // At 60fps-on-60Hz the wait is under one frame and a timer would just add
      // a hop before the rAF we were going to get anyway.
      if (wait > refreshMs) {
        timerId = global.setTimeout(function () {
          timerId = null;
          if (!isActive()) { rafId = null; return; }
          rafId = global.requestAnimationFrame(loop);
        }, wait);
      } else {
        rafId = global.requestAnimationFrame(loop);
      }
    }

    function loop(now) {
      // When inactive, do NOT reschedule — this is what makes pause truly free.
      if (!isActive()) { rafId = null; return; }

      // Learn the refresh period from consecutive callbacks. Smallest recent gap
      // wins: a gap can be stretched by a slow frame elsewhere, never shortened
      // below the true refresh period.
      if (lastRafTs) {
        var gap = now - lastRafTs;
        if (gap > 1 && gap < refreshMs) refreshMs = gap;
      }
      lastRafTs = now;

      // Draw when we're within half a refresh of the deadline — the boundary
      // nearest the target, rather than always the one after it.
      if (frameInterval && now < nextDrawAt - refreshMs / 2) {
        schedule(now);
        return;
      }

      var dt = lastTs ? now - lastTs : 0;
      lastTs = now;
      frameCount++;

      // Advance the deadline on a fixed grid rather than from `now`, so the
      // error of each frame doesn't accumulate. This is what lets a target that
      // isn't a whole divisor of the refresh rate still average out correctly —
      // 30fps on 144Hz alternates 4- and 5-frame gaps instead of locking to one.
      // Resync if we've fallen more than a full interval behind (tab throttled,
      // machine asleep) so we don't burst to catch up.
      nextDrawAt += frameInterval;
      if (nextDrawAt < now) nextDrawAt = now + frameInterval;
      schedule(now);

      // Live FPS verification. Debug-only: this fired every 2s in every theme
      // iframe for the lifetime of the app, into a console nobody can open.
      if (isDebug) {
        fpsWindowFrames++;
        if (!fpsWindowStart) {
          fpsWindowStart = now;
        } else if (now - fpsWindowStart >= 2000) {
          var measuredFps = Math.round((fpsWindowFrames * 1000) / (now - fpsWindowStart));
          console.log('[Novaframe Runtime] Live Measured FPS: ' + measuredFps + ' (Target: ' + (fps || 30) + ' FPS)');
          fpsWindowStart = now;
          fpsWindowFrames = 0;
        }
      }

      onFrame({
        now: now, dt: dt, frame: frameCount,
        width: width, height: height, dpr: dpr, preview: isPreview
      });
    }

    function ensureLoop() {
      if (rafId == null && timerId == null) {
        nextDrawAt = 0; // deadline in the past → draw immediately on resume
        rafId = global.requestAnimationFrame(loop);
      }
    }
    function stopLoop() {
      if (rafId != null) { global.cancelAnimationFrame(rafId); rafId = null; }
      if (timerId != null) { global.clearTimeout(timerId); timerId = null; }
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
        if (d.settings.fps != null) {
          var v = Number(d.settings.fps);
          if (!isNaN(v) && v > 0) {
            fps = v;
            effectiveFps = isPreview ? Math.min(fps, 10) : fps;
            frameInterval = effectiveFps > 0 ? 1000 / effectiveFps : 0;
            if (isActive()) syncLoop();
          }
        }
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
