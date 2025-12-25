const express = require("express");
const { chromium } = require("playwright");

const app = express();

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Reddit Playwright scraper running",
    usage: "/reddit-thread?url=<reddit_thread_url>"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function normalizeToJsonUrl(inputUrl) {
  let url = String(inputUrl || "").trim();

  // Remove zero-width chars that can sneak in from copy/paste
  url = url.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // Strip query + fragment
  url = url.replace(/[?#].*$/, "");

  // Remove trailing slash
  url = url.replace(/\/$/, "");

  // If already ends with .json keep it
  if (url.endsWith(".json")) return url;

  // Reddit expects ...something.json (NO extra slash)
  return url + ".json";
}

app.get("/reddit-thread", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) {
    return res.status(400).json({
      error: "Missing query param: ?url=<reddit_thread_url>"
    });
  }

  const jsonUrl = normalizeToJsonUrl(inputUrl);

  let browser;
  try {
    // Launch hardened for container environments
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/123 Safari/537.36"
    });

    const page = await context.newPage();

    // Since this is JSON, do NOT wait for networkidle
    const response = await page.goto(jsonUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // If reddit responds with 403/429, capture it clearly
    const status = response ? response.status() : null;
    if (status && status >= 400) {
      const bodyText = await page.content().catch(() => "");
      return res.status(502).json({
        error: `Reddit returned HTTP ${status}`,
        jsonUrl,
        bodyPreview: bodyText.slice(0, 1000)
      });
    }

    // The JSON is usually in the raw body
    const jsonText = await page.evaluate(() => document.body.innerText || "");

    if (!jsonText.trim()) {
      return res.status(500).json({
        error: "Reddit returned an empty response",
        jsonUrl
      });
    }

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (err) {
      return res.status(500).json({
        error: "Failed to parse Reddit JSON",
        jsonUrl,
        parseError: String(err),
        bodyPreview: jsonText.slice(0, 1000)
      });
    }

    return res.json({ jsonUrl, data });
  } catch (err) {
    console.error("Scrape error:", err);
    return res.status(500).json({
      error: String(err?.message || err),
      stack: err?.stack,
      jsonUrl
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Reddit Playwright scraper listening on port", PORT);
});
