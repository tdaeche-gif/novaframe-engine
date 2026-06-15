attribute vec2 aVertexPosition;
varying vec2 vUv;

void main() {
    vUv = aVertexPosition * 0.5 + 0.5;
    vUv.y = 1.0 - vUv.y;
    gl_Position = vec4(aVertexPosition, 0.0, 1.0);
}
