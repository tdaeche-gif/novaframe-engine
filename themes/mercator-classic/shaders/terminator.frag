precision mediump float;
varying vec2 vUv;
uniform vec2 uSubsolar; // x = lon (degrees), y = lat (declination, degrees)
uniform vec4 uColor;
uniform sampler2D uCityLights;

#define PI 3.14159265359

void main() {
    float lon = (vUv.x - 0.5) * 360.0;

    // Inverse Mercator: map normalised vUv.y to geographic latitude
    // Map is cropped at MAX_LAT=82.007 deg, maxY=2.66068
    float y_merc = (0.5 - vUv.y) * 2.0 * 2.66068;
    float latRad = 2.0 * atan(exp(y_merc)) - PI / 2.0;

    float lonRad    = lon          * PI / 180.0;
    float subLatRad = uSubsolar.y  * PI / 180.0;
    float subLonRad = uSubsolar.x  * PI / 180.0;

    // Spherical dot-product: positive = day side, negative = night side
    float cosAngle = sin(latRad) * sin(subLatRad)
                   + cos(latRad) * cos(subLatRad) * cos(lonRad - subLonRad);

    // Smooth twilight zone (cosAngle: 0.0 → -0.20 ≈ 12° of dusk/dawn)
    float alpha = smoothstep(0.0, -0.20, cosAngle);

    // City lights: greyscale mask, warm golden glow on the night side
    float lightsMask  = texture2D(uCityLights, vUv).r;
    vec3  shadowColor = uColor.rgb;
    float shadowAlpha = uColor.a * alpha;
    vec3  lightsColor = vec3(1.0, 0.88, 0.52);
    float lightsAlpha = lightsMask * alpha * 0.95;

    vec3  finalRgb   = mix(shadowColor, lightsColor, lightsAlpha);
    float finalAlpha = max(shadowAlpha, lightsAlpha);

    gl_FragColor = vec4(finalRgb, finalAlpha);
}
