/**
 * Scrapes ALL Coop + Denner store locations and writes stores-data.json
 * Run once: node backend/scrapers/update-stores.js
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT    = path.join(__dirname, '..', 'stores-data.json');

// ─── helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// ─── DENNER ──────────────────────────────────────────────────────────────────
async function scrapeDenner(browser) {
  const page  = await browser.newPage();
  const found = [];

  page.on('response', async res => {
    const url = res.url();
    const ct  = (res.headers()['content-type'] || '');
    if (!ct.includes('json')) return;
    // Denner loads stores via Nuxt/backend – catch any JSON with lat/lng arrays
    try {
      const raw = await res.text();
      if (!raw.includes('"lat"') && !raw.includes('"latitude"')) return;
      const data = JSON.parse(raw);
      const arr  = Array.isArray(data) ? data
                 : data.data   ? data.data
                 : data.stores ? data.stores
                 : data.items  ? data.items
                 : null;
      if (arr && arr.length) {
        console.log(`[Denner] API-Hit: ${url.slice(0, 80)} → ${arr.length} Einträge`);
        found.push(...arr);
      }
    } catch {}
  });

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-CH,de;q=0.9' });
  await page.goto('https://www.denner.ch/de/filialen', { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(3000);

  // Also try extracting from the Nuxt payload injected into the page
  const nuxtStores = await page.evaluate(() => {
    try {
      // Nuxt 3 / Nuxt 2 state
      const payload = window.__NUXT__ || window.__nuxt_data__;
      if (!payload) return [];
      const str = JSON.stringify(payload);
      const matches = str.matchAll(/"lat(?:itude)?"\s*:\s*([\d.]+)/g);
      return []; // placeholder – full extraction below
    } catch { return []; }
  });

  // Fallback: parse DOM store cards
  if (found.length === 0) {
    const dom = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(
        '[class*="store"], [class*="filial"], [class*="branch"], [class*="location"]'
      )].filter(el => el.textContent.includes('Tel') || el.textContent.match(/\d{4}/));
      return cards.map(el => ({
        rawText: el.innerText,
      }));
    });
    console.log('[Denner] DOM fallback cards:', dom.length);
  }

  await page.close();
  return found;
}

// ─── COOP ────────────────────────────────────────────────────────────────────
// Coop store finder uses a map. We query a Swiss bounding box grid via their API.
async function scrapeCoop(browser) {
  const page   = await browser.newPage();
  const found  = [];
  let   apiUrl = null;

  // Step 1: Find the real API endpoint by intercepting store-finder requests
  page.on('response', async res => {
    const url = res.url();
    const ct  = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    if (!url.includes('store') && !url.includes('filial') && !url.includes('branch')) return;
    try {
      const raw  = await res.text();
      if (!raw.includes('"lat"') && !raw.includes('"latitude"') && !raw.includes('"name"')) return;
      const data = JSON.parse(raw);
      const arr  = Array.isArray(data) ? data
                 : data.stores   ? data.stores
                 : data.data     ? data.data
                 : data.results  ? data.results
                 : null;
      if (arr && arr.length) {
        if (!apiUrl) apiUrl = url;
        console.log(`[Coop] API-Hit: ${url.slice(0, 80)} → ${arr.length} Einträge`);
        found.push(...arr);
      }
    } catch {}
  });

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-CH,de;q=0.9' });
  await page.goto('https://www.coop.ch/de/unternehmen/store-finder.html',
    { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(4000);

  // Try clicking "Alle Filialen" button if exists
  try {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a')];
      const all  = btns.find(b => /alle|all|list|übersicht/i.test(b.textContent));
      if (all) all.click();
    });
    await sleep(3000);
  } catch {}

  await page.close();

  // Step 2: If we found the API URL, query Switzerland-wide via a grid
  if (apiUrl && found.length < 100) {
    console.log('[Coop] Starte Grid-Abfrage über die Schweiz...');
    const gridPage = await browser.newPage();
    const seen     = new Set(found.map(s => s.id || s.storeId || s.name));

    // Swiss bounding box: lat 45.8–47.8, lng 5.9–10.5, ~0.3° steps (~20km)
    const lats = [45.9, 46.2, 46.5, 46.8, 47.1, 47.4, 47.7];
    const lngs = [6.0,  6.4,  6.8,  7.2,  7.6,  8.0,  8.4,  8.8,  9.2,  9.6, 10.0, 10.4];

    // Build query URL from discovered apiUrl pattern
    const base = apiUrl.replace(/([?&])(lat|lng|radius|zoom)[^&]*/g, '').replace(/[?&]$/, '');

    for (const lat of lats) {
      for (const lng of lngs) {
        try {
          const url = `${base}?lat=${lat}&lng=${lng}&radius=25&lang=de`;
          const res = await gridPage.evaluate(async u => {
            try { const r = await fetch(u); return await r.text(); } catch { return ''; }
          }, url);
          if (!res) continue;
          const data = JSON.parse(res);
          const arr  = Array.isArray(data) ? data
                     : data.stores ? data.stores
                     : data.data   ? data.data
                     : data.results ? data.results : [];
          for (const s of arr) {
            const key = s.id || s.storeId || s.name;
            if (!seen.has(key)) { seen.add(key); found.push(s); }
          }
          await sleep(300);
        } catch {}
      }
    }
    await gridPage.close();
    console.log(`[Coop] Grid total: ${found.length}`);
  }

  return found;
}

