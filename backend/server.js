const http      = require('http');
const https     = require('https');
const express   = require('express');
const cors      = require('cors');
const { WebSocketServer } = require('ws');

const db          = require('./db');
const { scrapeAll }  = require('./scrapers');
const scheduler   = require('./scheduler');
const { findStores } = require('./stores');
const { hashPassword, checkPassword, signToken, requireAuth, optionalAuth } = require('./auth');

const PORT = process.env.PORT || 3001;

// ─── Non-beer filter ──────────────────────────────────────────────────────────
const NON_BEER = /alkohol\s*frei|freibier|\b0\.0\b|0\.0%|cero\b|zero\b|radler|cider|cidre|panach[eé]|ginger\s+beer|somersby|bulmers|magners|möhl|apple\s+cider|litchi|mojito|bilz\b|heidelbeere|käse|\bgouda\b|schüga|placebo|diversion|liberis|bschorle|erusbacher.*ohni|la chouette/i;
const filterBeers = beers => beers.filter(b => !NON_BEER.test(b.name));

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ─── Google Token Verifier (kein extra Package nötig) ────────────────────────
function verifyGoogleToken(credential) {
  return new Promise((resolve, reject) => {
    https.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (payload.error) reject(new Error(payload.error_description || 'Ungültiges Google-Token'));
          else resolve(payload);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Auth endpoints ───────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email und password erforderlich' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  try {
    const id = db.createUser(username, email.toLowerCase(), hashPassword(password));
    const token = signToken({ id, username, email: email.toLowerCase() });
    res.json({ token, user: { id, username, email: email.toLowerCase() } });
  } catch (e) {
    if (e.message.includes('UNIQUE'))
      return res.status(409).json({ error: 'Email oder Benutzername bereits vergeben' });
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email und password erforderlich' });
  const user = db.getUserByEmail(email.toLowerCase());
  if (!user || !checkPassword(password, user.password))
    return res.status(401).json({ error: 'Email oder Passwort falsch' });
  const token = signToken({ id: user.id, username: user.username, email: user.email });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User nicht gefunden' });
  res.json(user);
});

app.post('/api/auth/google', (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Kein Google-Token erhalten' });

  verifyGoogleToken(credential)
    .then(payload => {
      if (!payload.email) throw new Error('Keine E-Mail vom Google-Konto erhalten');

      // Existing user by Google ID?
      let user = db.getUserByGoogleId(payload.sub);

      // Existing user by Email (account linking)?
      if (!user) {
        user = db.getUserByEmail(payload.email);
        if (user) db.linkGoogleId(payload.sub, user.id);
      }

      // New user → auto-register
      if (!user) {
        let base = (payload.name || payload.email.split('@')[0])
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 20);
        let username = base, n = 1;
        while (db.getUserByUsername(username)) username = base + n++;
        const id = db.createGoogleUser(username, payload.email, payload.sub);
        user = db.getUserById(id);
      }

      const token = signToken({ id: user.id, username: user.username, email: user.email });
      res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
    })
    .catch(err => {
      console.error('[Google Auth]', err.message);
      res.status(401).json({ error: 'Google-Anmeldung fehlgeschlagen: ' + err.message });
    });
});

// ─── Beers ────────────────────────────────────────────────────────────────────
app.get('/api/beers', (_, res) => res.json(db.getAllBeers()));

app.post('/api/refresh', async (_, res) => {
  const beers = filterBeers(await scrapeAll());
  db.upsertBeers(beers);
  broadcast({ type: 'update', beers: db.getAllBeers(), alarms: db.getAllAlarms(), timestamp: new Date().toISOString() });
  res.json({ ok: true, count: beers.length });
});

// ─── Alarms (guest + user) ────────────────────────────────────────────────────
app.get('/api/alarms', optionalAuth, (req, res) => {
  res.json(db.getAllAlarms(req.user?.id ?? null));
});

app.post('/api/alarms', optionalAuth, (req, res) => {
  const { beer_id, target_price } = req.body;
  if (!beer_id || !target_price)
    return res.status(400).json({ error: 'beer_id und target_price erforderlich' });
  const beer = db.getBeerById(beer_id);
  if (!beer) return res.status(404).json({ error: 'Bier nicht gefunden' });
  const alarm = db.addAlarm(req.user?.id ?? null, beer_id, target_price);
  res.json({ ...alarm, beer_name: beer.name, current_price: beer.price, shop: beer.shop, img: beer.img });
});

app.delete('/api/alarms/:id', optionalAuth, (req, res) => {
  db.deleteAlarm(Number(req.params.id), req.user?.id ?? null);
  res.json({ ok: true });
});

