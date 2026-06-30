// routes/complaints.js
const express = require('express');
const { db, nextId } = require('../db');
const { authMiddleware, sendPushToDriver } = require('../utils');

const router = express.Router();

// أي طرف (راكب أو سائق) يمكنه تسجيل شكوى مرتبطة برقم رحلة
// الشكوى تصل للإدارة (لوحة التحكم) وللسائق المرتبط بالرحلة في نفس الوقت
router.post('/', authMiddleware(), (req, res) => {
  const { tripId, description } = req.body;
  if (!tripId || !description) {
    return res.status(400).json({ error: 'رقم الرحلة ونص الشكوى مطلوبان' });
  }
  const trip = db.get('trips').find({ id: Number(tripId) }).value();
  if (!trip) return res.status(404).json({ error: 'الرحلة غير موجودة' });

  const complaint = {
    id: nextId(),
    tripId: trip.id,
    driverId: trip.driverId,
    driverName: trip.driverName,
    riderId: trip.riderId,
    riderName: trip.riderName,
    submittedBy: req.user.role,
    description,
    createdAt: new Date().toISOString(),
    resolved: false,
    decision: null, // القرار/الإجراء الذي تتخذه الإدارة، يُرسل للسائق عند البت بالشكوى
    decidedAt: null,
    driverNotified: true, // تم تبليغ السائق بوجود الشكوى نفسها (إشعار فوري عند التقديم)
    decisionNotified: true // لا يوجد قرار بعد، فلا حاجة لتبليغ — تتحول لـ false عند اتخاذ القرار
  };
  db.get('complaints').push(complaint).write();

  // تبليغ السائق فوراً بوجود شكوى مرتبطة برحلته، بغض النظر عن مُقدّمها
  const driver = db.get('drivers').find({ id: trip.driverId }).value();
  if (driver) {
    sendPushToDriver(driver, {
      title: '📋 شكوى جديدة على رحلة',
      body: 'تم تسجيل شكوى مرتبطة بأحد رحلاتك، ستراجعها الإدارة',
      url: '/driver.html'
    });
  }

  res.json({ ok: true });
});

// السائق يرى الشكاوى المرتبطة برحلاته، بما فيها قرار الإدارة إن اتُّخذ
router.get('/mine', authMiddleware('driver'), (req, res) => {
  const complaints = db
    .get('complaints')
    .filter((c) => c.driverId === req.user.id)
    .value()
    .slice()
    .reverse();

  // عند جلب القائمة، تُعتبر السائق "اطّلع" على القرار إن وُجد — يوقف تكرار الإشعار
  complaints.forEach((c) => {
    if (c.decision && !c.decisionNotified) {
      db.get('complaints').find({ id: c.id }).assign({ decisionNotified: true }).write();
    }
  });

  res.json({ complaints });
});

module.exports = router;
