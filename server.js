
"use strict";

const express = require("express");
const cheerio = require("cheerio");
const dns = require("node:dns/promises");
const net = require("node:net");
const path = require("node:path");
const { Transform, Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, "public");

const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024;
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT = 30000;
const MAX_HISTORY = 100;

const history = [];
let nextHistoryId = 1;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(express.static(PUBLIC, {
  index: "index.html",
  dotfiles: "deny"
}));

function jsonError(res, status, message) {
  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => n < 0 || n > 255)) {
    return true;
  }

  const [a, b, c] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPrivateIPv6(ip) {
  const address = ip.toLowerCase().split("%")[0];

  if (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/.test(address) ||
    address.startsWith("ff") ||
    address.startsWith("2001:db8")
  ) {
    return true;
  }

  const mapped = address.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);

  if (mapped) {
    return isPrivateIPv4(mapped[1]);
  }

  return false;
}

function isPrivateAddress(ip) {
  const version = net.isIP(ip);

  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);

  return true;
}

async function validatePublicURL(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("URL tidak valid.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Hanya URL HTTP dan HTTPS yang didukung.");
  }

  if (url.username || url.password) {
    throw new Error("URL dengan kredensial tidak diizinkan.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("Alamat lokal tidak diizinkan.");
  }

  const ipVersion = net.isIP(hostname);

  if (ipVersion) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Alamat IP privat tidak diizinkan.");
    }
    return url;
  }

  let records;

  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Domain tidak dapat ditemukan.");
  }

  if (!records.length) {
    throw new Error("Domain tidak memiliki alamat IP.");
  }

  if (records.some(record => isPrivateAddress(record.address))) {
    throw new Error("Domain mengarah ke alamat IP yang tidak diizinkan.");
  }

  return url;
}

/*
 * Fetch URL publik dan validasi setiap tujuan redirect.
 * Catatan: validasi DNS ini bukan perlindungan SSRF sempurna
 * untuk server yang dibuka ke internet.
 */
async function fetchPublic(input, options = {}) {
  let currentURL = await validatePublicURL(input);
  const method = options.method || "GET";
  const headers = options.headers || {};
  const body = options.body;
  const signal = options.signal;

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    const response = await fetch(currentURL, {
      method,
      headers,
      body,
      signal,
      redirect: "manual",
      signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT)
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: currentURL };
    }

    const location = response.headers.get("location");

    if (!location) {
      return { response, url: currentURL };
    }

    await response.body?.cancel().catch(() => {});

    if (attempt === MAX_REDIRECTS) {
      throw new Error("Terlalu banyak redirect.");
    }

    currentURL = await validatePublicURL(
      new URL(location, currentURL).href
    );
  }

  throw new Error("Redirect tidak dapat diselesaikan.");
}

function trimText(value, maxLength = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeFilename(value) {
  let name = path.basename(String(value || "download"));

  name = name
    .replace(/[\r\n"]/g, "")
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 120);

  if (!name || name === "." || name === "..") {
    return "download";
  }

  return name;
}

function encodeDispositionFilename(filename) {
  const safe = safeFilename(filename);
  const fallback = safe.replace(/[^\x20-\x7E]/g, "_");

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/* Health */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Aspirant",
    version: "1.0.0",
    uptime: Math.round(process.uptime())
  });
});

/* Ping */
app.get("/api/ping", (req, res) => {
  const start = process.hrtime.bigint();

  const latency = Number(process.hrtime.bigint() - start) / 1e6;

  res.json({
    ok: true,
    latency: Math.max(0, Math.round(latency * 100) / 100)
  });
});

