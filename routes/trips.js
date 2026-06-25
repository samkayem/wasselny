// routes/trips.js
const express = require('express');
const { db, nextId } = require('../db');
const { authMiddleware, distanceKm, sendPushToDriver } = require('../utils');

const router = express.Router();

// يجد أقرب سائق متوفر، باستثناء من تم تجربته مسبقاً لهذا الطلب
// أو من لديه طلب نشط آخر بالفعل (لتجنب إرسال طلبين له في نفس الوقت)
function findNearestAvailableDriver(pickupLat, pickupLng, excludeIds = []) {
  const busyDriverIds = new Set(
    db
      .get('trips')
      .filter((t) => ['requested', 'accepted'].includes(t.status))
      .value()
      .map((t) => t.driverId)
  );

  const candidates = db
    .get('drivers')
    .filter(
      (d) =>
        d.active &&
        d.verified &&
        d.status === 'available' &&
        d.lat != null &&
        d.lng != null &&
        !excludeIds.includes(d.id) &&
        !busyDriverIds.has(d.id)
    )
    .value();

  if (!candidates.length) return null;

  const withDistance = candidates.map((d) => ({
    ...d,
    distanceKm: distanceKm(pickupLat, pickupLng, d.lat, d.lng)
  }));
  withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
  return withDistance[0];
}

// الراكب يطلب رحلة — لا يختار سائقاً، النظام يختار أقرب سائق متوفر تلقائياً
// هوية السائق لا تُكشف للراكب إلا بعد موافقته (نموذج أوبر)
router.post('/', authMiddleware('rider'), (req, res) => {
  const { pickupLat, pickupLng, destinationText } = req.body;
  if (pickupLat == null || pickupLng == null) {
    return res.status(400).json({ error: 'بيانات الطلب غير مكتملة' });
  }

  const activeForRider = db
    .get('trips')
    .find((t) => t.riderId === req.user.id && ['requested', 'accepted'].includes(t.status))
    .value();
  if (activeForRider) {
    return res.status(409).json({ error: 'لديك طلب رحلة نشط أصلاً' });
  }

  const nearest = findNearestAvailableDriver(pickupLat, pickupLng);
  if (!nearest) {
    return res.status(409).json({ error: 'لا يوجد سائقون متوفرون حالياً، حاول بعد قليل' });
  }

  const trip = {
    id: nextId(),
    riderId: req.user.id,
    riderName: req.user.name,
    driverId: nearest.id,
    driverName: nearest.name,
    pickupLat,
    pickupLng,
    destinationText: destinationText || '',
    status: 'requested', // requested | accepted | completed | cancelled
    price: null,
    triedDriverIds: [], // سجل من رُفض الطلب منهم لهذه الرحلة، لتجنب إعادة عرضه عليهم
    cancelReason: null, // null | 'no_drivers_available' | 'cancelled_by_rider'
    riderNotified: true, // تم تبليغ الراكب بحالة الطلب الحالية
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    completedAt: null
  };
  db.get('trips').push(trip).write();

  // إشعار دفع للسائق — لا ننتظر نتيجته، فهو لا يجب أن يؤخر استجابة الراكب
  sendPushToDriver(nearest, {
    title: '🔔 طلب رحلة جديد',
    body: 'لديك طلب توصيلة جديد على Wasselny',
    url: '/driver.html'
  });

  // لا نُرجع اسم السائق للراكب أثناء البحث — فقط تأكيد أن الطلب قيد المعالجة
  res.json({ trip: { id: trip.id, status: trip.status } });
});

// السائق يفحص دورياً (polling) إن وصله طلب جديد
router.get('/incoming', authMiddleware('driver'), (req, res) => {
  const trip = db
    .get('trips')
    .find({ driverId: req.user.id, status: 'requested' })
    .value();
  res.json({ trip: trip || null });
});

