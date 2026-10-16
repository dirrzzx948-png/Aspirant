
import express from "express";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC));

const history = [];
const MAX_HISTORY = 100;

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  return p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168);
}

function isPrivateIPv6(ip) {
  const address = ip.toLowerCase().split("%")[0];

  return address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/.test(address) ||
    address.startsWith("::ffff:");
}

async function validatePublicUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("URL tidak valid.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Hanya URL HTTP dan HTTPS yang didukung.");
  }

  if (url.username || url.password) {
    throw new Error("URL yang berisi kredensial tidak diizinkan.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Alamat lokal tidak diizinkan.");
  }

  const family = net.isIP(host);

  if (family === 4) {
    if (isPrivateIPv4(host)) {
      throw new Error("IP privat tidak diizinkan.");
    }
  } else if (family === 6) {
    if (isPrivateIPv6(host)) {
      throw new Error("IP privat tidak diizinkan.");
    }
    throw new Error("IPv6 belum didukung oleh pemeriksaan URL ini.");
  } else {
    const records = await dns.lookup(host, { all: true });

    if (!records.length) {
      throw new Error("Domain tidak ditemukan.");
    }

    if (records.some(record =>
      record.family === 4
        ? isPrivateIPv4(record.address)
        : isPrivateIPv6(record.address)
    )) {
      throw new Error("Domain mengarah ke IP yang tidak diizinkan.");
    }
  }

  return url;
}

async function fetchPublic(urlString, options = {}) {
  let current = urlString;

  for (let redirects = 0; redirects <= 3; redirects++) {
    await validatePublicUrl(current);

    const response = await fetch(current, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get("location");

    if (!location) return response;

    current = new URL(location, current).href;
    await response.body?.cancel();
  }

  throw new Error("Terlalu banyak pengalihan URL.");
}

function saveHistory(entry) {
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.pop();
}

function safeHeaders(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Headers harus berupa objek JSON.");
  }

  const result = {};

  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`Nama header tidak valid: ${name}`);
    }

    if (/^(host|connection|content-length|transfer-encoding|cookie|authorization|proxy-authorization)$/i.test(name)) {
      throw new Error(`Header ${name} tidak diizinkan.`);
    }

    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new Error(`Nilai header ${name} tidak valid.`);
    }

    result[name] = value;
  }

  return result;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Aspirant",
    version: "1.0.0",
    time: new Date().toISOString()
  });
});

app.get("/api/ping", async (req, res) => {
  const start = performance.now();

  try {
    const response = await fetch(
      `http://127.0.0.1:${PORT}/api/health`,
      { signal: AbortSignal.timeout(3000) }
    );

    res.json({
      ok: response.ok,
      latency: Math.round(performance.now() - start),
      unit: "ms"
    });
  } catch {
    res.status(503).json({
      ok: false,
      latency: null,
      message: "Server tidak merespons."
    });
  }
});

app.post("/api/scrape", async (req, res) => {
  try {
    const url = await validatePublicUrl(String(req.body?.url || ""));

    const response = await fetchPublic(url.href, {
      headers: { "User-Agent": "Aspirant/1.0" }
    });

    if (!response.ok) {
      await response.body?.cancel();
      return res.status(502).json({
        error: `Website merespons HTTP ${response.status}.`
      });
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      await response.body?.cancel();
      return res.status(415).json({
        error: "URL tidak mengembalikan halaman HTML."
      });
    }

    const html = await response.text();

    if (html.length > 3_000_000) {
      return res.status(413).json({
        error: "Halaman terlalu besar."
      });
    }

    const { load } = await import("cheerio");
    const $ = load(html);

    const result = {
      id: randomUUID(),
      source: url.href,
      title: $("title").first().text().trim(),
      description:
        $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        "",
      headings: $("h1,h2,h3").map((_, el) => ({
        tag: el.tagName,
        text: $(el).text().trim()
      })).get().slice(0, 200),
      links: $("a[href]").map((_, el) => {
        let link = "";
        try {
          link = new URL($(el).attr("href"), url).href;
        } catch {}
        return {
          text: $(el).text().trim().slice(0, 300),
          url: link
        };
      }).get().filter(item => item.url).slice(0, 500),
      images: $("img[src]").map((_, el) => {
        let image = "";
        try {
          image = new URL($(el).attr("src"), url).href;
        } catch {}
        return {
          alt: $(el).attr("alt") || "",
          url: image
        };
      }).get().filter(item => item.url).slice(0, 200),
      timestamp: new Date().toISOString()
    };

    saveHistory(result);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      error: error.message || "Scraping gagal."
    });
  }
});

app.get("/api/history", (req, res) => {
  res.json(history);
});

app.delete("/api/history", (req, res) => {
  history.length = 0;
  res.json({ ok: true });
});

app.delete("/api/history/:id", (req, res) => {
  const index = history.findIndex(item => item.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Riwayat tidak ditemukan." });
  }

  history.splice(index, 1);
  res.json({ ok: true });
});

app.post("/api/request", async (req, res) => {
  const start = performance.now();

  try {
    const { url: input, method = "GET", headers = {}, body, contentType } = req.body || {};
    const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

    if (!allowedMethods.includes(method)) {
      return res.status(400).json({ error: "Metode HTTP tidak didukung." });
    }

    const url = await validatePublicUrl(String(input || ""));
    const requestHeaders = safeHeaders(headers);

    if (body !== undefined && !["GET", "HEAD"].includes(method)) {
      requestHeaders["Content-Type"] ||= contentType === "text/plain"
        ? "text/plain"
        : "application/json";
    }

    const response = await fetchPublic(url.href, {
      method,
      headers: requestHeaders,
      body: body === undefined || ["GET", "HEAD"].includes(method)
        ? undefined
        : String(body)
    });

    const responseHeaders = Object.fromEntries(response.headers.entries());
    const responseType = response.headers.get("content-type") || "";

    let text = "";

    if (method !== "HEAD") {
      const reader = response.body?.getReader();
      const chunks = [];
      let total = 0;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          total += value.byteLength;

          if (total > 1_000_000) {
            await reader.cancel();
            throw new Error("Respons melebihi batas 1 MB.");
          }

          chunks.push(value);
        }
      }

      const buffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));

      text = responseType.includes("application/json")
        ? buffer.toString("utf8")
        : buffer.toString("utf8");
    }

    res.json({
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: text,
      duration: Math.round(performance.now() - start)
    });
  } catch (error) {
    res.status(400).json({
      error: error.message || "Request gagal."
    });
  }
});

app.get("*path", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API endpoint tidak ditemukan." });
  }

  res.sendFile(path.join(PUBLIC, "index.html"), error => {
    if (error) next(error);
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Terjadi kesalahan internal." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Aspirant berjalan pada port ${PORT}`);
});
