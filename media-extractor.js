"use strict";

const {
  tiktok,
  instagram,
  pinterest
} = require("@coflyn/scrapr");

const PLATFORMS = {
  tiktok: {
    hosts: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    methods: [
      tiktok?.snaptik,
      tiktok?.tiktokio,
      tiktok?.ssstik,
      tiktok?.savetik,
      tiktok?.tikdownloader
    ]
  },

  instagram: {
    hosts: ["instagram.com", "instagr.am"],
    methods: [
      instagram?.direct,
      instagram?.snapsave,
      instagram?.indown,
      instagram?.snapinsta
    ]
  },

  pinterest: {
    hosts: ["pinterest.com", "pin.it"],
    methods: [
      pinterest?.direct,
      pinterest?.pindown
    ]
  }
};

function validatePlatformURL(platform, input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("URL tidak valid.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Protokol URL tidak didukung.");
  }

  const config = PLATFORMS[platform];

  if (!config) {
    throw new Error("Platform tidak didukung.");
  }

  const host = url.hostname.toLowerCase();

  const allowed = config.hosts.some(domain =>
    host === domain || host.endsWith("." + domain)
  );

  if (!allowed) {
    throw new Error("Domain tidak sesuai dengan platform.");
  }

  return url.href;
}

function normalizeResult(platform, result) {
  if (!result || result.status !== true || !result.result) {
    return null;
  }

  const data = result.result;

  const downloads = Array.isArray(data.downloads)
    ? data.downloads
        .filter(item =>
          item &&
          typeof item.url === "string" &&
          /^https?:\/\//i.test(item.url)
        )
        .map(item => ({
          url: item.url,
          type: item.type || data.type || "video",
          quality: item.quality || "Original"
        }))
    : [];

  if (!downloads.length) return null;

  return {
    ok: true,
    platform,
    title: String(data.title || "Media download"),
    type: data.type || "video",
    thumbnail: data.thumbnail || null,
    downloads
  };
}

async function extractMedia(platform, input) {
  const config = PLATFORMS[platform];

  if (!config) {
    throw new Error("Platform tidak didukung.");
  }

  const url = validatePlatformURL(platform, input);
  const errors = [];

  for (const method of config.methods) {
    if (typeof method !== "function") continue;

    try {
      const result = await method(url);
      const normalized = normalizeResult(platform, result);

      if (normalized) return normalized;

      errors.push("Extractor tidak menemukan media.");
    } catch (error) {
      errors.push(
        String(error.message || "Ekstraksi gagal.").slice(0, 160)
      );
    }
  }

  const error = new Error(
    "Semua metode ekstraksi gagal. Periksa URL, akses konten, atau kondisi layanan sumber."
  );

  error.details = errors;
  throw error;
}

module.exports = {
  extractMedia,
  validatePlatformURL
};
