import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderMcCfg, renderSessionTla } from "../src/tla.js";

const exec = promisify(execFile);
const jar = join(import.meta.dirname, "..", ".tools", "tla2tools.jar");

async function ensureJar(): Promise<void> {
  const { existsSync } = await import("node:fs");
  if (existsSync(jar)) return;
  mkdirSync(join(jar, ".."), { recursive: true });
  try {
    await exec("curl", ["-fsSL", "-o", jar, "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"]);
  } catch {
    await exec("curl", ["-fsSL", "-o", jar, "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"]);
  }
}

async function tlc(dir: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(
      "java",
      ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "2", "-config", "MC.cfg", "Session.tla"],
      { cwd: dir, maxBuffer: 4_000_000 },
    );
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("AT13 TLC", () => {
  it("checks I1–I6 with no violations, and a missing crashed→reported edge fails I1", async () => {
    await ensureJar();
    const good = join(tmpdir(), `frl-tlc-good-${process.pid}`);
    const bad = join(tmpdir(), `frl-tlc-mutant-${process.pid}`);
    mkdirSync(good, { recursive: true });
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(good, "Session.tla"), renderSessionTla());
    writeFileSync(join(good, "MC.cfg"), renderMcCfg());
    writeFileSync(join(bad, "Session.tla"), renderSessionTla({ drop: [["crashed", "reported"]] }));
    writeFileSync(join(bad, "MC.cfg"), renderMcCfg());
    const ok = await tlc(good);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toMatch(/No error has been found|Model checking completed/);
    const mutant = await tlc(bad);
    expect(mutant.code).not.toBe(0);
    expect(mutant.out).toMatch(/I1|Temporal properties were violated|Error/);
  }, 90_000);
});
