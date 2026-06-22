// server.js — نقطة انطلاق التطبيق
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// تأكد من وجود مجلدي data وuploads دائماً عند بدء التشغيل،
// بدلاً من الاعتماد على ملفات .gitkeep قد لا تصل عند الرفع لـ GitHub أو غيره
['data', 'uploads'].forEach((dir) => {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

const app = express();
app.use(cors());
app.use(express.json());

// الصفحات الثابتة (راكب / سائق / إدارة)
app.use(express.static(path.join(__dirname, 'public')));

// مسارات الـ API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/drivers', require('./routes/drivers'));
app.use('/api/trips', require('./routes/trips'));
app.use('/api/complaints', require('./routes/complaints'));
app.use('/api/admin', require('./routes/admin'));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Wasselny يعمل على http://localhost:${PORT}`);
});