const express = require("express");
const { chromium } = require("playwright");

const app = express();

// --- CONFIGURATION ---

// 1. ADD YOUR PROXIES HERE
// We added 'http://' which is required for Playwright.
// Since this is a rotating gateway, one entry is sufficient.
const PROXIES = [
  "http://260102Tf4fe-resi-US:rC5a0zqL5dYMNtE@ca.proxy-jet.io:1010"
];

// 2. FORCE OLD REDDIT (Often helps with parsing/blocking)
const FORCE_OLD_REDDIT = true;

// ---------------------

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
  let urlStr = String(inputUrl || "").trim();

  // Remove zero-width chars
  urlStr = urlStr.replace(/[\u200B-\u200D\uFEFF]/g, "");
  
  // Basic validity check
  if (!urlStr.startsWith("http")) {
    urlStr = "https://" + urlStr;
  }

  try {
    const u = new URL(urlStr);
    
    // Force old.reddit.com if configured
    if (FORCE_OLD_REDDIT) {
      u.hostname = "old.reddit.com";
    }

    // Ensure it ends in .json
    if (!u.pathname.endsWith(".json")) {
      // Remove trailing slash if present before appending
      if (u.pathname.endsWith("/")) {
        u.pathname = u.pathname.slice(0, -1); 
      }
      u.pathname += ".json";
    }

    // Clear query params to keep it clean
    u.search = "";
    
    return u.toString();
  } catch (e) {
    // Fallback if URL parsing fails
    return inputUrl + ".json";
  }
}

app.get("/reddit-thread", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) {
    return res.status(400).json({
      error: "Missing query param: ?url=<reddit_thread_url>"
    });
  }

  const jsonUrl = normalizeToJsonUrl(inputUrl);
  
  // Pick a random proxy
  const proxyUrl = PROXIES.length > 0 
    ? PROXIES[Math.floor(Math.random() * PROXIES.length)] 
    : null;

  console.log(`Scraping: ${jsonUrl} | Proxy: ${proxyUrl ? "Yes" : "No"}`);

  let browser;
  try {
    // Launch Options
    const launchOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled", // Hides navigator.webdriver
        "--disable-gpu"
      ]
    };

    // Inject Proxy if available
    if (proxyUrl) {
      launchOptions.proxy = {
        server: proxyUrl
      };
    }

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });

    const page = await context.newPage();

    // Navigate
    const response = await page.goto(jsonUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const status = response ? response.status() : null;

    // Handle Blocks (403/429/500)
    if (status && status >= 400) {
      const bodyText = await page.content().catch(() => "");
      console.error(`Blocked or Error ${status} on ${jsonUrl}`);
      
      return res.status(502).json({
        error: `Reddit returned HTTP ${status}`,
        jsonUrl,
        proxyUsed: !!proxyUrl,
        bodyPreview: bodyText.slice(0, 500) // First 500 chars usually contain the block msg
      });
    }

    // Extract Text
    const jsonText = await page.evaluate(() => document.body.innerText || "");

    // Parse JSON
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
