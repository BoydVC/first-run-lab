import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMcCfg, renderSessionTla } from "./tla.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "spec");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "Session.tla"), renderSessionTla());
writeFileSync(join(root, "MC.cfg"), renderMcCfg());
console.log(`wrote ${join(root, "Session.tla")}`);
