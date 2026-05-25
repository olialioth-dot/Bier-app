const cron = require('node-cron');
const { scrapeAll } = require('./scrapers');
const db = require('./db');

let broadcastFn = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

async function runUpdate() {
  try {
    console.log('[Scheduler] Auto-Update gestartet');
    const beers = await scrapeAll();
    db.upsertBeers(beers);

    // Check price alarms after every update
    const triggered = db.getTriggeredAlarms();
    if (triggered.length > 0) {
      db.markAlarmsNotified(triggered.map(a => a.id));
      triggered.forEach(alarm => broadcastFn?.({ type: 'alarm_triggered', alarm }));
      console.log(`[Scheduler] ${triggered.length} Preisalarm(e) ausgelöst`);
    }

    broadcastFn?.({
      type: 'update',
      beers: db.getAllBeers(),
      alarms: db.getAllAlarms(),
      timestamp: new Date().toISOString(),
    });

    console.log('[Scheduler] Auto-Update abgeschlossen');
  } catch (err) {
    console.error('[Scheduler] Update fehlgeschlagen:', err.message);
  }
}

function start() {
  cron.schedule('0 */2 * * *', runUpdate);
  console.log('[Scheduler] Läuft — Update alle 2 Stunden');
}

module.exports = { start, runUpdate, setBroadcast };
