const { scrapeCoop }   = require('./coop');
const { scrapeDenner } = require('./denner');

async function scrapeAll() {
  console.log('[Scraper] Starte Scrape...');

  const [coopResult, dennerResult] = await Promise.allSettled([
    scrapeCoop(),
    scrapeDenner(),
  ]);

  const coopBeers   = coopResult.status   === 'fulfilled' ? coopResult.value.map(b   => ({ ...b, shop: 'Coop' }))   : [];
  const dennerBeers = dennerResult.status === 'fulfilled' ? dennerResult.value.map(b => ({ ...b, shop: 'Denner' })) : [];

  const all = [...coopBeers, ...dennerBeers];
  console.log(`[Scraper] Fertig: ${all.length} Biere (${coopBeers.length} Coop, ${dennerBeers.length} Denner)`);
  return all;
}

module.exports = { scrapeAll };