// كلا الطرفين يتابعان حالة الرحلة الحالية
// بالنسبة للراكب: لا يظهر اسم السائق إلا بعد القبول (status === 'accepted')
router.get('/mine', authMiddleware(), (req, res) => {
  if (req.user.role === 'rider') {
    const trip = db
      .get('trips')
      .find((t) => t.riderId === req.user.id && ['requested', 'accepted'].includes(t.status))
      .value();

    if (trip) {
      const visible = { ...trip };
      if (trip.status === 'requested') {
        visible.driverName = null; // إخفاء الهوية حتى الموافقة
      }
      return res.json({ trip: visible });
    }

    // لا يوجد طلب نشط — تحقّق إن كان آخر طلب انتهى بعدم توفر أي سائق، لإشعار الراكب مرة واحدة
    const exhausted = db
      .get('trips')
      .find(
        (t) =>
          t.riderId === req.user.id &&
          t.status === 'cancelled' &&
          t.cancelReason === 'no_drivers_available' &&
          !t.riderNotified
      );
    if (exhausted.value()) {
      exhausted.assign({ riderNotified: true }).write();
      return res.json({ trip: null, notice: 'لم يستجب أي سائق قريب لطلبك. حاول مرة أخرى بعد قليل.' });
    }

    return res.json({ trip: null });
  }

  // السائق يرى تفاصيل الطلب المقبول كاملة دائماً
  const trip = db
    .get('trips')
    .find((t) => t.driverId === req.user.id && ['requested', 'accepted'].includes(t.status))
    .value();
  res.json({ trip: trip || null });
});

router.post('/:id/accept', authMiddleware('driver'), (req, res) => {
  const trip = db.get('trips').find({ id: Number(req.params.id), driverId: req.user.id });
  if (!trip.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.value().status !== 'requested') {
    return res.status(409).json({ error: 'لا يمكن قبول هذا الطلب الآن' });
  }
  trip.assign({ status: 'accepted', acceptedAt: new Date().toISOString() }).write();
  db.get('drivers').find({ id: req.user.id }).assign({ status: 'busy' }).write();
  res.json({ ok: true });
});

// السائق يرفض — النظام يحاول تلقائياً مع أقرب سائق متوفر تالٍ
router.post('/:id/reject', authMiddleware('driver'), (req, res) => {
  const tripRef = db.get('trips').find({ id: Number(req.params.id), driverId: req.user.id });
  const trip = tripRef.value();
  if (!trip) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.status !== 'requested') {
    return res.status(409).json({ error: 'لا يمكن رفض هذا الطلب الآن' });
  }

  const triedDriverIds = [...trip.triedDriverIds, req.user.id];
  const next = findNearestAvailableDriver(trip.pickupLat, trip.pickupLng, triedDriverIds);

  if (next) {
    tripRef
      .assign({
        driverId: next.id,
        driverName: next.name,
        triedDriverIds,
        riderNotified: true
      })
      .write();
    sendPushToDriver(next, {
      title: '🔔 طلب رحلة جديد',
      body: 'لديك طلب توصيلة جديد على Wasselny',
      url: '/driver.html'
    });
  } else {
    tripRef
      .assign({
        status: 'cancelled',
        cancelReason: 'no_drivers_available',
        riderNotified: false, // ليُبلَّغ الراكب عند أول استطلاع تالٍ
        triedDriverIds
      })
      .write();
  }
  res.json({ ok: true });
});

// إنهاء الرحلة وتحديد السعر يدوياً (يقوم به السائق عادة، ويمكن للإدارة تعديله لاحقاً)
router.post('/:id/complete', authMiddleware('driver'), (req, res) => {
  const { price } = req.body;
  const trip = db.get('trips').find({ id: Number(req.params.id), driverId: req.user.id });
  if (!trip.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.value().status !== 'accepted') {
    return res.status(409).json({ error: 'لا يمكن إنهاء رحلة لم تُقبل بعد' });
  }
  trip.assign({ status: 'completed', price: price || null, completedAt: new Date().toISOString() }).write();
  // السائق يصبح غير متوفر تلقائياً بعد إنهاء الرحلة، ويجب أن يفعّل "متوفر" يدوياً من جديد
  db.get('drivers').find({ id: req.user.id }).assign({ status: 'offline' }).write();
  res.json({ ok: true });
});

router.post('/:id/cancel', authMiddleware('rider'), (req, res) => {
  const trip = db.get('trips').find({ id: Number(req.params.id), riderId: req.user.id });
  if (!trip.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (!['requested', 'accepted'].includes(trip.value().status)) {
    return res.status(409).json({ error: 'لا يمكن إلغاء هذه الرحلة' });
  }
  const driverId = trip.value().driverId;
  trip.assign({ status: 'cancelled', cancelReason: 'cancelled_by_rider' }).write();
  db.get('drivers').find({ id: driverId }).assign({ status: 'offline' }).write();
  res.json({ ok: true });
});

// سجل آخر الرحلات (لأي طرف) — يُستخدم لتقديم شكوى عن رحلة سابقة
router.get('/history', authMiddleware(), (req, res) => {
  const field = req.user.role === 'rider' ? 'riderId' : 'driverId';
  const trips = db
    .get('trips')
    .filter((t) => t[field] === req.user.id)
    .value()
    .slice(-10)
    .reverse();
  res.json({ trips });
});

module.exports = router;
