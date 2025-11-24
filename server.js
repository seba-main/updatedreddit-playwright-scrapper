const express = require("express");
const { chromium } = require("playwright");

const app = express();

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/reddit-thread", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) {
    return res.status(400).json({
      error: "Missing query param: ?url=<reddit_thread_url>"
    });
  }

  // Step 1: Normalize the URL
  let base = inputUrl.trim().replace(/\?.*$/, "").replace(/\/$/, "");

  // Step 2: Always append `.json`
  const jsonUrl = `${base}/.json`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/123 Safari/537.36"
    });

    await page.goto(jsonUrl, { waitUntil: "networkidle", timeout: 60000 });

    // Read raw JSON text from the body
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

    // Forward Reddit's JSON exactly as-is, plus the URL used
    return res.json({
      jsonUrl,
      data
    });
  } catch (err) {
    console.error("Scrape error:", err);
    return res.status(500).json({
      error: String(err),
      jsonUrl
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Reddit Playwright scraper listening on port", PORT);
});