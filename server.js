const express = require("express");
const { chromium } = require("playwright");

const app = express();

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Scraper running",
    usage: {
      reddit: "/reddit-thread?url=<reddit_thread_url>",
      amazon: "/amazon-reviews?url=<amazon_listing_url>&pages=5"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------------------- Reddit --------------------
function normalizeToJsonUrl(inputUrl) {
  let url = String(inputUrl || "").trim();

  url = url.replace(/[\u200B-\u200D\uFEFF]/g, "");
  url = url.replace(/[?#].*$/, "");
  url = url.replace(/\/$/, "");

  if (url.endsWith(".json")) return url;
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

    const response = await page.goto(jsonUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const status = response ? response.status() : null;
    if (status && status >= 400) {
      const bodyText = await page.content().catch(() => "");
      return res.status(502).json({
        error: `Reddit returned HTTP ${status}`,
        jsonUrl,
        bodyPreview: bodyText.slice(0, 1000)
      });
    }

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
    if (browser) await browser.close().catch(() => {});
  }
});

// -------------------- Amazon --------------------
function extractAsinFromAmazonUrl(inputUrl) {
  const url = String(inputUrl || "").trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  const m =
    url.match(/\/dp\/([A-Z0-9]{10})/i) ||
    url.match(/\/gp\/product\/([A-Z0-9]{10})/i) ||
    url.match(/[?&]asin=([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function reviewPageUrlForAsin(asin, pageNumber) {
  return `https://www.amazon.com/product-reviews/${asin}/?pageNumber=${pageNumber}&sortBy=recent`;
}

async function detectAmazonBlock(page) {
  const title = await page.title().catch(() => "");
  const hasCaptcha =
    (await page.locator("form[action*='captcha']").count()) > 0 ||
    title.includes("Robot Check");
  return hasCaptcha;
}

app.get("/amazon-reviews", async (req, res) => {
  const inputUrl = req.query.url;
  const pages = Math.max(1, Math.min(Number(req.query.pages || 3), 20));

  if (!inputUrl) {
    return res.status(400).json({ error: "Missing query param: ?url=<amazon_listing_url>" });
  }

  const asin = extractAsinFromAmazonUrl(inputUrl);
  if (!asin) {
    return res.status(400).json({
      error: "Could not extract ASIN from URL. Expected /dp/<ASIN> or /gp/product/<ASIN>.",
      inputUrl
    });
  }

  let browser;
  try {
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
        "(KHTML, like Gecko) Chrome/123 Safari/537.36",
      locale: "en-US"
    });

    const page = await context.newPage();

    // Title
    const productUrl = `https://www.amazon.com/dp/${asin}`;
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.wait_for_timeout(1200);

    if (await detectAmazonBlock(page)) {
      return res.status(502).json({ error: "Amazon blocked (captcha/robot check) on product page", asin });
    }

    const titleSelectors = ["#productTitle", "span#productTitle", "span.a-size-large.product-title-word-break"];
    let productTitle = "";
    for (const sel of titleSelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        const t = (await loc.innerText().catch(() => "")).trim();
        if (t) { productTitle = t; break; }
      }
    }

    // Reviews
    const reviews = [];
    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const url = reviewPageUrlForAsin(asin, pageNum);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.wait_for_timeout(1200);

      if (await detectAmazonBlock(page)) {
        return res.status(502).json({ error: "Amazon blocked (captcha/robot check) on reviews page", asin, pageNum });
      }

      const cards = page.locator("div[data-hook='review']");
      const count = await cards.count();
      if (count === 0) break;

      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);

        const safeText = async (selector) => {
          const node = card.locator(selector).first();
          if ((await node.count()) === 0) return "";
          return ((await node.innerText().catch(() => "")) || "").trim();
        };

        const name = await safeText(".a-profile-name");
        const rating = await safeText("i[data-hook='review-star-rating'] span, i[data-hook='cmps-review-star-rating'] span");
        const date = await safeText("span[data-hook='review-date']");
        const title = await safeText("a[data-hook='review-title'] span, span[data-hook='review-title']");
        const content = await safeText("span[data-hook='review-body'] span");

        reviews.push({ asin, name, rating, date, title, content, sourcePage: pageNum });
      }
    }

    return res.json({
      asin,
      productTitle,
      reviewsCount: reviews.length,
      reviews
    });
  } catch (err) {
    console.error("Amazon scrape error:", err);
    return res.status(500).json({
      error: String(err?.message || err),
      stack: err?.stack,
      asin
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Scraper listening on port", PORT);
});
