// Transparent logging proxy so we can see exactly what the gateway sends to
// the authorization server, byte for byte. Uses node's http client rather than
// fetch because it has to forward the Host header, which fetch forbids.
import http from "node:http";

const LISTEN = Number(process.env.LISTEN ?? 8821);
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 8823);
const WATCH = (process.env.WATCH ?? "/token,/reg").split(",");

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const interesting = WATCH.some((p) => req.url.startsWith(p));
      if (interesting) {
        process.stdout.write(`\n>>> ${req.method} ${req.url}\n`);
        for (const key of ["authorization", "content-type", "dpop"]) {
          if (req.headers[key]) process.stdout.write(`    ${key}: ${req.headers[key]}\n`);
        }
        if (body.length) process.stdout.write(`    body: ${body.toString().slice(0, 700)}\n`);
        const auth = req.headers.authorization ?? "";
        if (auth.startsWith("Basic ")) {
          process.stdout.write(
            `    decoded basic: ${Buffer.from(auth.slice(6), "base64").toString()}\n`,
          );
        }
      }

      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: TARGET_PORT,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `127.0.0.1:${LISTEN}` },
        },
        (up) => {
          const out = [];
          up.on("data", (c) => out.push(c));
          up.on("end", () => {
            const text = Buffer.concat(out);
            if (interesting) {
              process.stdout.write(`<<< ${up.statusCode} ${text.toString().slice(0, 500)}\n`);
            }
            res.writeHead(up.statusCode, up.headers);
            res.end(text);
          });
        },
      );
      upstream.on("error", (error) => {
        res.writeHead(502);
        res.end(String(error));
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  })
  .listen(LISTEN, "127.0.0.1", () => {
    process.stdout.write(`proxy ${LISTEN} -> ${TARGET_PORT}\n`);
  });
