"use strict";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/132.0.0.0 Safari/537.36";

const SAFARI_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
  "Mobile/15E148 Safari/604.1";

const DEFAULT_TIMEOUT = 25000;
const MAX_REDIRECTS = 5;
const MAX_BODY_SIZE = 8 * 1024 * 1024;

function getCleanUrl(input) {
  const url = new URL(input);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Hanya URL HTTP dan HTTPS yang didukung.");
  }

  url.hash = "";
  return url.href;
}

function serializeData(value) {
  return JSON.stringify(value);
}

function getCookiesFromHeaders(headers) {
  const cookies = [];

  if (!headers) return "";

  if (typeof headers.getSetCookie === "function") {
    cookies.push(...headers.getSetCookie());
  } else {
    const value = headers.get("set-cookie");
    if (value) cookies.push(value);
  }

  return cookies
    .map(cookie => String(cookie).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function scraperFetch(input, options = {}) {
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const headers = new Headers(options.headers || {});
  headers.set(
    "User-Agent",
    headers.get("User-Agent") || CHROME_UA
  );

  const fetchOptions = {
    method: options.method || "GET",
    headers,
    signal: options.signal || controller.signal,
    redirect: "manual"
  };

  if (options.body !== undefined) {
    fetchOptions.body = options.body;
  }

  let currentURL = getCleanUrl(input);

  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const response = await fetch(currentURL, fetchOptions);

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const buffer = await response.arrayBuffer();

        if (buffer.byteLength > MAX_BODY_SIZE) {
          throw new Error("Respons HTTP melebihi batas ukuran.");
        }

        const body = Buffer.from(buffer).toString("utf8");

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url || currentURL,
          headers: response.headers,
          data: body,
          text: body,
          json() {
            return JSON.parse(body);
          }
        };
      }

      const location = response.headers.get("location");

      if (!location) {
        throw new Error("Redirect tidak memiliki lokasi tujuan.");
      }

      if (i === MAX_REDIRECTS) {
        throw new Error("Terlalu banyak redirect.");
      }

      currentURL = getCleanUrl(
        new URL(location, currentURL).href
      );

      if (response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
           fetchOptions.method === "POST")) {
        fetchOptions.method = "GET";
        delete fetchOptions.body;
      }
    }

    throw new Error("Redirect gagal diselesaikan.");
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Request HTTP timeout.");
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createScraperResult({
  title = "",
  type = "video",
  thumbnail = null,
  downloads = [],
  metadata = {}
} = {}) {
  const validDownloads = downloads
    .filter(item =>
      item &&
      typeof item.url === "string" &&
      /^https?:\/\//i.test(item.url)
    )
    .map(item => ({
      url: item.url,
      type: item.type || type,
      quality: item.quality || "Original"
    }));

  return {
    status: validDownloads.length > 0,
    result: {
      title: String(title || "Media download").slice(0, 300),
      type,
      thumbnail:
        typeof thumbnail === "string" &&
        /^https?:\/\//i.test(thumbnail)
          ? thumbnail
          : null,
      downloads: validDownloads,
      ...metadata
    }
  };
}

module.exports = {
  CHROME_UA,
  SAFARI_MOBILE_UA,
  DEFAULT_TIMEOUT,
  scraperFetch,
  getCookiesFromHeaders,
  serializeData,
  getCleanUrl,
  createScraperResult
};
