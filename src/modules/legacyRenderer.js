// ── Legacy Mercator World Map Renderer ──────────────────────────────────────
// Renders 2D Mercator projection, sun position, day/night shadow Terminator,
// grid lines, and city lights overlay.

export const LEGACY_THEME_DEFAULTS = {
    mapImageSrc: 'assets/world-map-mercator.jpg',
    bgColor: '#0f141d',
    timelineHeight: 40,
    timelineBgColor: 'rgba(0, 5, 20, 0.78)',
    timelineTickColor: 'rgba(160, 180, 255, 0.45)',
    timelineTextColor: '#e0e8ff',
    shadowColorHex: '0, 8, 24',
    sunMarkerColor: '#ffd700',
    sunGlowColor: '#ffaa00',
    gridColor: 'rgba(255, 255, 255, 0.06)',
    equatorColor: 'rgba(255, 215, 0, 0.25)',
    pinColor: '#00a2ff',
    pinGlowColor: 'rgba(0, 162, 255, 0.5)',
    pinTextColor: 'rgba(224, 232, 255, 0.75)',
    shadow_color: '#000000',
    shadow_opacity: 0.5,
    show_analemma: true,
    use_gpu_shader: true
};

let animFrameId = null;
let isRunning = false;

// Solar position calculation helpers
export function calculateSolarPosition(date = new Date()) {
    const startOfYear = new Date(date.getFullYear(), 0, 0);
    const diff = date - startOfYear;
    const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    // Solar declination angle in radians (-23.44° to +23.44°)
    const declination = -23.44 * Math.cos((360 / 365) * (dayOfYear + 10) * (Math.PI / 180)) * (Math.PI / 180);
    
    // Subsolar point longitude in degrees (-180° to +180°)
    const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const subsolarLon = 180 - (utcHours / 24) * 360;
    
    return {
        declination,
        subsolarLat: declination * (180 / Math.PI),
        subsolarLon
    };
}

// Convert Lat/Lon to Mercator pixel coordinates
export function latLonToMercator(lat, lon, width, height) {
    const x = ((lon + 180) / 360) * width;
    const latRad = (lat * Math.PI) / 180;
    const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const y = height / 2 - (width * mercN) / (2 * Math.PI);
    return { x, y };
}

// Render Day/Night Shadow Curve onto 2D Canvas
export function drawNightShadow(ctx, width, height, solarPos, opacity = 0.5, shadowColor = '#000000') {
    if (!ctx) return;
    
    ctx.save();
    ctx.fillStyle = shadowColor;
    ctx.globalAlpha = opacity;
    
    const dec = solarPos.declination;
    const subLon = solarPos.subsolarLon;
    
    ctx.beginPath();
    let started = false;
    
    for (let x = 0; x <= width; x += 2) {
        const lon = (x / width) * 360 - 180;
        const deltaLonRad = ((lon - subLon) * Math.PI) / 180;
        
        // Solar zenith angle equation for Terminator boundary
        const tanLat = -Math.cos(deltaLonRad) / Math.tan(dec);
        let latRad = Math.atan(tanLat);
        
        // Clamp latitude to valid Mercator range
        let latDeg = (latRad * 180) / Math.PI;
        latDeg = Math.max(-85, Math.min(85, latDeg));
        
        const pos = latLonToMercator(latDeg, lon, width, height);
        
        if (!started) {
            ctx.moveTo(pos.x, dec >= 0 ? height : 0);
            ctx.lineTo(pos.x, pos.y);
            started = true;
        } else {
            ctx.lineTo(pos.x, pos.y);
        }
    }
    
    ctx.lineTo(width, dec >= 0 ? height : 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

export function drawSunMarker(ctx, width, height, solarPos) {
    if (!ctx) return;
    
    const pos = latLonToMercator(solarPos.subsolarLat, solarPos.subsolarLon, width, height);
    
    ctx.save();
    // Outer Sun Glow
    const gradient = ctx.createRadialGradient(pos.x, pos.y, 4, pos.x, pos.y, 24);
    gradient.addColorStop(0, 'rgba(255, 215, 0, 0.9)');
    gradient.addColorStop(0.5, 'rgba(255, 170, 0, 0.4)');
    gradient.addColorStop(1, 'rgba(255, 170, 0, 0)');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 24, 0, Math.PI * 2);
    ctx.fill();
    
    // Sun Core
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

export function initLegacyRenderer(canvasElement) {
    if (!canvasElement) return null;
    const ctx = canvasElement.getContext('2d');
    return ctx;
}

export function stopLegacyRenderer() {
    isRunning = false;
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
}
