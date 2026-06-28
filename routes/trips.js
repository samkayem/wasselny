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
      .filter((t) => ['requested', 'quoted', 'accepted'].includes(t.status))
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

function notifyNewRequest(driver) {
  sendPushToDriver(driver, {
    title: '🔔 طلب رحلة جديد',
    body: 'لديك طلب توصيلة جديد على Wasselny',
    url: '/driver.html'
  });
}

// تتالي تلقائي لأقرب سائق متاح تالٍ — يُستخدم عند رفض السائق للطلب، أو رفض الراكب للسعر المعروض
function cascadeToNextDriver(tripRef, currentDriverId, noMoreCancelReason) {
  const trip = tripRef.value();
  const triedDriverIds = [...trip.triedDriverIds, currentDriverId];
  const next = findNearestAvailableDriver(trip.pickupLat, trip.pickupLng, triedDriverIds);

  if (next) {
    tripRef
      .assign({
        status: 'requested',
        driverId: next.id,
        driverName: next.name,
        proposedPrice: null,
        triedDriverIds,
        riderNotified: true
      })
      .write();
    notifyNewRequest(next);
  } else {
    tripRef
      .assign({
        status: 'cancelled',
        cancelReason: noMoreCancelReason,
        riderNotified: false, // ليُبلَّغ الراكب عند أول استطلاع تالٍ
        triedDriverIds
      })
      .write();
  }
}

// الراكب يطلب رحلة — لا يختار سائقاً، النظام يختار أقرب سائق متوفر تلقائياً
// هوية السائق لا تُكشف للراكب إلا بعد أن يعرض السائق سعراً (status === 'quoted' فأعلى)
router.post('/', authMiddleware('rider'), (req, res) => {
  const { pickupLat, pickupLng, destinationText } = req.body;
  if (pickupLat == null || pickupLng == null) {
    return res.status(400).json({ error: 'بيانات الطلب غير مكتملة' });
  }

  const activeForRider = db
    .get('trips')
    .find((t) => t.riderId === req.user.id && ['requested', 'quoted', 'accepted'].includes(t.status))
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
    status: 'requested', // requested | quoted | accepted | completed | cancelled
    proposedPrice: null, // السعر الذي يعرضه السائق، قبل موافقة الراكب
    price: null, // السعر النهائي المتفق عليه (يُقفل عند موافقة الراكب على العرض)
    triedDriverIds: [], // سجل من رُفض الطلب منهم أو رُفض سعرهم، لتجنب إعادة عرضه عليهم
    cancelReason: null, // null | 'no_drivers_available' | 'all_quotes_rejected' | 'cancelled_by_rider'
    riderNotified: true,
    createdAt: new Date().toISOString(),
    quotedAt: null,
    acceptedAt: null,
    completedAt: null
  };
  db.get('trips').push(trip).write();

  notifyNewRequest(nearest);

  // لا نُرجع اسم السائق للراكب أثناء البحث — فقط تأكيد أن الطلب قيد المعالجة
  res.json({ trip: { id: trip.id, status: trip.status } });
});

// كلا الطرفين يتابعان حالة الرحلة الحالية
// بالنسبة للراكب: لا يظهر اسم السائق أو السعر إلا بعد عرض السائق سعراً (status !== 'requested')
router.get('/mine', authMiddleware(), (req, res) => {
  if (req.user.role === 'rider') {
    const trip = db
      .get('trips')
      .find((t) => t.riderId === req.user.id && ['requested', 'quoted', 'accepted'].includes(t.status))
      .value();

    if (trip) {
      const visible = { ...trip };
      if (trip.status === 'requested') {
        visible.driverName = null; // إخفاء الهوية حتى يُعرض سعر فعلي
      }
      return res.json({ trip: visible });
    }

    // لا يوجد طلب نشط — تحقّق إن كان آخر طلب انتهى بدون نتيجة، لإشعار الراكب مرة واحدة
    const exhaustedRef = db
      .get('trips')
      .find(
        (t) =>
          t.riderId === req.user.id &&
          t.status === 'cancelled' &&
          ['no_drivers_available', 'all_quotes_rejected'].includes(t.cancelReason) &&
          !t.riderNotified
      );
    const exhaustedTrip = exhaustedRef.value(); // نقرأ القيمة أولاً قبل أي تعديل، لأن السلسلة تُعاد تقييمها كل استدعاء
    if (exhaustedTrip) {
      const reason = exhaustedTrip.cancelReason;
      exhaustedRef.assign({ riderNotified: true }).write();
      const msg =
        reason === 'all_quotes_rejected'
          ? 'لم تتم الموافقة على سعر مناسب. حاول مرة أخرى بعد قليل.'
          : 'لم يستجب أي سائق قريب لطلبك. حاول مرة أخرى بعد قليل.';
      return res.json({ trip: null, notice: msg });
    }

    return res.json({ trip: null });
  }

  // السائق يرى تفاصيل الطلب كاملة في كل مراحله (طلب جديد، بانتظار رد الراكب، أو مقبول)
  const trip = db
    .get('trips')
    .find((t) => t.driverId === req.user.id && ['requested', 'quoted', 'accepted'].includes(t.status))
    .value();
  res.json({ trip: trip || null });
});

