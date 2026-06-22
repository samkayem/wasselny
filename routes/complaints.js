// routes/complaints.js
const express = require('express');
const { db, nextId } = require('../db');
const { authMiddleware } = require('../utils');

const router = express.Router();

// أي طرف (راكب أو سائق) يمكنه تسجيل شكوى مرتبطة برقم رحلة
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
    resolved: false
  };
  db.get('complaints').push(complaint).write();
  res.json({ ok: true });
});

module.exports = router;
