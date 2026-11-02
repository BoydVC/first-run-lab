import path from "node:path";
import { run } from "./engine.ts";
import { BUILTIN } from "./personas.ts";
import { writeGif } from "./replay.ts";
import { REPO_ROOT } from "./root.ts";
import { serveDir } from "./static.ts";

const examples = path.join(REPO_ROOT, "examples");
const badOut = path.join(REPO_ROOT, "runs", "demo-bad");
const fixedOut = path.join(REPO_ROOT, "runs", "demo-fixed");
const srv = await serveDir(examples);
try {
  const bad = await run({
    url: new URL("signup.html", srv.url).href,
    out: badOut,
    personas: BUILTIN,
    kind: "form",
    shots: true,
  });
  const fixed = await run({
    url: new URL("signup-fixed.html", srv.url).href,
    out: fixedOut,
    personas: BUILTIN,
    kind: "form",
    shots: true,
  });
  console.log("bad", bad.verdict, "hotspots", bad.hotspots.length);
  console.log("fixed", fixed.verdict);
  await writeGif({
    badDir: badOut,
    fixedDir: fixedOut,
    gif: path.join(REPO_ROOT, "screenshots", "demo-ts.gif"),
  });
  console.log("wrote screenshots/demo-ts.gif");
} finally {
  await srv.close();
}
