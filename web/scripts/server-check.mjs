import http from "node:http";

const port = Number(process.env.PORT || 4173);
const url = `http://127.0.0.1:${port}/api/health`;

requestJson(url)
  .then(({ status, body }) => {
    if (status !== 200) {
      throw new Error(`Health check failed with status ${status}`);
    }
    if (!body?.ok || body?.service !== "smartrecord-pack-station" || body?.port !== port) {
      throw new Error(`Unexpected health payload: ${JSON.stringify(body)}`);
    }
    console.log(`[server:check] ok ${url}`);
  })
  .catch((error) => {
    console.error(`[server:check] failed ${url}`);
    console.error(error.message || error);
    process.exit(1);
  });

function requestJson(targetUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(targetUrl, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({
            status: res.statusCode || 0,
            body: JSON.parse(text)
          });
        } catch {
          reject(new Error(`Health endpoint did not return JSON: ${text.slice(0, 160)}`));
        }
      });
    });
    req.on("error", reject);
  });
}
