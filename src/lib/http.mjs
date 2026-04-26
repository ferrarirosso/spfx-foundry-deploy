import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqFn = parsedUrl.protocol === "https:" ? httpsRequest : httpRequest;

    const req = reqFn(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || 30_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timeout: ${url}`));
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}
