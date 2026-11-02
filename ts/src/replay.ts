import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privacyHits, PrivacyError } from "./privacy.js";

/** OCR every GIF frame and refuse to keep the file if the privacy scan hits. */
export function scanGif(gifPath: string): void {
  const dir = mkdtempSync(join(tmpdir(), "frl-gif-"));
  try {
    const extracted = spawnSync("ffmpeg", ["-y", "-i", gifPath, join(dir, "f%02d.png")], { stdio: "ignore" });
    if (extracted.status !== 0) throw new Error("ffmpeg could not read the gif");
    const frames = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    if (!frames.length) throw new Error("gif had no frames");
    const texts: string[] = [];
    for (const f of frames) {
      const ocr = spawnSync("tesseract", [join(dir, f), "-"], { encoding: "utf8" });
      texts.push(ocr.stdout || "");
    }
    const hits = privacyHits(texts.join("\n"));
    if (hits.length) throw new PrivacyError(hits);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function assertGif(gifPath: string, maxBytes = 1_000_000): { bytes: number; frames: number } {
  scanGif(gifPath);
  const buf = readFileSync(gifPath);
  if (buf.length > maxBytes) throw new Error(`gif is ${buf.length} bytes, over ${maxBytes}`);
  // Netscape GIF: count image separators roughly via ffmpeg
  const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", gifPath], { encoding: "utf8" });
  const frames = Number((probe.stdout || "").trim()) || 0;
  return { bytes: buf.length, frames };
}

export function writeCaptionScript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n"));
}
