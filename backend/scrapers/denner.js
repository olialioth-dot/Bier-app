const { getBrowser } = require('./browser');

const URL = 'https://www.denner.ch/de/aktionen/aktuelle-aktionen';
const BEER_RE = /\bbier\b|\bbeer\b|\blager\b|pilsner|\bweizen\b|\bipa\b|\bale\b|\bstout\b|\bbrau\b|quöll|feldschl|boxer|chopfab|cardinal|eichhof|heineken|corona|stella|guinness|erdinger|paulaner|1291|super bock|valaisanne|uszit/i;

async function scrapeDenner() {
  const browser = await getBrowser();
  const page    = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-CH,de;q=0.9' });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Denner is Nuxt SSR — wait for product grid to render
    await page.waitForSelector('.product-item', { timeout: 20000 });

    // Scroll to trigger lazy loading of all items
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 1500));

    const products = await page.evaluate((beerPattern) => {
      const re = new RegExp(beerPattern, 'i');
      return [...document.querySelectorAll('.product-item')].map(item => {
        const title    = item.querySelector('.product-item__title')?.textContent?.trim() || '';
        const subline  = item.querySelector('.product-item__subline')?.textContent?.trim() || '';
        const price    = parseFloat(item.querySelector('.price-tag__final-price')?.textContent?.trim());
        const origText = item.querySelector('.price-tag__instead')?.textContent?.trim() || '';
        const origMatch = origText.match(/(\d+[.,]\d+)/);
        const origPrice = origMatch ? parseFloat(origMatch[1].replace(',', '.')) : price;
        const discount  = item.querySelector('.price-tag__discount')?.textContent?.trim() || '';
        const imgSrc    = item.querySelector('img')?.getAttribute('src') || '';
        const img       = imgSrc.split('?')[0]; // strip query params
        return { title, subline, price, origPrice, discount, img };
      }).filter(p => p.title && !isNaN(p.price) && re.test(p.title + ' ' + p.subline));
    }, BEER_RE.source);

    const mapped = products.map(p => ({
      name:       p.title + (p.subline ? ' ' + p.subline : ''),
      brand:      extractBrand(p.title),
      type:       guessBeerType(p.title),
      price:      p.price,
      orig_price: p.origPrice || p.price,
      volume:     extractVolume(p.subline),
      img:        p.img,
      url:        URL,
    }));

    console.log(`[Denner] ${mapped.length} Biere gescraped`);
    return mapped;
  } finally {
    await page.close();
  }
}

function extractBrand(name) {
  const known = ['Feldschlösschen', 'Eichhof', 'Schützengarten', 'Carlsberg', 'Heineken',
    'Corona', 'Leffe', 'Hoegaarden', 'Erdinger', 'Guinness', 'Tiger', 'Stella',
    'Estrella', 'Veltins', 'Calanda', 'Cardinal', 'Rugenbräu', 'Chopfab',
    'Boxer', 'Valaisanne', 'Appenzeller', '1291', 'Anker'];
  return known.find(b => name.includes(b)) ?? name.split(' ')[0];
}

function guessBeerType(name) {
  const lc = name.toLowerCase();
  if (/weizen|weiss|hefe/.test(lc))              return 'Weizen';
  if (/pilsner|pils/.test(lc))                   return 'Pilsner';
  if (/stout|porter|draught/.test(lc))           return 'Stout';
  if (/ipa|ale|brune|blond/.test(lc))            return 'Ale';
  return 'Lager';
}

function extractVolume(subline) {
  const m = subline.match(/(\d+)\s*x\s*(\d+)\s*cl/i);
  return m ? `${m[1]}x${m[2]}cl` : subline.match(/(\d+)\s*cl/i)?.[0] || '';
}

module.exports = { scrapeDenner };