// ─── Favorites (require login) ────────────────────────────────────────────────
app.get('/api/favorites', requireAuth, (req, res) => {
  res.json(db.getFavorites(req.user.id));
});

app.post('/api/favorites/:beerId', requireAuth, (req, res) => {
  db.addFavorite(req.user.id, Number(req.params.beerId));
  res.json({ ok: true });
});

app.delete('/api/favorites/:beerId', requireAuth, (req, res) => {
  db.removeFavorite(req.user.id, Number(req.params.beerId));
  res.json({ ok: true });
});

app.get('/api/favorites/ids', requireAuth, (req, res) => {
  res.json(db.getFavoriteIds(req.user.id));
});

// ─── Store locator ────────────────────────────────────────────────────────────
app.get('/api/stores', async (req, res) => {
  const { plz, shop, radius } = req.query;
  if (!plz || !/^\d{4}$/.test(plz))
    return res.status(400).json({ error: 'Bitte eine gültige 4-stellige Schweizer PLZ eingeben.' });
  const stores = await findStores({ plz, shop, radius: Number(radius) || 20 });
  if (!stores)
    return res.status(404).json({ error: `PLZ ${plz} konnte nicht geocodiert werden.` });
  res.json({ stores, count: stores.length });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const server  = http.createServer(app);
const wss     = new WebSocketServer({ server });
const clients = new Map(); // ws → { userId }

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

scheduler.setBroadcast(broadcast);

wss.on('connection', ws => {
  clients.set(ws, {});
  console.log(`[WS] Client verbunden (${clients.size} aktiv)`);

  ws.send(JSON.stringify({
    type: 'init',
    beers:     db.getAllBeers(),
    alarms:    db.getAllAlarms(null),
    timestamp: new Date().toISOString(),
  }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = clients.get(ws) || {};

    switch (msg.type) {
      // Auth over WS (send token, receive user context)
      case 'auth': {
        try {
          const { jsonwebtoken: jwt } = require;
          const jwtLib = require('jsonwebtoken');
          const decoded = jwtLib.verify(msg.token, process.env.JWT_SECRET || 'bierdeal-secret-2025');
          clients.set(ws, { userId: decoded.id });
          const favIds = db.getFavoriteIds(decoded.id);
          ws.send(JSON.stringify({ type: 'auth_ok', user: { id: decoded.id, username: decoded.username }, favIds }));
        } catch {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Token ungültig' }));
        }
        break;
      }

      case 'add_alarm': {
        if (!msg.beer_id || !msg.target_price) break;
        const beer  = db.getBeerById(msg.beer_id);
        if (!beer) break;
        const alarm = db.addAlarm(meta.userId ?? null, msg.beer_id, msg.target_price);
        ws.send(JSON.stringify({ type: 'alarm_added', alarm: { ...alarm, beer_name: beer.name, current_price: beer.price, shop: beer.shop, img: beer.img } }));
        break;
      }

      case 'remove_alarm': {
        if (!msg.alarm_id) break;
        db.deleteAlarm(msg.alarm_id, meta.userId ?? null);
        broadcast({ type: 'alarm_removed', alarm_id: msg.alarm_id });
        break;
      }

      case 'add_favorite': {
        if (!msg.beer_id || !meta.userId) break;
        db.addFavorite(meta.userId, msg.beer_id);
        ws.send(JSON.stringify({ type: 'fav_added', beer_id: msg.beer_id }));
        break;
      }

      case 'remove_favorite': {
        if (!msg.beer_id || !meta.userId) break;
        db.removeFavorite(meta.userId, msg.beer_id);
        ws.send(JSON.stringify({ type: 'fav_removed', beer_id: msg.beer_id }));
        break;
      }

      case 'refresh': {
        scrapeAll().then(raw => {
          const beers = filterBeers(raw);
          db.upsertBeers(beers);
          broadcast({ type: 'update', beers: db.getAllBeers(), alarms: db.getAllAlarms(null), timestamp: new Date().toISOString() });
        }).catch(err => console.error('[WS] Refresh fehlgeschlagen:', err.message));
        break;
      }
    }
  });

  ws.on('close', () => { clients.delete(ws); console.log(`[WS] Client getrennt (${clients.size} aktiv)`); });
  ws.on('error', err => console.error('[WS] Fehler:', err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🍺 BierDeal Backend auf http://localhost:${PORT}`);
  console.log(`   SQLite: bierdeal.sqlite | Stores: ${require('./stores-data.json').length} Filialen\n`);
  try {
    const beers = filterBeers(await scrapeAll());
    db.upsertBeers(beers);
    console.log(`[Server] ${beers.length} Biere geladen\n`);
  } catch (err) {
    console.error('[Server] Scrape fehlgeschlagen:', err.message);
  }
  scheduler.start();
});
