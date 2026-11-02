import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { GIFEncoder, applyPalette, quantize } from "gifenc/dist/gifenc.esm.js";
import { privacyHits } from "./privacy.js";

export const GIF_W = 800;
export const GIF_H = 560;

export function scalePng(src: PNG, width: number, height: number): PNG {
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const si = (sy * src.width + sx) << 2;
      const di = (y * width + x) << 2;
      dst.data[di] = src.data[si] ?? 0;
      dst.data[di + 1] = src.data[si + 1] ?? 0;
      dst.data[di + 2] = src.data[si + 2] ?? 0;
      dst.data[di + 3] = 255;
    }
  }
  return dst;
}

export function encodeGif(frames: readonly PNG[], delayMs = 800): Uint8Array {
  const gif = new GIFEncoder();
  frames.forEach((frame, index) => {
    const scaled = frame.width === GIF_W && frame.height === GIF_H ? frame : scalePng(frame, GIF_W, GIF_H);
    const rgba = scaled.data;
    const palette = quantize(rgba, 64);
    const indexed = applyPalette(rgba, palette);
    const opts = index === 0 ? { palette, delay: delayMs, repeat: 0 } : { palette, delay: delayMs };
    gif.writeFrame(indexed, GIF_W, GIF_H, opts);
  });
  gif.finish();
  return gif.bytes();
}

export function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

/** Scale a cropped control shot and draw a highlight ring around the frame. */
export function paintRing(src: PNG): PNG {
  const dst = scalePng(src, GIF_W, GIF_H);
  const thick = 8;
  for (let y = 0; y < dst.height; y += 1) {
    for (let x = 0; x < dst.width; x += 1) {
      if (x >= thick && y >= thick && x < dst.width - thick && y < dst.height - thick) continue;
      const i = (y * dst.width + x) << 2;
      dst.data[i] = 180;
      dst.data[i + 1] = 16;
      dst.data[i + 2] = 16;
      dst.data[i + 3] = 255;
    }
  }
  return dst;
}

export interface OcrScan {
  text: string;
  hits: string[];
}

export async function ocrFile(path: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec("tesseract", [path, "stdout", "-l", "eng", "--psm", "6"], { maxBuffer: 2_000_000 });
  return stdout;
}

/** Regex plus OCR. Returns hits; callers must refuse to keep the artifact when hits is non-empty. */
export async function privacyScanMedia(paths: readonly string[], denylist?: readonly string[]): Promise<OcrScan> {
  const parts: string[] = [];
  for (const path of paths) {
    if (path.endsWith(".json") || path.endsWith(".html") || path.endsWith(".txt") || path.endsWith(".md")) {
      parts.push(readFileSync(path, "utf8"));
      continue;
    }
    parts.push(await ocrFile(path));
  }
  const text = parts.join("\n");
  return { text, hits: privacyHits(text, denylist) };
}

export function writeGif(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes);
}
