"use client";

import { useEffect, useRef } from "react";

const vertexSource = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const fragmentSource = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.52;
  mat2 turn = mat2(0.84, -0.54, 0.54, 0.84);
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = turn * p * 2.03 + 11.7;
    amplitude *= 0.49;
  }
  return value;
}

float glassField(vec2 p, float t) {
  vec2 q = vec2(
    fbm(p * 0.92 + vec2(t * 0.13, -t * 0.08)),
    fbm(p * 0.92 + vec2(-t * 0.10 + 4.2, t * 0.09 + 2.7))
  );
  vec2 warp = (q - 0.5) * 0.92;
  float body = fbm((p + warp) * 1.18 + vec2(t * 0.055, 0.0));
  float ribbon = sin((p.x + warp.x) * 2.45 - (p.y + warp.y) * 1.05 + body * 5.4 + t * 0.28);
  return body * 0.72 + ribbon * 0.19;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= uResolution.x / uResolution.y;
  float t = uTime;

  float field = glassField(p, t);
  float epsilon = 0.009;
  float dx = glassField(p + vec2(epsilon, 0.0), t) - field;
  float dy = glassField(p + vec2(0.0, epsilon), t) - field;
  vec3 normal = normalize(vec3(-dx * 14.0, -dy * 14.0, 1.0));

  vec2 refracted = p + normal.xy * 0.22;
  float secondary = fbm(refracted * 1.52 - vec2(t * 0.025, t * 0.018));
  float fold = smoothstep(0.20, 0.91, field + secondary * 0.25);
  float caustic = pow(max(0.0, 1.0 - abs(field - 0.53) * 5.2), 4.0);
  float highlight = pow(max(dot(normal, normalize(vec3(-0.45, 0.72, 0.9))), 0.0), 13.0);

  vec3 deep = vec3(0.018, 0.050, 0.090);
  vec3 middle = vec3(0.025, 0.185, 0.330);
  vec3 cyan = vec3(0.23, 0.69, 0.92);
  vec3 color = mix(deep, middle, fold);
  color = mix(color, cyan, caustic * 0.56);
  color += highlight * vec3(0.44, 0.79, 1.0) * 0.72;

  float glowA = exp(-5.2 * length(p - vec2(-0.74, 0.56)));
  float glowB = exp(-4.0 * length(p - vec2(0.88, -0.58)));
  color += glowA * vec3(0.05, 0.25, 0.42) + glowB * vec3(0.02, 0.17, 0.34);

  float vignette = smoothstep(1.62, 0.20, length(p * vec2(0.76, 1.0)));
  color *= 0.72 + vignette * 0.35;
  gl_FragColor = vec4(color, 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function SeFiGlassShader({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);

  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, powerPreference: "high-performance" });
    if (!gl) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, "uResolution");
    const time = gl.getUniformLocation(program, "uTime");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let lastWidth = 0;
    let lastHeight = 0;

    const render = (timestamp: number) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width; lastHeight = height;
        canvas.width = width; canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      if (activeRef.current && document.visibilityState === "visible") {
        gl.uniform2f(resolution, width, height);
        gl.uniform1f(time, reducedMotion ? 2.5 : timestamp * 0.00038);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
    };
  }, []);

  return <canvas ref={canvasRef} className="sefiGlassCanvas" aria-hidden="true"/>;
}
