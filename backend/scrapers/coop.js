const { getBrowser } = require('./browser');

const URL = 'https://www.coop.ch/de/lebensmittel/getraenke/bier.html';

async function scrapeCoop() {
  const browser = await getBrowser();
  const page    = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-CH,de;q=0.9' });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.productTile-details__name-value', { timeout: 20000 });

    const raw = await page.evaluate(() => {
      return [...document.querySelectorAll('a[class*="productTile"]')].map(t => {
        const name  = t.querySelector('.productTile-details__name-value')?.textContent?.trim() || '';
        const price = parseFloat(t.querySelector('.productTile__price-value-lead-price')?.textContent?.trim());
        const oldEl = t.querySelector('.productTile__price-value-lead-price-old');
        const origPrice = oldEl ? parseFloat(oldEl.textContent.trim()) : price;
        const dataSrc = t.querySelector('img[data-src]')?.getAttribute('data-src') || '';
        const imgSrc  = t.querySelector('img')?.getAttribute('src') || '';
        const raw = dataSrc || imgSrc;
        return {
          name,
          price,
          orig_price: origPrice,
          img: raw ? (raw.startsWith('//') ? 'https:' + raw : raw) : '',
          url: t.href,
        };
      }).filter(p => p.name && !isNaN(p.price));
    });

    const products = raw.map(p => ({
      ...p,
      brand:  extractBrand(p.name),
      type:   guessBeerType(p.name),
      volume: extractVolume(p.name),
    }));

    console.log(`[Coop] ${products.length} Biere gescraped`);
    return products;
  } finally {
    await page.close();
  }
}

function extractBrand(name) {
  const known = ['Appenzeller', 'Feldschlösschen', 'Eichhof', 'Schützengarten', 'Anker',
    'Carlsberg', 'Heineken', 'Corona', 'Leffe', 'Hoegaarden', 'Erdinger', 'Guinness',
    'Grimbergen', 'Affligem', 'Desperados', 'Stella', 'Birra Moretti', 'Super Bock',
    'Calanda', 'Chopfab', 'Valaisanne', 'Prix Garantie', 'Bilz', 'Paulaner'];
  return known.find(b => name.includes(b)) ?? name.split(' ')[0];
}

function guessBeerType(name) {
  const lc = name.toLowerCase();
  if (/weizen|weiss|hefe/.test(lc))             return 'Weizen';
  if (/pilsner|pils/.test(lc))                  return 'Pilsner';
  if (/stout|porter|draught/.test(lc))          return 'Stout';
  if (/ipa|ale|brune|blond|abbey/.test(lc))     return 'Ale';
  if (/alkoholfrei|0\.0|cero|zero/.test(lc))    return 'Alkoholfrei';
  return 'Lager';
}

function extractVolume(name) {
  const m = name.match(/(\d+)\s*x\s*(\d+)\s*cl/i);
  return m ? `${m[1]}x${m[2]}cl` : name.match(/(\d+\s*cl)/i)?.[0] || '';
}

module.exports = { scrapeCoop };