/* Web Scraper */
app.post("/api/scrape", async (req, res) => {
  try {
    const input = String(req.body?.url || "").trim();

    if (!input) {
      return jsonError(res, 400, "URL wajib diisi.");
    }

    const { response, url } = await fetchPublic(input, {
      headers: {
        "User-Agent": "Aspirant-Utility/1.0",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return jsonError(res, 502, `Website merespons HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("text/html") &&
        !contentType.toLowerCase().includes("application/xhtml+xml")) {
      await response.body?.cancel().catch(() => {});
      return jsonError(res, 415, "URL tersebut bukan halaman HTML.");
    }

    const declaredSize = Number(response.headers.get("content-length") || 0);

    if (declaredSize > MAX_RESPONSE_SIZE) {
      await response.body?.cancel().catch(() => {});
      return jsonError(res, 413, "Halaman terlalu besar untuk diproses.");
    }

    const chunks = [];
    let size = 0;

    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;

        if (size > MAX_RESPONSE_SIZE) {
          return jsonError(res, 413, "Ukuran halaman melebihi batas 2 MB.");
        }

        chunks.push(Buffer.from(chunk));
      }
    }

    const html = Buffer.concat(chunks).toString("utf8");
    const $ = cheerio.load(html);

    const title = trimText(
      $("meta[property='og:title']").attr("content") ||
      $("title").first().text() ||
      ""
    );

    const description = trimText(
      $("meta[name='description']").attr("content") ||
      $("meta[property='og:description']").attr("content") ||
      ""
    );

    const headings = [];

    $("h1,h2,h3,h4,h5,h6").each((_, element) => {
      const text = trimText($(element).text(), 300);

      if (text) {
        headings.push({
          tag: element.tagName.toLowerCase(),
          text
        });
      }
    });

    const links = [];

    $("a[href]").each((_, element) => {
      if (links.length >= 300) return false;

      try {
        const linkURL = new URL($(element).attr("href"), url);

        if (!["http:", "https:"].includes(linkURL.protocol)) return;

        links.push({
          text: trimText($(element).text(), 200),
          url: linkURL.href
        });
      } catch {
        // Abaikan URL yang tidak valid.
      }
    });

    const images = [];

    $("img").each((_, element) => {
      if (images.length >= 200) return false;

      const src =
        $(element).attr("src") ||
        $(element).attr("data-src") ||
        "";

      if (!src) return;

      try {
        const imageURL = new URL(src, url);

        if (!["http:", "https:"].includes(imageURL.protocol)) return;

        images.push({
          alt: trimText($(element).attr("alt"), 200),
          url: imageURL.href
        });
      } catch {
        // Abaikan URL gambar yang tidak valid.
      }
    });

    const result = {
      title: title || "Untitled page",
      description,
      source: url.href,
      timestamp: new Date().toISOString(),
      headings,
      links,
      images
    };

    history.unshift({
      id: String(nextHistoryId++),
      ...result
    });

    if (history.length > MAX_HISTORY) {
      history.length = MAX_HISTORY;
    }

    res.json(result);
  } catch (error) {
    jsonError(res, 400, error.message || "Gagal mengambil halaman.");
  }
});

/* History */
app.get("/api/history", (req, res) => {
  res.json(history);
});

app.delete("/api/history", (req, res) => {
  history.length = 0;
  res.json({ ok: true, message: "History cleared." });
});

app.delete("/api/history/:id", (req, res) => {
  const index = history.findIndex(item => item.id === req.params.id);

  if (index === -1) {
    return jsonError(res, 404, "History tidak ditemukan.");
  }

  history.splice(index, 1);
  res.json({ ok: true });
});

/* API Tester */
app.post("/api/request", async (req, res) => {
  const started = Date.now();

  try {
    const input = String(req.body?.url || "").trim();
    const method = String(req.body?.method || "GET").toUpperCase();

    const allowedMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

    if (!allowedMethods.includes(method)) {
      return jsonError(res, 400, "HTTP method tidak didukung.");
    }

    if (!input) {
      return jsonError(res, 400, "URL wajib diisi.");
    }

    let headers = req.body?.headers || {};

    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      return jsonError(res, 400, "Headers harus berupa objek JSON.");
    }

    const filteredHeaders = {};

    for (const [key, value] of Object.entries(headers)) {
      if (
        typeof value === "string" &&
        !/^(host|connection|content-length|transfer-encoding|cookie|authorization|proxy-authorization)$/i.test(key)
      ) {
        filteredHeaders[key] = value.slice(0, 2000);
      }
    }

    const contentType = String(
      req.body?.contentType || "application/json"
    );

    if (!["application/json", "text/plain"].includes(contentType)) {
      return jsonError(res, 400, "Content type tidak didukung.");
    }

    let body;

    if (!["GET", "HEAD"].includes(method) && req.body?.body !== undefined) {
      body = String(req.body.body);
      filteredHeaders["Content-Type"] ||= contentType;
    }

    const { response } = await fetchPublic(input, {
      method,
      headers: filteredHeaders,
      body
    });

    const chunks = [];
    let total = 0;

    if (response.body) {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);

        if (total + buffer.length > MAX_RESPONSE_SIZE) {
          const remaining = MAX_RESPONSE_SIZE - total;

          if (remaining > 0) {
            chunks.push(buffer.subarray(0, remaining));
          }

          break;
        }

        chunks.push(buffer);
        total += buffer.length;
      }
    }

    const responseHeaders = {};

    for (const [key, value] of response.headers.entries()) {
      responseHeaders[key] = value;
    }

    res.json({
      status: response.status,
      statusText: response.statusText,
      duration: Date.now() - started,
      headers: responseHeaders,
      body: Buffer.concat(chunks).toString("utf8"),
      truncated: total >= MAX_RESPONSE_SIZE
    });
  } catch (error) {
    jsonError(res, 400, error.message || "Request API gagal.");
  }
});

/* Direct file downloader */
app.get("/api/download", async (req, res) => {
  let upstream;

  try {
    const input = String(req.query.url || "").trim();

    if (!input) {
      return jsonError(res, 400, "Parameter URL wajib diisi.");
    }

    const requestedName = String(req.query.name || "").slice(0, 200);

    const result = await fetchPublic(input, {
      headers: {
        "User-Agent": "Aspirant-Downloader/1.0",
        "Accept": "*/*"
      },
      signal: AbortSignal.timeout(120000)
    });

    upstream = result.response;

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      return jsonError(res, 502, `Sumber merespons HTTP ${upstream.status}.`);
    }

    const contentType = (
      upstream.headers.get("content-type") ||
      "application/octet-stream"
    ).toLowerCase();

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml")
    ) {
      await upstream.body?.cancel().catch(() => {});
      return jsonError(
        res,
        415,
        "URL tersebut mengembalikan halaman web, bukan file langsung."
      );
    }

    const contentLength = Number(
      upstream.headers.get("content-length") || 0
    );

    if (contentLength > MAX_DOWNLOAD_SIZE) {
      await upstream.body?.cancel().catch(() => {});
      return jsonError(res, 413, "Ukuran file melebihi batas 100 MB.");
    }

    let filename = safeFilename(requestedName);

    if (!requestedName || filename === "download") {
      try {
        filename = safeFilename(
          decodeURIComponent(path.basename(result.url.pathname)) || "download"
        );
      } catch {
        filename = "download";
      }
    }

    res.status(200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", encodeDispositionFilename(filename));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    if (contentLength > 0) {
      res.setHeader("Content-Length", contentLength);
    }

    let transferred = 0;

    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        transferred += chunk.length;

        if (transferred > MAX_DOWNLOAD_SIZE) {
          callback(new Error("File melebihi batas 100 MB."));
          return;
        }

        callback(null, chunk);
      }
    });

    if (!upstream.body) {
      return res.end();
    }

    await pipeline(
      Readable.fromWeb(upstream.body),
      limiter,
      res
    );
  } catch (error) {
    if (upstream?.body) {
      await upstream.body.cancel().catch(() => {});
    }

    if (!res.headersSent) {
      jsonError(res, 502, error.message || "Download gagal.");
    } else {
      res.destroy(error);
    }
  }
});

/* Unknown API routes */
app.use("/api", (req, res) => {
  jsonError(res, 404, "API endpoint tidak ditemukan.");
});

/* SPA/static fallback */
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PUBLIC, "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof SyntaxError && "body" in error) {
    return jsonError(res, 400, "JSON request tidak valid.");
  }

  console.error("[Aspirant]", error.message);
  jsonError(res, 500, "Terjadi kesalahan internal.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log(" Aspirant Utility Workspace");
  console.log("==================================");
  console.log(` Local: http://127.0.0.1:${PORT}`);
  console.log(" Status: running");
  console.log("==================================");
});
