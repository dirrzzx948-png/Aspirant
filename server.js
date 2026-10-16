
import express from "express";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const history = [];

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] >= 224;
}

async function validatePublicUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("URL tidak valid.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Hanya URL HTTP/HTTPS yang diizinkan.");
  }

  if (url.username || url.password) {
    throw new Error("URL dengan kredensial tidak diizinkan.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    throw new Error("Alamat lokal tidak diizinkan.");
  }

  if (net.isIP(host) === 4) {
    if (isPrivateIPv4(host)) throw new Error("IP privat tidak diizinkan.");
  } else if (net.isIP(host) === 6) {
    throw new Error("Alamat IPv6 tidak didukung oleh pemeriksaan ini.");
  } else {
    const records = await dns.lookup(host, { all: true });
    if (!records.length || records.some(r =>
      r.family === 4 ? isPrivateIPv4(r.address) : true
    )) {
      throw new Error("Domain mengarah ke alamat yang tidak diizinkan.");
    }
  }

  return url;
}

async function fetchPublic(urlString, options = {}) {
  let current = urlString;

  for (let i = 0; i < 4; i++) {
    await validatePublicUrl(current);

    const response = await fetch(current, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return response;
      current = new URL(location, current).href;
      continue;
    }

    return response;
  }

  throw new Error("Terlalu banyak pengalihan URL.");
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
    const input = String(req.body?.url || "");
    const url = await validatePublicUrl(input);
    const response = await fetchPublic(url.href, {
      headers: { "User-Agent": "Aspirant/1.0" }
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Website merespons HTTP ${response.status}.`
      });
    }

    const type = response.headers.get("content-type") || "";

    if (!type.includes("text/html")) {
      return res.status(415).json({
        error: "URL tidak mengembalikan dokumen HTML."
      });
    }

    const html = await response.text();

    if (html.length > 3_000_000) {
      return res.status(413).json({ error: "Halaman terlalu besar." });
    }

    const { load } = await import("cheerio");
    const $ = load(html);

    const links = $("a[href]").map((_, el) => ({
      text: $(el).text().trim().slice(0, 300),
      url: new URL($(el).attr("href"), url).href
    })).get().slice(0, 500);

    const images = $("img[src]").map((_, el) => ({
      alt: $(el).attr("alt") || "",
      url: new URL($(el).attr("src"), url).href
    })).get().slice(0, 200);

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
      links,
      images,
      timestamp: new Date().toISOString()
    };

    history.unshift(result);
    if (history.length > 100) history.pop();

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Aspirant berjalan pada port ${PORT}`);
});
