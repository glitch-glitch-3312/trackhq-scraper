const { chromium } = require('playwright');
const { addExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const athleticNetId = process.env.ATHLETIC_NET_ID;
const userId = process.env.USER_ID;

(async () => {
  const chromiumExtra = addExtra(chromium);
  chromiumExtra.use(StealthPlugin());
  const browser = await chromiumExtra.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();
  await page.goto('https://www.athletic.net/athlete/' + athleticNetId + '/track-and-field/all', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  const html = await page.content();
  await browser.close();

  const seen = {};
  const results = [];
  const re = /"(?:eventName|Event|event)"\s*:\s*"([^"]+)"[^}]{0,400}?"(?:result|Result|pr|PR|time)"\s*:\s*"([0-9:.]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ev = m[1].trim();
    const t = parseTime(m[2]);
    if (ev && t > 0 && !seen[ev]) { seen[ev] = true; results.push({ event_name: ev, best_time: t }); }
  }

  console.log('Found', results.length, 'results');

  for (const r of results) {
    await supabase.from('verified_records').upsert(
      { user_id: userId, event_name: r.event_name, best_time: r.best_time, source: 'athletic.net', verified: true, synced_at: new Date().toISOString() },
      { onConflict: 'user_id,event_name' }
    );
    await supabase.from('personal_records').upsert(
      { user_id: userId, event_name: r.event_name, best_time: r.best_time },
      { onConflict: 'user_id,event_name', ignoreDuplicates: false }
    );
  }
  console.log('Saved', results.length, 'records for user', userId);
})();

function parseTime(t) {
  const str = String(t).replace(/['"]/g, '').trim();
  const parts = str.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(str) || 0;
}
