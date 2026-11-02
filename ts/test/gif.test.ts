import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scanGif } from "../src/replay.js";

const gif = join(import.meta.dirname, "..", "..", "screenshots", "demo-ts.gif");

describe("demo gif", () => {
  it("is about 14 frames, under 1 MB, and OCR-clean", () => {
    const bytes = statSync(gif).size;
    assert.ok(bytes < 1_000_000, `${bytes} bytes`);
    assert.ok(bytes > 20_000);
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", gif,
    ], { encoding: "utf8" });
    const frames = Number((probe.stdout || "").trim());
    assert.ok(frames >= 12 && frames <= 16, `frames ${frames}`);
    scanGif(gif);
  });
});
