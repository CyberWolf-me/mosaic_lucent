import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("redesign");
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/" || reqPath === "") reqPath = "/Lucent v2.html";
  const f = path.join(dir, reqPath);

  if (!fs.existsSync(f)) {
    res.statusCode = 404;
    return res.end("Not found");
  }

  const stat = fs.statSync(f);
  if (stat.isDirectory()) {
    const idx = path.join(f, "Lucent v2.html");
    if (fs.existsSync(idx)) {
      res.setHeader("Content-Type", "text/html");
      return fs.createReadStream(idx).pipe(res);
    }
    res.statusCode = 403;
    return res.end("Directory");
  }

  const ext = path.extname(f);
  res.setHeader("Content-Type", mime[ext] || "text/plain");
  fs.createReadStream(f).pipe(res);
});

server.listen(5174, () => {
  console.log("Redesign prototype running on http://localhost:5174/");
});
