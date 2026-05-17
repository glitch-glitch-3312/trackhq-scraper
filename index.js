const express = require('express');
const { chromium } = require('playwright');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SECRET = process.env.SCRAPER_SECRET || 'changeme';

const VALID_EVENTS = {
  '100m': '100m', '100 Meter': '100m', '100 Meter Dash': '100m',
  '200m': '200m', '200 Meter': '200m', '200 Meter Dash': '200m',
  '400m': '400m', '400 Meter': '400m', '400 Meter Dash': '400m',
  '800m': '800m', '800 Meter': '800m', '800 Meter Run': '800m',
  '1600m': '1600m', '1600 Meter': '1600m', '1600 Meter Run': '1600m',
  '1 Mile': '1600m', 'Mile': '1600m', '1600': '1600m',
  '3200m': '3200m', '3200 Meter': '3200m', '3200 Meter Run': '3200m',
  '2 Mile': '3200m', '3200': '3200m',
  '110m Hurdles': '110mH', '110mH': '110mH', '110 Meter Hurdles': '110mH',
  '300m Hurdles': '300mH', '300mH': '300mH', '300 Meter Hurdles': '300mH',
  '4x100m': '4x100m', '4x100': '4x100m', '4x100 Meter Relay': '4x100m',
  '4x400m': '4x400m', '4x400': '4x400m', '4x400 Meter Relay': '4x400m',
  'Long Jump': 'Long Jump', 'Triple Jump': 'Triple Jump',
  'High Jump': 'High Jump', 'Shot Put': 'Shot Put',
  'Discus': 'Discus', 'Discus Throw': 'Discus',
};

function parseTime(t) {
  const str = String(t).replace(/['"]/g, '').trim();
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(str) || 0;
}

function extractResults(obj, results, seen, depth) {
  if (depth > 10 || !obj) return;
  if (Array.isArray(obj)) { for (const item of obj) extractResults(item, results, seen, depth + 1); return; }
  if (typeof obj === 'object') {
    const name = obj.eventName || obj.EventName || obj.event || obj.Event || obj.name || obj.Name || obj.sEvent || obj.markName || obj.eventAbbr || obj.n;
    const pr = obj.pr || obj.PR || obj.best || obj.Best || obj.mark || obj.Mark || obj.time || obj.Time || obj.t || obj.result || obj.Result || obj.sResult || obj.value || obj.m;
    if (name && pr) {
      const mapped = VALID_EVENTS[name] || VALID_EVENTS[name.replace(/\s+/g, ' ').trim()];
      if (mapped && !seen[mapped]) {
        const sec = typeof pr === 'number' ? pr : parseTime(String(pr));
        if (sec > 0 && sec < 36000) {
          seen[mapped] = true;
          results.push({ event_name: mapped, best_time: sec });
        }
      }
    }
    for (const val of Object.values(obj)) extractResults(val, results, seen, depth + 1);
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'trackhq-scraper', uptime: Math.round(process.uptime()) });
});

app.get('/debug/:id', async (req, res) => {
  const athleticNetId = req.params.id;
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ]
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });

    // Remove webdriver flag
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    const apiBodies = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('athletic.net') && response.status() === 200) {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const body = await response.json();
            apiBodies.push({ url: url.substring(0, 120), preview: JSON.stringify(body).substring(0, 400) });
          }
        }
      } catch (e) {}
    });

    const targetUrl = 'https://www.athletic.net/athlete/' + athleticNetId + '/track-and-field/all';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for Cloudflare challenge
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => '');
      if (!text.includes('security verification') && !text.includes('Checking your browser') && !text.includes('Performing')) {
        break;
      }
    }

    // Wait for Angular app to fully render
    await page.waitForTimeout(10000);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const title = await page.title().catch(() => '');

    res.json({
      athleticNetId,
      title,
      bodyTextLen: bodyText.length,
      bodyTextPreview: bodyText.substring(0, 3000),
      apiBodies: apiBodies.slice(0, 40),
      apiCount: apiBodies.length,
    });
  } catch (err) {
    res.json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post('/scrape', async (req, res) => {
  if (req.headers['x-secret'] !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { athleticNetId } = req.body;
  if (!athleticNetId) return res.status(400).json({ error: 'Missing athleticNetId' });

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ]
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    const collectedData = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('athletic.net') && response.status() === 200) {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const body = await response.json();
            extractResults(body, collectedData, {}, 0);
          }
        }
      } catch (e) {}
    });

    const targetUrl = 'https://www.athletic.net/athlete/' + athleticNetId + '/track-and-field/all';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for Cloudflare
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => '');
      if (!text.includes('security verification') && !text.includes('Checking your browser') && !text.includes('Performing')) break;
    }

    await page.waitForTimeout(10000);

    const results = [];
    const seen = {};
    for (const d of collectedData) {
      if (!seen[d.event_name]) {
        seen[d.event_name] = true;
        results.push(d);
      }
    }

    if (results.length === 0) {
      const text = await page.evaluate(() => document.body.innerText).catch(() => '');
      for (const ev of Object.keys(VALID_EVENTS)) {
        if (seen[VALID_EVENTS[ev]]) continue;
        const escaped = ev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const pat of [
          new RegExp(escaped + '[^\\n]{0,200}?(\\d{1,2}:\\d{2}\\.\\d{1,2})', 'gi'),
          new RegExp(escaped + '[^\\n]{0,200}?(\\d{2,3}\\.\\d{2})', 'gi'),
        ]) {
          let m;
          while ((m = pat.exec(text)) !== null) {
            const t = parseTime(m[1]);
            const mapped = VALID_EVENTS[ev];
            if (t > 0 && t < 36000 && mapped && !seen[mapped]) {
              seen[mapped] = true;
              results.push({ event_name: mapped, best_time: t });
              break;
            }
          }
        }
      }
    }

    const bodyPreview = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');

    res.json({
      total: results.length,
      results,
      debug: { bodyPreview, collectedFromNetwork: collectedData.length, pageUrl: page.url() }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(3000, () => console.log('Scraper running on port 3000'));
