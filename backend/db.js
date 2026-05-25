const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'bierdeal.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    email      TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS beers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    brand      TEXT,
    type       TEXT,
    shop       TEXT    NOT NULL,
    price      REAL    NOT NULL,
    orig_price REAL,
    volume     TEXT,
    img        TEXT,
    url        TEXT,
    scraped_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name, shop)
  );

  CREATE TABLE IF NOT EXISTS alarms (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    beer_id      INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
    target_price REAL    NOT NULL,
    notified     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    beer_id    INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, beer_id)
  );
`);

// ─── Migrations (run once, safe to repeat) ───────────────────────────────────
try { db.exec('ALTER TABLE users ADD COLUMN google_id TEXT'); } catch(e) {}

// ─── Migrate existing bier.json → SQLite (one-time) ──────────────────────────
const fs = require('fs');
const jsonPath = path.join(__dirname, 'bier.json');
if (fs.existsSync(jsonPath) && db.prepare('SELECT COUNT(*) as c FROM beers').get().c === 0) {
  try {
    const old = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const ins = db.prepare(`INSERT OR IGNORE INTO beers (id,name,brand,type,shop,price,orig_price,volume,img,url,scraped_at)
      VALUES (@id,@name,@brand,@type,@shop,@price,@orig_price,@volume,@img,@url,@scraped_at)`);
    const insAlarm = db.prepare(`INSERT OR IGNORE INTO alarms (id,beer_id,target_price,notified,created_at)
      VALUES (@id,@beer_id,@target_price,@notified,@created_at)`);
    db.transaction(() => {
      (old.beers  || []).forEach(b => ins.run({ url: '', ...b, scraped_at: b.scraped_at || new Date().toISOString() }));
      (old.alarms || []).forEach(a => insAlarm.run({ ...a, notified: a.notified ? 1 : 0 }));
    })();
    console.log(`[DB] Migriert: ${old.beers?.length ?? 0} Biere, ${old.alarms?.length ?? 0} Alarme`);
  } catch (e) { console.warn('[DB] Migration fehlgeschlagen:', e.message); }
}

// ─── Prepared statements ──────────────────────────────────────────────────────
const SQL = {
  upsertBeer: db.prepare(`
    INSERT INTO beers (name,brand,type,shop,price,orig_price,volume,img,url,scraped_at)
    VALUES (@name,@brand,@type,@shop,@price,@orig_price,@volume,@img,@url,datetime('now'))
    ON CONFLICT(name,shop) DO UPDATE SET
      price=excluded.price, orig_price=excluded.orig_price, brand=excluded.brand,
      type=excluded.type, volume=excluded.volume, img=excluded.img,
      url=excluded.url, scraped_at=excluded.scraped_at`),

  allBeers: db.prepare(`
    SELECT b.*, ROUND((1.0-b.price/b.orig_price)*100) AS discount_pct,
           COUNT(f.id) AS fav_count
    FROM beers b
    LEFT JOIN favorites f ON f.beer_id = b.id
    WHERE b.orig_price > b.price AND b.orig_price IS NOT NULL
    GROUP BY b.id
    ORDER BY discount_pct DESC`),

  beerById: db.prepare(`SELECT * FROM beers WHERE id=?`),

  addAlarm:   db.prepare(`INSERT INTO alarms (user_id,beer_id,target_price) VALUES (?,?,?)`),
  delAlarm:   db.prepare(`DELETE FROM alarms WHERE id=? AND (user_id=? OR user_id IS NULL)`),
  getAlarms:  db.prepare(`
    SELECT a.*, b.name AS beer_name, b.price AS current_price, b.shop, b.img
    FROM alarms a JOIN beers b ON b.id=a.beer_id
    WHERE (? IS NULL AND a.user_id IS NULL) OR a.user_id=?`),
  triggered:  db.prepare(`
    SELECT a.*, b.name AS beer_name, b.price AS current_price, b.shop, b.img
    FROM alarms a JOIN beers b ON b.id=a.beer_id
    WHERE a.notified=0 AND b.price<=a.target_price`),
  markNotified: db.prepare(`UPDATE alarms SET notified=1 WHERE id=?`),

  addFav:    db.prepare(`INSERT OR IGNORE INTO favorites (user_id,beer_id) VALUES (?,?)`),
  delFav:    db.prepare(`DELETE FROM favorites WHERE user_id=? AND beer_id=?`),
  getFavs:   db.prepare(`
    SELECT b.*, CASE WHEN b.orig_price>b.price THEN ROUND((1.0-b.price/b.orig_price)*100) ELSE 0 END AS discount_pct
    FROM favorites f JOIN beers b ON b.id=f.beer_id WHERE f.user_id=? ORDER BY f.created_at DESC`),
  getFavIds: db.prepare(`SELECT beer_id FROM favorites WHERE user_id=?`),

  createUser:       db.prepare(`INSERT INTO users (username,email,password) VALUES (?,?,?)`),
  createGoogleUser: db.prepare(`INSERT INTO users (username,email,password,google_id) VALUES (?,?,?,?)`),
  userByEmail:      db.prepare(`SELECT * FROM users WHERE email=?`),
  userByUsername:   db.prepare(`SELECT * FROM users WHERE username=?`),
  userById:         db.prepare(`SELECT id,username,email,created_at FROM users WHERE id=?`),
  userByGoogleId:   db.prepare(`SELECT * FROM users WHERE google_id=?`),
  linkGoogleId:     db.prepare(`UPDATE users SET google_id=? WHERE id=?`),
};

// ─── Public API ───────────────────────────────────────────────────────────────
module.exports = {
  // Beers
  getAllBeers:     ()    => SQL.allBeers.all(),
  getBeerById:     id    => SQL.beerById.get(id),
  upsertBeers(list) {
    db.transaction(() => list.forEach(b => SQL.upsertBeer.run(b)))();
  },

  // Alarms
  getAllAlarms:    (uid=null) => SQL.getAlarms.all(uid, uid),
  addAlarm(uid, beerId, price) {
    const r = SQL.addAlarm.run(uid, beerId, price);
    return { id: r.lastInsertRowid, user_id: uid, beer_id: beerId, target_price: price, notified: 0 };
  },
  deleteAlarm:         (id, uid=null) => SQL.delAlarm.run(id, uid),
  getTriggeredAlarms:  ()             => SQL.triggered.all(),
  markAlarmsNotified:  ids            => db.transaction(() => ids.forEach(id => SQL.markNotified.run(id)))(),

  // Favorites
  addFavorite:    (uid, bid) => SQL.addFav.run(uid, bid),
  removeFavorite: (uid, bid) => SQL.delFav.run(uid, bid),
  getFavorites:   uid        => SQL.getFavs.all(uid),
  getFavoriteIds: uid        => SQL.getFavIds.all(uid).map(r => r.beer_id),

  // Users
  createUser:       (u, e, pw)       => { const r = SQL.createUser.run(u, e, pw); return r.lastInsertRowid; },
  createGoogleUser: (u, e, googleId) => { const r = SQL.createGoogleUser.run(u, e, '', googleId); return r.lastInsertRowid; },
  getUserByEmail:   email            => SQL.userByEmail.get(email),
  getUserById:      id               => SQL.userById.get(id),
  getUserByUsername:u                => SQL.userByUsername.get(u),
  getUserByGoogleId:googleId         => SQL.userByGoogleId.get(googleId),
  linkGoogleId:     (googleId, uid)  => SQL.linkGoogleId.run(googleId, uid),
};
