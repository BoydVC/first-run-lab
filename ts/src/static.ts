import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export function serveDir(root: string): Promise<StaticServer> {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
    const rel = pathname.replace(/^\/+/, "");
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(file, (statErr, st) => {
      if (!statErr && st.isDirectory()) {
        const index = path.join(file, "index.html");
        if (fs.existsSync(index)) {
          res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
          fs.createReadStream(index).pipe(res);
          return;
        }
        const names = fs.readdirSync(file).filter((n) => !n.startsWith("."));
        const items = names.map((n) => `<li><a href="${encodeURIComponent(n)}">${n}</a></li>`).join("");
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset=utf-8><title>Index</title><ul>${items}</ul>`);
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404).end("not found");
          return;
        }
        const type = TYPES[path.extname(file)] || "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(data);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
