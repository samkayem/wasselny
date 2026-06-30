// routes/admin.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { authMiddleware, sendPushToDriver } = require('../utils');

const router = express.Router();
router.use(authMiddleware('admin'));

// حساب سائق: كل رحلاته المكتملة، الإجمالي، والعمولة المطلوبة منه (20% من إجمالي مبلغ رحلاته)
router.get('/drivers/:id/account', (req, res) => {
  const id = Number(req.params.id);
  const driver = db.get('drivers').find({ id }).value();
  if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });

  const trips = db
    .get('trips')
    .filter((t) => t.driverId === id && t.status === 'completed')
    .value()
    .slice()
    .reverse();

  const totalRevenue = trips.reduce((sum, t) => sum + (Number(t.price) || 0), 0);
  const COMMISSION_RATE = 0.2; // 20% — حسب اتفاق المنصة مع السائقين
  const commissionOwed = Math.round(totalRevenue * COMMISSION_RATE * 100) / 100;

  res.json({
    driver: { id: driver.id, name: driver.name, phone: driver.phone },
    trips,
    totalTrips: trips.length,
    totalRevenue,
    commissionRate: COMMISSION_RATE,
    commissionOwed
  });
});

// قائمة السائقين — تُظهر حالة المراجعة بدون كشف الصور الحساسة في الواجهة العامة
router.get('/drivers', (req, res) => {
  const drivers = db
    .get('drivers')
    .value()
    .map((d) => ({
      id: d.id,
      name: d.name,
      phone: d.phone,
      nationalId: d.nationalId,
      licenseNumber: d.licenseNumber,
      verified: d.verified,
      verifiedBy: d.verifiedBy,
      verifiedAt: d.verifiedAt,
      active: d.active,
      status: d.status,
      hasPendingDocs: Boolean(d.idPhotoPath || d.licensePhotoPath),
      createdAt: d.createdAt
    }));
  res.json({ drivers });
});

// عرض صورة الهوية/دفتر السير للمراجعة فقط (تُحذف فور التحقق)
router.get('/drivers/:id/document/:type', (req, res) => {
  const driver = db.get('drivers').find({ id: Number(req.params.id) }).value();
  if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });
  const field = req.params.type === 'id' ? 'idPhotoPath' : 'licensePhotoPath';
  const filePath = driver[field];
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'لا يوجد ملف (قد يكون تم حذفه بعد التحقق)' });
  }
  res.sendFile(path.resolve(filePath));
});

// تأكيد التحقق من السائق — يحذف الصور فوراً ويحتفظ فقط بالأرقام ونتيجة التحقق
router.post('/drivers/:id/verify', (req, res) => {
  const { verifiedBy } = req.body;
  const driverRef = db.get('drivers').find({ id: Number(req.params.id) });
  const driver = driverRef.value();
  if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });

  // حذف الصور من القرص فعلياً — لا نحتفظ بها بعد المراجعة
  [driver.idPhotoPath, driver.licensePhotoPath].forEach((p) => {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        /* تجاهل أخطاء الحذف غير الحرجة */
      }
    }
  });

  driverRef
    .assign({
      verified: true,
      verifiedBy: verifiedBy || 'الإدارة',
      verifiedAt: new Date().toISOString(),
      idPhotoPath: null,
      licensePhotoPath: null
    })
    .write();

  res.json({ ok: true });
});

router.post('/drivers/:id/toggle-active', (req, res) => {
  const driverRef = db.get('drivers').find({ id: Number(req.params.id) });
  const driver = driverRef.value();
  if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });
  driverRef.assign({ active: !driver.active }).write();
  res.json({ ok: true, active: !driver.active });
});

// حذف نهائي لسجل سائق — لا يمكن التراجع عنه. يُستخدم لتنظيف حسابات تجريبية أو مكررة.
router.delete('/drivers/:id', (req, res) => {
  const id = Number(req.params.id);
  const driver = db.get('drivers').find({ id }).value();
  if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });

  // حذف أي صور متبقية لم تُحذف بعد (احتياطاً، نادراً ما يحدث)
  [driver.idPhotoPath, driver.licensePhotoPath].forEach((p) => {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        /* تجاهل أخطاء الحذف غير الحرجة */
      }
    }
  });

  // إلغاء أي رحلة نشطة مرتبطة بهذا السائق، حتى لا يبقى الراكب بانتظار سائق محذوف
  const activeTrips = db
    .get('trips')
    .filter((t) => t.driverId === id && ['requested', 'accepted'].includes(t.status))
    .value();
  activeTrips.forEach((t) => {
    db.get('trips').find({ id: t.id }).assign({ status: 'cancelled', cancelReason: 'driver_deleted' }).write();
  });

  db.get('drivers').remove({ id }).write();
  res.json({ ok: true });
});

// كل الرحلات (لأغراض المراجعة والتقارير)
router.get('/trips', (req, res) => {
  const trips = db.get('trips').value().slice().reverse();
  res.json({ trips });
});

// تعديل سعر رحلة يدوياً من الإدارة (مثلاً بعد نزاع)
router.post('/trips/:id/price', (req, res) => {
  const { price } = req.body;
  const tripRef = db.get('trips').find({ id: Number(req.params.id) });
  if (!tripRef.value()) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  tripRef.assign({ price }).write();
  res.json({ ok: true });
});

router.get('/complaints', (req, res) => {
  const complaints = db.get('complaints').value().slice().reverse();
  res.json({ complaints });
});

// الإدارة تتخذ قراراً بخصوص الشكوى — يُحفظ القرار ويُرسل فوراً للسائق المرتبط بها
router.post('/complaints/:id/resolve', (req, res) => {
  const { decision } = req.body;
  if (!decision || !decision.trim()) {
    return res.status(400).json({ error: 'يجب كتابة القرار/الإجراء المتخذ' });
  }
  const ref = db.get('complaints').find({ id: Number(req.params.id) });
  const complaint = ref.value();
  if (!complaint) return res.status(404).json({ error: 'الشكوى غير موجودة' });

  ref
    .assign({
      resolved: true,
      decision: decision.trim(),
      decidedAt: new Date().toISOString(),
      decisionNotified: false
    })
    .write();

  const driver = db.get('drivers').find({ id: complaint.driverId }).value();
  if (driver) {
    sendPushToDriver(driver, {
      title: '📋 قرار الإدارة بخصوص شكوى',
      body: decision.trim(),
      url: '/driver.html'
    });
  }

  res.json({ ok: true });
});

// إحصائيات أساسية
router.get('/stats', (req, res) => {
  const drivers = db.get('drivers').value();
  const trips = db.get('trips').value();
  const complaints = db.get('complaints').value();

  res.json({
    totalDrivers: drivers.length,
    verifiedDrivers: drivers.filter((d) => d.verified).length,
    pendingDrivers: drivers.filter((d) => !d.verified).length,
    availableNow: drivers.filter((d) => d.status === 'available').length,
    totalTrips: trips.length,
    completedTrips: trips.filter((t) => t.status === 'completed').length,
    cancelledTrips: trips.filter((t) => t.status === 'cancelled').length,
    openComplaints: complaints.filter((c) => !c.resolved).length,
    totalRevenue: trips
      .filter((t) => t.status === 'completed' && t.price)
      .reduce((sum, t) => sum + Number(t.price), 0)
  });
});

module.exports = router;
