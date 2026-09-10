import { Color, ShaderMaterial } from "three";

export const COLORMAPS = ["turbo", "viridis", "rainbow", "gray"] as const;
export type Colormap = (typeof COLORMAPS)[number];

export const COLOR_MODES = ["flat", "scalar", "z", "rgb"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

const MODE_INDEX: Record<ColorMode, number> = { flat: 0, scalar: 1, z: 2, rgb: 3 };
const CMAP_INDEX: Record<Colormap, number> = { turbo: 0, viridis: 1, rainbow: 2, gray: 3 };

const VERT = /* glsl */ `
attribute float scalar;
attribute vec3 rgb;
uniform float pointSize;
uniform float pixelRatio;
varying float vScalar;
varying float vZ;
varying vec3 vRgb;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vZ = world.z;
  vScalar = scalar;
  vRgb = rgb;
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = pointSize * pixelRatio;
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform int mode;
uniform int colormap;
uniform float minV;
uniform float maxV;
uniform vec3 flatColor;
uniform float opacity;
uniform bool round;
uniform float zMin;
uniform float zMax;
varying float vScalar;
varying float vZ;
varying vec3 vRgb;

vec3 turbo(float t) {
  const vec4 kRedVec4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kGreenVec4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kBlueVec4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kRedVec2 = vec2(-152.94239396, 59.28637943);
  const vec2 kGreenVec2 = vec2(4.27729857, 2.82956604);
  const vec2 kBlueVec2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, t, t * t, t * t * t);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(
    dot(v4, kRedVec4) + dot(v2, kRedVec2),
    dot(v4, kGreenVec4) + dot(v2, kGreenVec2),
    dot(v4, kBlueVec4) + dot(v2, kBlueVec2)), 0.0, 1.0);
}

vec3 viridis(float t) {
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
  const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
  const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}

vec3 rainbow(float t) {
  float h = (1.0 - t) * 0.75; // red (high) -> violet (low), like rviz
  vec3 k = vec3(3.0, 2.0, 1.0);
  vec3 p = abs(fract(h + k / 3.0) * 6.0 - 3.0);
  return clamp(p - 1.0, 0.0, 1.0);
}

void main() {
  if (vZ < zMin || vZ > zMax) discard;
  if (round) {
    vec2 c = gl_PointCoord - vec2(0.5);
    if (dot(c, c) > 0.25) discard;
  }
  vec3 col = flatColor;
  if (mode == 3) {
    col = vRgb;
  } else if (mode != 0) {
    float v = (mode == 1) ? vScalar : vZ;
    float t = clamp((v - minV) / max(maxV - minV, 1e-6), 0.0, 1.0);
    if (colormap == 0) col = turbo(t);
    else if (colormap == 1) col = viridis(t);
    else if (colormap == 2) col = rainbow(t);
    else col = vec3(t);
  }
  gl_FragColor = vec4(col, opacity);
}
`;

export interface PointsMaterialOptions {
  pointSize: number;
  mode: ColorMode;
  colormap: Colormap;
  minV: number;
  maxV: number;
  flatColor: string;
  opacity: number;
  round: boolean;
  /** Points outside [zMin, zMax] (fixed-frame z, meters) are hidden. */
  zMin?: number;
  zMax?: number;
}

/** Shared shader material for point clouds and laser scans. */
export function createPointsMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      pointSize: { value: 2 },
      pixelRatio: { value: window.devicePixelRatio || 1 },
      mode: { value: 1 },
      colormap: { value: 0 },
      minV: { value: 0 },
      maxV: { value: 1 },
      flatColor: { value: new Color("#ffffff") },
      opacity: { value: 1 },
      round: { value: true },
      zMin: { value: -1e9 },
      zMax: { value: 1e9 },
    },
    transparent: true,
    depthWrite: true,
  });
}

export function applyPointsMaterialOptions(mat: ShaderMaterial, o: PointsMaterialOptions): void {
  const u = mat.uniforms;
  u.pointSize!.value = o.pointSize;
  u.pixelRatio!.value = window.devicePixelRatio || 1;
  u.mode!.value = MODE_INDEX[o.mode] ?? 1;
  u.colormap!.value = CMAP_INDEX[o.colormap] ?? 0;
  u.minV!.value = o.minV;
  u.maxV!.value = o.maxV;
  (u.flatColor!.value as Color).set(o.flatColor);
  u.opacity!.value = o.opacity;
  u.round!.value = o.round;
  u.zMin!.value = Number.isFinite(o.zMin ?? NaN) ? (o.zMin as number) : -1e9;
  u.zMax!.value = Number.isFinite(o.zMax ?? NaN) ? (o.zMax as number) : 1e9;
  mat.transparent = o.opacity < 1;
  mat.depthWrite = o.opacity >= 1;
}
