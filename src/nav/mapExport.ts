/**
 * Save an occupancy grid the way Nav2's map_saver does: a trinary PGM image
 * and a YAML file map_server can load again.
 */

import type { OccupancyGrid } from "../ros/types";
import { isDesktop } from "../updater";

export interface MapFiles {
  /** File name without extension; the YAML refers to `<base>.pgm`. */
  base: string;
  pgm: Uint8Array;
  yaml: string;
}

const FREE_THRESH = 0.25;
const OCCUPIED_THRESH = 0.65;

export function encodeMap(grid: OccupancyGrid, base: string): MapFiles {
  const { width, height, resolution, origin } = grid.info;
  const header = new TextEncoder().encode(`P5\n# CREATOR: iViz ${resolution.toFixed(3)} m/pix\n${width} ${height}\n255\n`);
  const pgm = new Uint8Array(header.length + width * height);
  pgm.set(header);
  const free = Math.round(FREE_THRESH * 100);
  const occupied = Math.round(OCCUPIED_THRESH * 100);
  const data = grid.data;
  for (let row = 0; row < height; row++) {
    // Image rows run top-down; grid rows run from the origin upwards.
    const src = (height - 1 - row) * width;
    const dst = header.length + row * width;
    for (let x = 0; x < width; x++) {
      const v = data[src + x] ?? -1;
      pgm[dst + x] = v < 0 || v > 100 ? 205 : v <= free ? 254 : v >= occupied ? 0 : 205;
    }
  }
  const q = origin.orientation;
  const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  const yaml = [
    `image: ${base}.pgm`,
    "mode: trinary",
    `resolution: ${fmt(resolution)}`,
    `origin: [${fmt(origin.position.x)}, ${fmt(origin.position.y)}, ${fmt(yaw)}]`,
    "negate: 0",
    `occupied_thresh: ${OCCUPIED_THRESH}`,
    `free_thresh: ${FREE_THRESH}`,
    "",
  ].join("\n");
  return { base, pgm, yaml };
}

/**
 * Ask where to save and write both files. Resolves with the YAML path, or
 * null when the user cancelled. In the browser build both files download.
 */
export async function saveMapFiles(files: MapFiles): Promise<string | null> {
  if (!isDesktop()) {
    download(`${files.base}.pgm`, files.pgm, "image/x-portable-graymap");
    download(`${files.base}.yaml`, new TextEncoder().encode(files.yaml), "application/yaml");
    return `${files.base}.yaml`;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const chosen = await save({
    title: "Save map",
    defaultPath: `${files.base}.yaml`,
    filters: [{ name: "Nav2 map (YAML + PGM)", extensions: ["yaml"] }],
  });
  if (!chosen) return null;
  const sep = chosen.includes("\\") ? "\\" : "/";
  const cut = chosen.lastIndexOf(sep);
  const dir = chosen.slice(0, cut);
  const base = chosen.slice(cut + 1).replace(/\.ya?ml$/i, "") || files.base;
  const yamlPath = `${dir}${sep}${base}.yaml`;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_map_files", {
    yamlPath,
    yaml: files.yaml.replace(/^image: .*$/m, `image: ${base}.pgm`),
    pgmPath: `${dir}${sep}${base}.pgm`,
    pgmBase64: toBase64(files.pgm),
  });
  return yamlPath;
}

/** A file name for a map saved now, e.g. `map_20260912_1432`. */
export function defaultMapName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `map_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

function fmt(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function download(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
