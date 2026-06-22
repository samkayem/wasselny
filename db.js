// db.js — قاعدة بيانات بسيطة مبنية على ملف JSON (lowdb)
// مناسبة لحجم صغير (حتى ~50 سائقاً). عند نمو المشروع لاحقاً
// يُنصح بالانتقال إلى Postgres (مثلاً عبر Supabase) — لكن لا حاجة لذلك في V1.

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'data', 'db.json'));
const db = low(adapter);

db.defaults({
  riders: [],
  drivers: [],
  trips: [],
  complaints: [],
  meta: { nextId: 1 }
}).write();

// مولّد أرقام تسلسلية بسيط للمعرّفات (id)
function nextId() {
  const id = db.get('meta.nextId').value();
  db.set('meta.nextId', id + 1).write();
  return id;
}

module.exports = { db, nextId };
