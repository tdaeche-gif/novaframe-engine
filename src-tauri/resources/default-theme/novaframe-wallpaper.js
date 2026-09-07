/*
 * novaframe-wallpaper.js — shared runtime for Novaframe wallpapers.
 * Supports:
 *   - Desktop Live Mode (Tauri app: RAF + idle throttling + settings messages)
 *   - Headless Render Mode (?headless=true: session-scoped, sequence-numbered stepping protocol)
 */
(function (global) {
  'use strict';

  function createWallpaper(options) {
    var opts = options || {};
    var fps = opts.fps != null ? opts.fps : 30;
    var pauseWhenHidden = opts.pauseWhenHidden !== false;
    var maxDpr = opts.maxDpr != null ? opts.maxDpr : 2;
    var onResize = opts.onResize || function () {};
    var onFrame = opts.onFrame || function () {};
    var onSettings = opts.onSettings || function () {};
    var onPointer = opts.onPointer || function () {};

    var isPreview = false;
    var isHeadless = false;
    try {
      var searchParams = new URLSearchParams(global.location.search);
      isPreview = searchParams.get('preview') === 'true';
      isHeadless = searchParams.get('headless') === 'true';
    } catch (_) {}

    var effectiveFps = isPreview ? Math.min(fps || 30, 10) : fps;
    var frameInterval = effectiveFps > 0 ? 1000 / effectiveFps : 0;

    function setFps(value) {
      var nextFps = Number(value);
      if (nextFps !== 30 && nextFps !== 60 && nextFps !== 120) return;
      if (nextFps === fps) return;
      fps = nextFps;
      effectiveFps = isPreview ? Math.min(fps, 10) : fps;
      frameInterval = effectiveFps > 0 ? 1000 / effectiveFps : 0;
      stopLoop();
      lastTs = 0;
      nextFrameAt = 0;
      syncLoop();
    }

    var rafId = null;
    var running = false;
    var occluded = false;
    var engineControlled = false;
    var lastTs = 0;
    var frameCount = 0;
    var width = 0, height = 0, dpr = 1;
    var nextFrameAt = 0;
    var frameEvent = {
      now: 0, dt: 0, frame: 0,
      width: 0, height: 0, dpr: 1, preview: false
    };

    // Headless protocol state
    var protocolState = 'idle'; // 'idle' | 'initialized' | 'rendering'
    var activeSessionId = null;
    var lastSeq = -1;
    var ackCache = {};

    function computeSize() {
      dpr = Math.min(maxDpr, global.devicePixelRatio || 1);
      width = global.innerWidth;
      height = global.innerHeight;
      return { width: width, height: height, dpr: dpr };
    }

    function isActive() {
      if (isHeadless) return false; // Headless frames are driven strictly by novaframe-step
      if (!running) return false;
      if (occluded) return false;
      if (pauseWhenHidden && !engineControlled && global.document.hidden) return false;
      return true;
    }

    function loop(now) {
      if (!isActive()) { rafId = null; return; }

      rafId = global.requestAnimationFrame(loop);

      if (frameInterval > 0 &&
          nextFrameAt !== 0 &&
          now + 0.25 < nextFrameAt) {
        return;
      }

      var dt = lastTs ? now - lastTs : 0;
      lastTs = now;
      frameCount++;

      if (frameInterval > 0) {
        if (nextFrameAt === 0) {
          nextFrameAt = now + frameInterval;
        } else {
          nextFrameAt += frameInterval;
          if (nextFrameAt <= now) nextFrameAt = now + frameInterval;
        }
      }

      frameEvent.now = now;
      frameEvent.dt = dt;
      frameEvent.frame = frameCount;
      frameEvent.width = width;
      frameEvent.height = height;
      frameEvent.dpr = dpr;
      frameEvent.preview = isPreview;
      onFrame(frameEvent);
    }

    function ensureLoop() {
      if (isHeadless) return;
      if (rafId == null) {
        lastTs = 0;
        nextFrameAt = 0;
        rafId = global.requestAnimationFrame(loop);
      }
    }

    function stopLoop() {
      if (rafId != null) { global.cancelAnimationFrame(rafId); rafId = null; }
    }

    function syncLoop() {
      if (isActive()) ensureLoop(); else stopLoop();
    }

    function handleResize() {
      var s = computeSize();
      onResize(s, s.width, s.height, s.dpr);
    }

    async function handleMessage(e) {
      var d = e && e.data;
      if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;

      // 1. Headless Stepping Protocol Handlers
      if (d.type === 'novaframe-init') {
        activeSessionId = d.sessionId;
        lastSeq = -1;
        ackCache = {};
        if (d.width && d.height) {
          width = d.width;
          height = d.height;
          onResize({ width: width, height: height, dpr: dpr }, width, height, dpr);
        }
        protocolState = 'initialized';
        if (global.parent && global.parent.postMessage) {
          global.parent.postMessage({
            type: 'novaframe-ready',
            sessionId: activeSessionId
          }, '*');
        }
        return;
      }

      if (d.type === 'novaframe-step') {
        if (d.sessionId !== activeSessionId) return;

        var seq = d.seq;
        var frame = d.frame;

        // Idempotency: resend cached ACK if already rendered
        if (seq <= lastSeq) {
          var cached = ackCache[seq] || { seq: seq, frame: frame };
          global.parent.postMessage({
            type: 'novaframe-ack',
            sessionId: activeSessionId,
            seq: cached.seq,
            frame: cached.frame
          }, '*');
          return;
        }

        // Gap check
        if (seq > lastSeq + 1 && lastSeq !== -1) {
          var gapErr = 'SEQUENCE_GAP: Expected seq=' + (lastSeq + 1) + ' but got seq=' + seq;
          console.error('[novaframe-wallpaper] ' + gapErr);
          global.parent.postMessage({
            type: 'novaframe-error',
            sessionId: activeSessionId,
            seq: seq,
            message: gapErr
          }, '*');
          return;
        }

        protocolState = 'rendering';
        var virtualTime = d.time != null ? d.time : (frame / (fps || 60));
        var virtualDt = d.dt != null ? d.dt : (1 / (fps || 60));

        // Execute wallpaper frame synchronously
        try {
          await onFrame({
            now: virtualTime * 1000,
            time: virtualTime,
            dt: virtualDt * 1000,
            frame: frame,
            width: width,
            height: height,
            dpr: dpr,
            preview: isPreview
          });
        } catch (renderErr) {
          console.error('[novaframe-wallpaper] Render error in onFrame:', renderErr);
          global.parent.postMessage({
            type: 'novaframe-error',
            sessionId: activeSessionId,
            seq: seq,
            message: renderErr && renderErr.message ? renderErr.message : String(renderErr)
          }, '*');
          return;
        }

        // Flush WebGL if canvas present
        try {
          var canvases = global.document.querySelectorAll('canvas');
          for (var i = 0; i < canvases.length; i++) {
            var gl = canvases[i].getContext('webgl2') || canvases[i].getContext('webgl');
            if (gl && gl.flush) gl.flush();
          }
        } catch (_) {}

        // Await browser paint synchronization
        if (typeof global.requestAnimationFrame === 'function') {
          await new Promise(global.requestAnimationFrame);
        }

        lastSeq = seq;
        ackCache[seq] = { seq: seq, frame: frame };
        protocolState = 'initialized';

        global.parent.postMessage({
          type: 'novaframe-ack',
          sessionId: activeSessionId,
          seq: seq,
          frame: frame
        }, '*');
        return;
      }

      // 2. Desktop Live Engine Handlers
      if (d.type.indexOf('novaframe-') === 0) {
        if (!engineControlled) { engineControlled = true; syncLoop(); }
      }
      if (d.type === 'novaframe-settings' && d.settings) {
        onSettings(d.settings);
      } else if (d.type === 'novaframe-pointer') {
        onPointer(d.nx != null ? d.nx : 0.5, d.ny != null ? d.ny : 0.5, d.x || 0, d.y || 0);
      } else if (d.type === 'novaframe-occlusion') {
        occluded = !!d.occluded;
        syncLoop();
      } else if (d.type === 'novaframe-theme-ready' || d.type === 'novaframe-theme-resize') {
        handleResize();
      }
    }

    function handleVisibility() { syncLoop(); }

    // Bind webglcontextlost on document canvases
    global.document.addEventListener('webglcontextlost', function (e) {
      if (isHeadless && activeSessionId) {
        global.parent.postMessage({
          type: 'novaframe-error',
          sessionId: activeSessionId,
          message: 'webgl-context-lost'
        }, '*');
      }
    }, true);

    return {
      start: function () {
        if (running) return this;
        running = true;
        global.addEventListener('resize', handleResize);
        global.addEventListener('message', handleMessage);
        global.document.addEventListener('visibilitychange', handleVisibility);
        handleResize();
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
      get preview() { return isPreview; },
      setFps: setFps
    };
  }

  global.NovaframeWallpaper = { createWallpaper: createWallpaper };
})(window);
