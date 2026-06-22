// utils.js — دوال مشتركة

// معادلة Haversine لحساب المسافة (كم) بين نقطتي GPS — بدون أي API خارجي
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // نصف قطر الأرض بالكيلومتر
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const jwt = require('jsonwebtoken');

// مفتاح التوقيع — في الإنتاج الفعلي ضعه في متغير بيئة (Environment Variable) باسم JWT_SECRET
const JWT_SECRET = process.env.JWT_SECRET || 'waslni-dev-secret-change-me';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(requiredRole) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (requiredRole && decoded.role !== requiredRole) {
        return res.status(403).json({ error: 'غير مسموح بهذا الإجراء لهذا النوع من الحساب' });
      }
      req.user = decoded;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً' });
    }
  };
}

module.exports = { distanceKm, signToken, authMiddleware, JWT_SECRET };
