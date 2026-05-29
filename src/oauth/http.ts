/**
 * Thin bridge between node:http and the Web-standard Request/Response
 * that almanac-oauth's handlers expect.
 *
 * Node 22 has global Request/Response, so construction is native; we just
 * marshal the headers and the body.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export async function nodeReqToWebRequest(req: IncomingMessage): Promise<Request> {
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (typeof value === "string") headers.set(name, value);
  }

  let body: string | undefined;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  return new Request(url, { method: req.method, headers, body });
}

export async function writeWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    // Set-Cookie is the one header that can legitimately repeat. Headers
    // collapses duplicates with commas on .get() but preserves them on
    // .forEach(), so iterating here yields each cookie separately.
    if (key.toLowerCase() === "set-cookie") {
      const existing = res.getHeader("set-cookie");
      if (Array.isArray(existing)) res.setHeader("set-cookie", [...existing, value]);
      else if (existing) res.setHeader("set-cookie", [String(existing), value]);
      else res.setHeader("set-cookie", value);
    } else {
      res.setHeader(key, value);
    }
  });

  if (webRes.body) {
    const reader = webRes.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
