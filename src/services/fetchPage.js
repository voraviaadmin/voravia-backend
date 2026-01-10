// src/services/fetchPage.js
import fetch from "node-fetch";

/**
 * Fetch a URL with browser-like headers to avoid 403 on many menu sites.
 */
export async function fetchPageHtml(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
  };

  try {
    // 1st attempt
    let res = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    // Some WAFs behave better if we add a Referer
    if (res.status === 403) {
      res = await fetch(url, {
        method: "GET",
        headers: { ...headers, Referer: new URL(url).origin + "/" },
        redirect: "follow",
        signal: controller.signal,
      });
    }

    const text = await res.text();

    if (!res.ok) {
      const err = new Error(`Failed to fetch url (${res.status})`);
      err.status = res.status;
      err.bodyPreview = text?.slice(0, 500);
      throw err;
    }

    return { html: text, finalUrl: res.url, status: res.status };
  } finally {
    clearTimeout(t);
  }
}
