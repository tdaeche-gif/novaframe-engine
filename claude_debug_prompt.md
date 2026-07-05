Here is the prompt and context you can copy and paste directly into Claude 3.5 Sonnet.

***

**Prompt for Claude:**

> I am building a dynamic, web-based wallpaper engine using Tauri (`app.js` runs in the main window) and an iframe that loads a WebGL shader wallpaper (`index.html`). The engine sends settings updates to the wallpaper via `postMessage`. 
> 
> However, we are facing two major issues with the "Ignis Solar Flares" wallpaper:
> 1. **Settings are not working:** When the user changes the settings sliders (e.g., flare intensity) in the main UI, the changes don't seem to have any visible effect on the shader, even though we believe `postMessage` is firing.
> 2. **Scaling issue / Black Bars:** The wallpaper seems to have lost its fix to scale properly to the screen resolution, resulting in letterboxing (black bars on the top and bottom) on certain aspect ratios.
> 
> Below are the relevant files. Please audit the `postMessage` pipeline, the Three.js scaling logic, and the fragment shader math. Identify why the intensity slider is failing to impact the visuals, and why the canvas might be letterboxing instead of covering the screen.

### 1. `engine_manifest.json` (Settings Definition)
```json
{
  "theme_id": "ignis-solar-wind",
  "version": "1.1.0",
  "name": "Ignis: Solar Wind",
  "description": "An interactive WebGL simulation of the sun's surface, featuring dynamic solar flares, magnetic field line distortions, and real-time interactive plasma.",
  "engine": "webgl",
  "resolution": "4K",
  "aspect_ratio": "16:9",
  "entry": "index.html",
  "render_mode": "external-html",
  "custom_settings": [
    {
      "id": "flare_speed",
      "label": "Flare Speed",
      "type": "range",
      "min": 1,
      "max": 100,
      "step": 1,
      "default": 30
    },
    {
      "id": "flare_intensity",
      "label": "Flare Intensity",
      "type": "range",
      "min": 1,
      "max": 100,
      "step": 1,
      "default": 50
    },
    {
      "id": "core_temp",
      "label": "Core Temperature",
      "type": "color",
      "default": "#ff5500"
    }
  ]
}
```

### 2. `app.js` (Engine Settings Broadcast Logic)
```javascript
// Inside initSettingsUI(), iterating over manifest custom_settings:
input.addEventListener('input', (e) => {
    const val = setting.type === 'range' ? parseFloat(e.target.value) : e.target.value;
    config.theme_settings[themePath][setting.id] = val;
    ConfigManager.saveConfig();

    // Live broadcast
    if (ThemeManager.currentIframe?.contentWindow) {
        ThemeManager.currentIframe.contentWindow.postMessage({
            type: 'novaframe-settings',
            settings: { [setting.id]: val }
        }, '*');
    }
});

// Inside mountIframe() on load:
iframe.addEventListener('load', () => {
    postViewport('novaframe-theme-ready');
    requestAnimationFrame(() => postViewport('novaframe-theme-ready'));

    // Dispatch saved theme settings if they exist
    if (config.theme_settings && config.theme_settings[themePath]) {
        const settings = config.theme_settings[themePath];
        try {
            iframe.contentWindow.postMessage({
                type: 'novaframe-settings',
                settings
            }, '*');
        } catch (_) {}
    }
});
```

