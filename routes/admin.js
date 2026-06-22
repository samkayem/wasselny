// routes/admin.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { authMiddleware } = require('../utils');

const router = express.Router();
router.use(authMiddleware('admin'));

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

router.post('/complaints/:id/resolve', (req, res) => {
  const ref = db.get('complaints').find({ id: Number(req.params.id) });
  if (!ref.value()) return res.status(404).json({ error: 'الشكوى غير موجودة' });
  ref.assign({ resolved: true }).write();
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
