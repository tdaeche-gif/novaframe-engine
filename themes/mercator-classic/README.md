# Mercator Classic Theme

The default built-in theme for the Geochron wallpaper engine.

## Map Projection
Standard Mercator projection cropped at ±82.007° latitude.  
Image: 6930 × 5870 px JPEG.

## Shader Pipeline
GPU-accelerated WebGL day/night terminator with:
- Smooth 12° twilight transition zone
- Inverse Mercator latitude mapping in the fragment shader
- City lights overlay (warm golden glow on the night side)

## Files
```
mercator-classic/
├── manifest.json             Theme descriptor
├── world-map-mercator.jpg    Background map asset
├── preview-thumbnail.webp    UI thumbnail (360×180)
├── README.md                 This file
└── shaders/
    ├── terminator.vert       WebGL vertex shader
    └── terminator.frag       WebGL fragment shader
```

## Compatibility
Requires Geochron Engine ≥ 0.1.0 with `pipeline_mode: gpu-shader`.  
Falls back gracefully to CPU polygon rendering when WebGL is unavailable.
