const express = require("express");
const { chromium } = require("playwright");

const app = express();

// --- CONFIGURATION ---

// Your Residential Proxy (Added automatically)
const PROXIES = [
 // "http://260102Tf4fe-resi-US:rC5a0zqL5dYMNtE@ca.proxy-jet.io:1010"
];

const FORCE_OLD_REDDIT = true;

// ---------------------

// 1. ROOT PAGE (Fixes "Cannot GET /")
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Reddit Playwright scraper is ONLINE",
    endpoints: {
      scrape: "GET /reddit-thread?url=<reddit_thread_url>",
      debug_ip: "GET /check-ip",
      health: "GET /health"
    }
  });
});

// 2. HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 3. IP DEBUGGER (Test if proxies are working)
app.get("/check-ip", async (req, res) => {
  let browser;
  try {
    const proxyUrl = PROXIES.length > 0 
      ? PROXIES[Math.floor(Math.random() * PROXIES.length)] 
      : null;

    console.log("Checking IP with proxy:", proxyUrl || "None");

    const launchOptions = { 
      headless: true,
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox", 
        "--disable-blink-features=AutomationControlled"
      ]
    };
    
    if (proxyUrl) {
      launchOptions.proxy = { server: proxyUrl };
    }

    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Check IP via external service
    await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    const content = await page.evaluate(() => document.body.innerText);

    res.json({
      message: "Proxy Connection Test",
      usingProxy: !!proxyUrl,
      proxyAddress: proxyUrl ? "HIDDEN (Residential)" : "None",
      // If this IP matches your proxy provider, it works!
      externalIpSeenByWebsites: JSON.parse(content).ip 
    });

  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  } finally {
    if (browser) await browser.close();
  }
});

function normalizeToJsonUrl(inputUrl) {
  let urlStr = String(inputUrl || "").trim();
  urlStr = urlStr.replace(/[\u200B-\u200D\uFEFF]/g, ""); // Remove invisible chars
  
  if (!urlStr.startsWith("http")) urlStr = "https://" + urlStr;

  try {
    const u = new URL(urlStr);
    if (FORCE_OLD_REDDIT) u.hostname = "old.reddit.com";
    if (!u.pathname.endsWith(".json")) {
       if (u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
       u.pathname += ".json";
    }
    u.search = "";
    return u.toString();
  } catch (e) {
    return inputUrl + ".json";
  }
}

// 4. THE SCRAPER (The main logic)
app.get("/reddit-thread", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ error: "Missing ?url= parameter" });

  const jsonUrl = normalizeToJsonUrl(inputUrl);
  
  // Pick Proxy
  const proxyUrl = PROXIES.length > 0 
    ? PROXIES[Math.floor(Math.random() * PROXIES.length)] 
    : null;

  console.log(`Scraping: ${jsonUrl}`);

  let browser;
  try {
    const launchOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled", 
        "--disable-gpu"
      ]
    };

    if (proxyUrl) launchOptions.proxy = { server: proxyUrl };

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    const response = await page.goto(jsonUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const status = response ? response.status() : null;

    if (status && status >= 400) {
      const bodyText = await page.content().catch(() => "");
      return res.status(502).json({
        error: `Reddit Blocked/Error: ${status}`,
        jsonUrl,
        bodyPreview: bodyText.slice(0, 500)
      });
    }

    const jsonText = await page.evaluate(() => document.body.innerText || "");

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (err) {
      return res.status(500).json({
        error: "Failed to parse Reddit JSON",
        parseError: String(err),
        bodyPreview: jsonText.slice(0, 1000)
      });
    }

    return res.json({ jsonUrl, data });

  } catch (err) {
    console.error("Scrape error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Reddit Scraper listening on port", PORT);
});