### 3. `index.html` (The Wallpaper)
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ignis - Solar Wind</title>
    <style>
        body, html {
            margin: 0; padding: 0;
            width: 100%; height: 100%;
            overflow: hidden;
            background-color: #000000;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        /* The canvas is physically 4K, but we will scale it with JS */
        canvas {
            display: block;
            width: 3840px !important;
            height: 2160px !important;
            transform-origin: center center;
        }
    </style>
</head>
<body>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script type="x-shader/x-vertex" id="vertexShader">
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    </script>
    <script type="x-shader/x-fragment" id="fragmentShader">
        uniform float u_time;
        uniform vec2 u_resolution;
        uniform vec2 u_mouse;
        uniform float u_flare_speed;
        uniform float u_flare_intensity;
        uniform vec3 u_core_temp;

        varying vec2 vUv;

        float hash(vec2 p) { return fract(1e4 * sin(17.0 * p.x + p.y * 0.1) * (0.1 + abs(sin(p.y * 13.0 + p.x)))); }
        float noise(vec2 x) {
            vec2 i = floor(x); vec2 f = fract(x);
            float a = hash(i); float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0)); float d = hash(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        float fbm(vec2 p) {
            float v = 0.0; float a = 0.5; vec2 shift = vec2(100.0);
            mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.50));
            for (int i = 0; i < 5; ++i) { v += a * noise(p); p = rot * p * 2.0 + shift; a *= 0.5; }
            return v;
        }

        void main() {
            vec2 st = gl_FragCoord.xy / u_resolution.xy;
            st.x *= u_resolution.x / u_resolution.y;
            vec2 mouse = u_mouse.xy / u_resolution.xy;
            mouse.x *= u_resolution.x / u_resolution.y;

            vec2 sunPos = vec2(u_resolution.x / u_resolution.y, 0.5);
            vec2 dir = st - sunPos;
            float dist = length(dir);

            vec2 mouseDir = st - mouse;
            float pull = exp(-length(mouseDir) * 3.0);
            vec2 distortedSt = st + (normalize(dir) * (u_time * 0.05 * u_flare_speed)) + (mouseDir * pull * 0.1);

            float q = fbm(distortedSt * 3.0 - u_time * 0.2);
            float f = fbm(distortedSt * 6.0 + q + u_time * 0.1);

            float sunBody = smoothstep(0.4, 0.35, dist);
            
            float boost = 1.0 + pow(u_flare_intensity, 2.0) * 4.0; 
            float corona = exp(-dist * (2.5 / boost)) * f * (1.0 + u_flare_intensity);

            vec3 colorDark = vec3(0.0, 0.0, 0.0);
            vec3 colorRed = u_core_temp; 
            vec3 colorYellow = mix(colorRed, vec3(1.0, 0.8, 0.2), 0.5);
            vec3 colorWhite = vec3(1.0, 0.9, 0.8);

            vec3 finalColor = mix(colorDark, colorRed, corona * 1.5);
            finalColor = mix(finalColor, colorYellow, pow(corona, 2.0) * 2.0);
            finalColor = mix(finalColor, colorWhite, sunBody + pow(corona, 5.0));

            finalColor *= smoothstep(0.0, 0.8, st.x / (u_resolution.x / u_resolution.y));
            gl_FragColor = vec4(finalColor, 1.0);
        }
    </script>
    <script>
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true });

        renderer.setPixelRatio(1);
        renderer.setSize(3840, 2160, false);
        document.body.appendChild(renderer.domElement);

        const uniforms = {
            u_time: { type: "f", value: 0.0 },
            u_resolution: { type: "v2", value: new THREE.Vector2(3840, 2160) },
            u_mouse: { type: "v2", value: new THREE.Vector2() },
            u_flare_speed: { type: "f", value: 30.0 / 100.0 },
            u_flare_intensity: { type: "f", value: 50.0 / 100.0 },
            u_core_temp: { type: "v3", value: new THREE.Color("#ff5500") }
        };

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: document.getElementById('vertexShader').textContent,
            fragmentShader: document.getElementById('fragmentShader').textContent
        });
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

        function onWindowResize() {
            const width = window.innerWidth;
            const height = window.innerHeight;
            renderer.setSize(width, height);
            uniforms.u_resolution.value.set(width, height);
        }
        window.addEventListener('resize', onWindowResize);
        onWindowResize();

        let targetMouse = new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2);
        document.addEventListener('mousemove', (e) => {
            targetMouse.x = e.clientX;
            targetMouse.y = window.innerHeight - e.clientY;
        });

        const clock = new THREE.Clock();
        function animate() {
            requestAnimationFrame(animate);
            uniforms.u_mouse.value.lerp(targetMouse, 0.05);
            uniforms.u_time.value = clock.getElapsedTime();
            renderer.render(scene, camera);
        }
        animate();

        window.addEventListener('message', (event) => {
            const data = event.data;
            if (data.type === 'novaframe-pointer') {
                targetMouse.x = data.nx * 3840;
                targetMouse.y = (1.0 - data.ny) * 2160;
                return;
            }
            if (data.type === 'novaframe-settings') {
                const settings = data.settings;
                if (settings.flare_speed !== undefined) uniforms.u_flare_speed.value = settings.flare_speed / 100.0;
                if (settings.flare_intensity !== undefined) uniforms.u_flare_intensity.value = settings.flare_intensity / 100.0;
                if (settings.core_temp !== undefined) uniforms.u_core_temp.value.set(settings.core_temp);
            }
        });
    </script>
</body>
</html>
```