// السائق يعرض سعراً على طلب جديد — هذا هو "القبول" الفعلي، ولا يكتمل القبول إلا بموافقة الراكب على السعر
router.post('/:id/quote', authMiddleware('driver'), (req, res) => {
  const { price } = req.body;
  const priceNum = Number(price);
  if (!price || isNaN(priceNum) || priceNum <= 0) {
    return res.status(400).json({ error: 'أدخل سعراً صحيحاً أكبر من صفر' });
  }
  const tripRef = db.get('trips').find({ id: Number(req.params.id), driverId: req.user.id });
  const trip = tripRef.value();
  if (!trip) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.status !== 'requested') {
    return res.status(409).json({ error: 'لا يمكن تحديد سعر لهذا الطلب الآن' });
  }
  tripRef.assign({ status: 'quoted', proposedPrice: priceNum, quotedAt: new Date().toISOString() }).write();
  res.json({ ok: true });
});

// السائق يرفض الطلب مباشرة بدون عرض سعر — النظام يحاول تلقائياً مع أقرب سائق متوفر تالٍ
router.post('/:id/reject', authMiddleware('driver'), (req, res) => {
  const tripRef = db.get('trips').find({ id: Number(req.params.id), driverId: req.user.id });
  const trip = tripRef.value();
  if (!trip) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.status !== 'requested') {
    return res.status(409).json({ error: 'لا يمكن رفض هذا الطلب الآن' });
  }
  cascadeToNextDriver(tripRef, req.user.id, 'no_drivers_available');
  res.json({ ok: true });
});

// الراكب يوافق على السعر المعروض — يُقفل السعر، ويُعتبر القبول مكتملاً، ويُنبَّه السائق بالمتابعة
router.post('/:id/accept-quote', authMiddleware('rider'), (req, res) => {
  const tripRef = db.get('trips').find({ id: Number(req.params.id), riderId: req.user.id });
  const trip = tripRef.value();
  if (!trip) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.status !== 'quoted') {
    return res.status(409).json({ error: 'لا يوجد سعر معروض لقبوله الآن' });
  }
  tripRef
    .assign({ status: 'accepted', price: trip.proposedPrice, acceptedAt: new Date().toISOString() })
    .write();
  db.get('drivers').find({ id: trip.driverId }).assign({ status: 'busy' }).write();

  const driver = db.get('drivers').find({ id: trip.driverId }).value();
  if (driver) {
    sendPushToDriver(driver, {
      title: '✅ الراكب وافق على السعر',
      body: 'اضغط "متابعة الرحلة" لفتح المسار نحو الراكب',
      url: '/driver.html'
    });
  }
  res.json({ ok: true });
});

// الراكب يرفض السعر المعروض — تتالٍ تلقائي لأقرب سائق متاح تالٍ، ليعرض سعره الخاص
router.post('/:id/reject-quote', authMiddleware('rider'), (req, res) => {
  const tripRef = db.get('trips').find({ id: Number(req.params.id), riderId: req.user.id });
  const trip = tripRef.value();
  if (!trip) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.status !== 'quoted') {
    return res.status(409).json({ error: 'لا يوجد سعر معروض لرفضه الآن' });
  }
  db.get('drivers').find({ id: trip.driverId }).assign({ status: 'available' }).write();
  cascadeToNextDriver(tripRef, trip.driverId, 'all_quotes_rejected');
  res.json({ ok: true });
});

// إنهاء الرحلة — السعر معبّأ مسبقاً بالسعر المتفق عليه، ويمكن تعديله إذا اختلف الواقع الفعلي
router.post('/:id/complete', authMiddleware('driver'), (req, res) => {
  const { price } = req.body;
  const trip = db.get('trips').find({ id: Number(req.params.id), driverId: req.user.id });
  if (!trip.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (trip.value().status !== 'accepted') {
    return res.status(409).json({ error: 'لا يمكن إنهاء رحلة لم تُقبل بعد' });
  }
  const finalPrice = price != null && price !== '' ? Number(price) : trip.value().price;
  trip.assign({ status: 'completed', price: finalPrice, completedAt: new Date().toISOString() }).write();
  // السائق يصبح غير متوفر تلقائياً بعد إنهاء الرحلة، ويجب أن يفعّل "متوفر" يدوياً من جديد
  db.get('drivers').find({ id: req.user.id }).assign({ status: 'offline' }).write();
  res.json({ ok: true });
});

router.post('/:id/cancel', authMiddleware('rider'), (req, res) => {
  const trip = db.get('trips').find({ id: Number(req.params.id), riderId: req.user.id });
  if (!trip.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (!['requested', 'quoted', 'accepted'].includes(trip.value().status)) {
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
