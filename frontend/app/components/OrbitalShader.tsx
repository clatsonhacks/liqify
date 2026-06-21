"use client";

import { useEffect, useRef } from "react";

type Ring = {
  buffer: WebGLBuffer;
  count: number;
  color: [number, number, number];
  rotation: [number, number, number];
  speed: number;
  scale: [number, number, number];
  opacity: number;
  glow: number;
};

const vertexShader = `
  attribute vec4 aVertex;
  uniform float uTime;
  uniform float uAspect;
  uniform float uSpeed;
  uniform float uTilt;
  uniform vec3 uRotation;
  uniform vec3 uScale;
  varying float vPhase;
  varying float vDepth;

  mat3 rotateX(float a) {
    float c = cos(a), s = sin(a);
    return mat3(1.,0.,0., 0.,c,-s, 0.,s,c);
  }
  mat3 rotateY(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c,0.,s, 0.,1.,0., -s,0.,c);
  }
  mat3 rotateZ(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c,-s,0., s,c,0., 0.,0.,1.);
  }

  void main() {
    vec3 p = aVertex.xyz * uScale;

    // Per-ring fixed orientation (fans the nested loops apart).
    p = rotateX(uRotation.x) * rotateY(uRotation.y) * rotateZ(uRotation.z) * p;

    // Whole assembly spins together about a single tilted axis (gyroscope feel).
    float spin = uTime * uSpeed;
    p = rotateZ(uTilt) * rotateY(spin) * rotateX(sin(uTime * .18) * .06) * p;

    float perspective = 1.85 / (3.1 - p.z);
    vec2 projected = vec2(p.x / uAspect, p.y) * perspective * 1.18;
    gl_Position = vec4(projected, p.z * .08, 1.0);
    gl_PointSize = 1.6 + perspective * 1.7;
    vPhase = aVertex.w;
    vDepth = perspective;
  }
`;

