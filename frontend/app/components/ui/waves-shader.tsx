"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

type WavesShaderProps = {
  active?: boolean;
  className?: string;
};

export function ShaderComponent({ active = true, className = "" }: WavesShaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  const frameRef = useRef(0);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const clock = new THREE.Clock();
    const camera = new THREE.Camera();
    camera.position.z = 1;

    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const uniforms = {
      u_time: { value: 1.0 },
      u_resolution: { value: new THREE.Vector2() },
    };

    const vertexShader = `
      varying vec2 vUv;
      void main() {
        gl_Position = vec4(position, 1.0);
        vUv = uv;
      }
    `;

    const fragmentShader = `
      precision highp float;

      uniform vec2 u_resolution;
      uniform float u_time;
      varying vec2 vUv;

      const float PI = 3.1415926535897932384626433832795;
      const float TAU = PI * 2.;

      void coswarp(inout vec3 trip, float warpsScale ){
        trip.xyz += warpsScale * .1 * cos(3. * trip.yzx + (u_time * .25));
        trip.xyz += warpsScale * .05 * cos(11. * trip.yzx + (u_time * .25));
        trip.xyz += warpsScale * .025 * cos(17. * trip.yzx + (u_time * .25));
      }

      void main() {
        vec2 uv = (gl_FragCoord.xy - u_resolution * .5) / u_resolution.yy + 0.5;

        float t = (u_time *.2) + length(fract((uv-.5) *10.));
        float t2 = (u_time *.1) + length(fract((uv-.5) *20.));

        vec2 uv2 = uv;
        vec3 w = vec3(uv.x, uv.y, 1.);
        coswarp(w, 3.);

        uv.x += w.r;
        uv.y += w.g;

        vec3 color = vec3(0., .5, uv2.x);
        color.r = sin(u_time *.2) + sin(length(uv-.5) * 10.);
        color.g = sin(u_time *.3) + sin(length(uv-.5) * 20.);

        coswarp(color, 3.);

        float waves = smoothstep(color.r, sin(t2), sin(t));
        vec3 ink = mix(vec3(0.12, 0.45, 0.58), vec3(0.94, 0.55, 0.28), smoothstep(0.18, 0.92, uv2.x));
        vec3 tint = mix(ink, vec3(0.75, 0.94, 0.88), waves * 0.22);
        float centerFade = smoothstep(1.22, 0.12, length((uv2 - 0.5) * vec2(1.18, 0.92)));
        float softWave = smoothstep(0.28, 0.72, waves);
        float alpha = softWave * centerFade * 0.46;

        gl_FragColor = vec4(tint * (0.30 + softWave * 0.58), alpha);
      }
    `;

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    container.appendChild(renderer.domElement);

    const onResize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      uniforms.u_resolution.value.set(renderer.domElement.width, renderer.domElement.height);
    };

    onResize();
    window.addEventListener("resize", onResize);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      if (activeRef.current && document.visibilityState === "visible") {
        uniforms.u_time.value = reduceMotion ? 8 : clock.getElapsedTime() * 0.54;
        renderer.render(scene, camera);
      }
    };

    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", onResize);
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
      geometry.dispose();
      material.dispose();
    };
  }, []);

  return <div ref={containerRef} className={className} aria-hidden="true" />;
}