// ─── Normalize raw store records ─────────────────────────────────────────────
let nextId = 200;

function normalizeDenner(raw) {
  const lat = parseFloat(raw.lat || raw.latitude || raw.geoLat || 0);
  const lng = parseFloat(raw.lng || raw.lon || raw.longitude || raw.geoLng || 0);
  if (!lat || !lng) return null;

  const addr   = norm(raw.address || raw.street || raw.strasse || '');
  const city   = norm(raw.city || raw.ort || raw.place || '');
  const plz    = norm(raw.zip || raw.plz || raw.postalCode || '');
  const name   = norm(raw.name || raw.title || `Denner ${city}`);
  const phone  = norm(raw.phone || raw.telephone || raw.tel || '');
  const hours  = norm(
    raw.openingHours || raw.hours || raw.openTimes ||
    (raw.openingHoursInfo && JSON.stringify(raw.openingHoursInfo)) || ''
  ).slice(0, 120);

  return { id: nextId++, shop: 'Denner', name, address: addr, city, plz, lat, lng, phone, hours };
}

function normalizeCoop(raw) {
  const lat = parseFloat(raw.lat || raw.latitude || raw.geoLat || raw.coordinates?.lat || 0);
  const lng = parseFloat(raw.lng || raw.lon || raw.longitude || raw.geoLng || raw.coordinates?.lng || 0);
  if (!lat || !lng) return null;

  const addr  = norm(raw.address || raw.street || raw.streetAddress || '');
  const city  = norm(raw.city || raw.ort || raw.place || '');
  const plz   = norm(raw.zip || raw.plz || raw.postalCode || '');
  const name  = norm(raw.name || raw.storeName || raw.title || `Coop ${city}`);
  const phone = norm(raw.phone || raw.telephone || '');
  const hours = norm(
    raw.openingHours || raw.hours ||
    (Array.isArray(raw.openingHours) ? raw.openingHours.join(', ') : '') || ''
  ).slice(0, 120);

  return { id: nextId++, shop: 'Coop', name, address: addr, city, plz, lat, lng, phone, hours };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
  });

  console.log('\n🏪 Starte Store-Scraper...\n');

  let allStores = [];

  // --- Denner ---
  console.log('── Denner ──────────────────────────────');
  try {
    const raw     = await scrapeDenner(browser);
    const normed  = raw.map(normalizeDenner).filter(Boolean);
    // Deduplicate by lat+lng
    const seen    = new Set();
    const deduped = normed.filter(s => {
      const k = `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    console.log(`[Denner] ${deduped.length} Filialen gefunden`);
    allStores.push(...deduped);
  } catch (e) {
    console.error('[Denner] Fehler:', e.message);
  }

  // --- Coop ---
  console.log('\n── Coop ────────────────────────────────');
  try {
    const raw     = await scrapeCoop(browser);
    const normed  = raw.map(normalizeCoop).filter(Boolean);
    const seen    = new Set();
    const deduped = normed.filter(s => {
      const k = `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    console.log(`[Coop] ${deduped.length} Filialen gefunden`);
    allStores.push(...deduped);
  } catch (e) {
    console.error('[Coop] Fehler:', e.message);
  }

  await browser.close();

  if (allStores.length > 75) {
    // Re-assign clean IDs
    allStores = allStores.map((s, i) => ({ ...s, id: i + 1 }));
    fs.writeFileSync(OUT, JSON.stringify(allStores, null, 2));
    console.log(`\n✅ ${allStores.length} Filialen in stores-data.json gespeichert`);
  } else {
    console.log(`\n⚠️  Nur ${allStores.length} Filialen gefunden – stores-data.json wird NICHT überschrieben`);
    console.log('   (Bestehendes Fallback-Dataset bleibt erhalten)');
  }
})();