const fragmentShader = `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uPoints;
  uniform float uGlow;
  varying float vPhase;
  varying float vDepth;

  void main() {
    // A bright pulse travels around the band.
    float pulse = .45 + .55 * pow(.5 + .5 * sin(vPhase * 6.2831 - uTime * 1.4), 1.8);
    // Front-facing parts are brighter than the back of the cage.
    float depth = clamp((vDepth - .45) / .6, 0.0, 1.0);
    float alpha = uOpacity * pulse * (.35 + .65 * depth);
    vec3 color = uColor * (1.0 + uGlow * depth);

    if (uPoints > .5) {
      vec2 d = gl_PointCoord - .5;
      float glow = smoothstep(.5, .0, length(d));
      alpha *= glow;
    }
    gl_FragColor = vec4(color, alpha);
  }
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

// A torus whose surface is drawn as a triangulated truss: longitudinal rails,
// tube hoops, and a diagonal across every cell — that diagonal is what reads as
// the woven lattice in the reference image.
function torusTruss(majorRadius: number, tubeRadius: number, majorSteps = 130, tubeSteps = 6) {
  const values: number[] = [];
  const point = (u: number, v: number) => [
    (majorRadius + tubeRadius * Math.cos(v)) * Math.cos(u),
    (majorRadius + tubeRadius * Math.cos(v)) * Math.sin(u),
    tubeRadius * Math.sin(v),
    u / (Math.PI * 2), // phase 0..1 around the band
  ];
  const seg = (a: number[], b: number[]) => values.push(...a, ...b);

  for (let i = 0; i < majorSteps; i++) {
    const u0 = (i / majorSteps) * Math.PI * 2;
    const u1 = ((i + 1) / majorSteps) * Math.PI * 2;
    for (let j = 0; j < tubeSteps; j++) {
      const v0 = (j / tubeSteps) * Math.PI * 2;
      const v1 = ((j + 1) / tubeSteps) * Math.PI * 2;
      const a = point(u0, v0);
      seg(a, point(u1, v0)); // rail along the band
      seg(a, point(u0, v1)); // hoop around the tube
      seg(a, point(u1, v1)); // diagonal -> triangular truss
    }
  }
  return new Float32Array(values);
}

export default function OrbitalShader() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true, premultipliedAlpha: false });
    if (!gl) return;

    const vert = compile(gl, gl.VERTEX_SHADER, vertexShader);
    const frag = compile(gl, gl.FRAGMENT_SHADER, fragmentShader);
    if (!vert || !frag) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.useProgram(program);

    const aVertex = gl.getAttribLocation(program, "aVertex");
    const uniforms = {
      time: gl.getUniformLocation(program, "uTime"), aspect: gl.getUniformLocation(program, "uAspect"),
      speed: gl.getUniformLocation(program, "uSpeed"), tilt: gl.getUniformLocation(program, "uTilt"),
      rotation: gl.getUniformLocation(program, "uRotation"), scale: gl.getUniformLocation(program, "uScale"),
      color: gl.getUniformLocation(program, "uColor"), opacity: gl.getUniformLocation(program, "uOpacity"),
      points: gl.getUniformLocation(program, "uPoints"), glow: gl.getUniformLocation(program, "uGlow"),
    };

    // Nested elliptical bands sharing one tilt, each fanned a little so they
    // weave into a sphere-like cage. Deep blue outside -> bright cyan inside,
    // then a hot orange truss ring at the core.
    type Spec = Omit<Ring, "buffer" | "count"> & { radius: number; tube: number; major: number; tubeSeg: number };
    const blueSpin = .16;
    const specs: Spec[] = [
      { radius: 1.32, tube: .050, major: 150, tubeSeg: 6, color: [.05, .26, .72], rotation: [.10, .12, .00], speed: blueSpin, scale: [1, .52, 1], opacity: .40, glow: .5 },
      { radius: 1.15, tube: .048, major: 144, tubeSeg: 6, color: [.10, .40, .92], rotation: [.06, .06, .16], speed: blueSpin, scale: [1, .54, 1], opacity: .54, glow: .7 },
      { radius: .99, tube: .046, major: 138, tubeSeg: 6, color: [.16, .52, 1.0], rotation: [.02, .00, .32], speed: blueSpin, scale: [1, .56, 1], opacity: .66, glow: .9 },
      { radius: .84, tube: .044, major: 132, tubeSeg: 6, color: [.30, .66, 1.0], rotation: [-.02, -.06, .48], speed: blueSpin, scale: [1, .58, 1], opacity: .72, glow: 1.1 },
      { radius: .70, tube: .042, major: 126, tubeSeg: 6, color: [.46, .78, 1.0], rotation: [-.06, -.12, .64], speed: blueSpin, scale: [1, .60, 1], opacity: .70, glow: 1.2 },
      // Orange core: smaller, fatter tube, stood upright/edge-on inside the cage.
      { radius: .58, tube: .110, major: 132, tubeSeg: 9, color: [1.0, .42, .06], rotation: [1.35, .25, .30], speed: blueSpin * .65, scale: [1, .92, 1], opacity: .98, glow: 1.7 },
    ];

    const rings: Ring[] = specs.map((spec) => {
      const data = torusTruss(spec.radius, spec.tube, spec.major, spec.tubeSeg);
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const { radius, tube, major, tubeSeg, ...rest } = spec;
      return { ...rest, buffer, count: data.length / 4 };
    });

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);

    let frame = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
    };

    const tilt = -0.42; // assembly leans like the reference

    const render = (ms: number) => {
      resize();
      const time = ms * .001;
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.time, time);
      gl.uniform1f(uniforms.aspect, canvas.width / canvas.height);
      gl.uniform1f(uniforms.tilt, tilt);
      gl.enableVertexAttribArray(aVertex);

      rings.forEach(ring => {
        gl.bindBuffer(gl.ARRAY_BUFFER, ring.buffer);
        gl.vertexAttribPointer(aVertex, 4, gl.FLOAT, false, 0, 0);
        gl.uniform1f(uniforms.speed, ring.speed);
        gl.uniform3fv(uniforms.rotation, ring.rotation);
        gl.uniform3fv(uniforms.scale, ring.scale);
        gl.uniform3fv(uniforms.color, ring.color);
        gl.uniform1f(uniforms.glow, ring.glow);

        // Soft additive glow pass (points) under crisp truss lines.
        gl.uniform1f(uniforms.opacity, ring.opacity * .22);
        gl.uniform1f(uniforms.points, 1);
        gl.drawArrays(gl.POINTS, 0, ring.count);
        gl.uniform1f(uniforms.opacity, ring.opacity);
        gl.uniform1f(uniforms.points, 0);
        gl.drawArrays(gl.LINES, 0, ring.count);
      });
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      rings.forEach(ring => gl.deleteBuffer(ring.buffer));
      gl.deleteProgram(program); gl.deleteShader(vert); gl.deleteShader(frag);
    };
  }, []);

  return <div className="shaderStage" aria-label="Animated orbital wireframe sculpture">
    <canvas ref={canvasRef} className="orbitalCanvas" />
    <div className="shaderVignette" />
  </div>;
}
