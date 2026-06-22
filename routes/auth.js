// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { db, nextId } = require('../db');
const { signToken } = require('../utils');

const router = express.Router();

// تخزين مؤقت لصور الهوية ودفتر السير — تُحذف بعد التحقق اليدوي من الإدارة
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB كحد أقصى لكل صورة
});

// ---------- تسجيل راكب جديد (تلقائي، بدون مراجعة) ----------
router.post('/register-rider', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'الاسم ورقم الهاتف وكلمة السر مطلوبة' });
  }
  const exists = db.get('riders').find({ phone }).value();
  if (exists) return res.status(409).json({ error: 'رقم الهاتف مسجّل مسبقاً' });

  const rider = {
    id: nextId(),
    name,
    phone,
    password: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString()
  };
  db.get('riders').push(rider).write();

  const token = signToken({ id: rider.id, role: 'rider', name: rider.name });
  res.json({ token, name: rider.name });
});

router.post('/login-rider', (req, res) => {
  const { phone, password } = req.body;
  const rider = db.get('riders').find({ phone }).value();
  if (!rider || !bcrypt.compareSync(password, rider.password)) {
    return res.status(401).json({ error: 'رقم الهاتف أو كلمة السر غير صحيحة' });
  }
  const token = signToken({ id: rider.id, role: 'rider', name: rider.name });
  res.json({ token, name: rider.name });
});

// ---------- تسجيل سائق جديد (يبقى "قيد المراجعة" حتى تؤكده الإدارة) ----------
router.post(
  '/register-driver',
  upload.fields([{ name: 'idPhoto', maxCount: 1 }, { name: 'licensePhoto', maxCount: 1 }]),
  (req, res) => {
    const { name, phone, password, nationalId, licenseNumber } = req.body;
    if (!name || !phone || !password || !nationalId || !licenseNumber) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    const exists = db.get('drivers').find({ phone }).value();
    if (exists) return res.status(409).json({ error: 'رقم الهاتف مسجّل مسبقاً' });

    const idPhotoPath = req.files?.idPhoto?.[0]?.path || null;
    const licensePhotoPath = req.files?.licensePhoto?.[0]?.path || null;

    const driver = {
      id: nextId(),
      name,
      phone,
      password: bcrypt.hashSync(password, 10),
      nationalId,
      licenseNumber,
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      idPhotoPath, // مؤقت — يُحذف فور التحقق من قبل الإدارة
      licensePhotoPath, // مؤقت — يُحذف فور التحقق من قبل الإدارة
      active: true,
      status: 'offline', // offline | available | busy
      lat: null,
      lng: null,
      lastSeen: null,
      createdAt: new Date().toISOString()
    };
    db.get('drivers').push(driver).write();

    res.json({
      message: 'تم استلام طلب التسجيل، حسابك قيد المراجعة من الإدارة قبل التفعيل.'
    });
  }
);

router.post('/login-driver', (req, res) => {
  const { phone, password } = req.body;
  const driver = db.get('drivers').find({ phone }).value();
  if (!driver || !bcrypt.compareSync(password, driver.password)) {
    return res.status(401).json({ error: 'رقم الهاتف أو كلمة السر غير صحيحة' });
  }
  if (!driver.active) {
    return res.status(403).json({ error: 'تم تعطيل هذا الحساب من الإدارة' });
  }
  if (!driver.verified) {
    return res.status(403).json({ error: 'حسابك قيد المراجعة بعد، لم تتم الموافقة عليه بعد' });
  }
  const token = signToken({ id: driver.id, role: 'driver', name: driver.name });
  res.json({ token, name: driver.name });
});

// ---------- تسجيل دخول الإدارة ----------
// بيانات الإدارة من متغيرات البيئة لتجنب وجود كلمة سر ثابتة في الكود.
// عند التشغيل لأول مرة استخدم القيم الافتراضية ثم غيّرها فوراً (انظر README).
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

router.post('/login-admin', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
  const token = signToken({ id: 0, role: 'admin', name: 'الإدارة' });
  res.json({ token, name: 'الإدارة' });
});

module.exports = router;
