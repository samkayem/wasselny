// routes/drivers.js
const express = require('express');
const { db } = require('../db');
const { distanceKm, authMiddleware, VAPID_PUBLIC_KEY } = require('../utils');

const router = express.Router();

// مفتاح VAPID العام — يحتاجه المتصفح للاشتراك بإشعارات الدفع (لا حاجة لتسجيل دخول لجلبه)
router.get('/push-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// السائق يرسل اشتراك إشعارات الدفع الخاص بمتصفحه ليُخزَّن ويُستخدم لاحقاً عند وصول طلب
router.post('/push-subscribe', authMiddleware('driver'), (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'بيانات الاشتراك مطلوبة' });
  db.get('drivers').find({ id: req.user.id }).assign({ pushSubscription: subscription }).write();
  res.json({ ok: true });
});

// السائق يحدّث حالته (متوفر/غير متوفر) وموقعه الحالي
// يُستدعى فقط أثناء فترة "متوفر وبانتظار طلب" — لا حاجة له بعد قبول رحلة
router.post('/status', authMiddleware('driver'), (req, res) => {
  const { status, lat, lng } = req.body; // status: 'available' | 'offline'
  if (!['available', 'offline'].includes(status)) {
    return res.status(400).json({ error: 'حالة غير صحيحة' });
  }
  const driver = db.get('drivers').find({ id: req.user.id });
  if (!driver.value()) return res.status(404).json({ error: 'السائق غير موجود' });

  driver
    .assign({
      status,
      lat: status === 'available' ? lat : null,
      lng: status === 'available' ? lng : null,
      lastSeen: new Date().toISOString()
    })
    .write();

  res.json({ ok: true });
});

// الراكب يطلب قائمة السائقين المتوفرين القريبين — لقطة لحظية فقط، بدون تتبع مستمر
router.get('/nearby', authMiddleware('rider'), (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'يجب إرسال موقع صحيح (lat, lng)' });
  }

  const drivers = db
    .get('drivers')
    .filter(
      (d) => d.active && d.verified && d.status === 'available' && d.lat != null && d.lng != null
    )
    .value();

  const withDistance = drivers
    .map((d) => ({
      id: d.id,
      name: d.name,
      lat: d.lat,
      lng: d.lng,
      distanceKm: Math.round(distanceKm(lat, lng, d.lat, d.lng) * 10) / 10
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  res.json({ drivers: withDistance });
});

module.exports = router;
