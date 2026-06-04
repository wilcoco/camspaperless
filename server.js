import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { initSchema } from './src/db.js';
import { attachUser } from './src/auth.js';
import authRoutes from './src/routes/auth.js';
import adminRoutes from './src/routes/admin.js';
import memberRoutes from './src/routes/member.js';
import imageRoutes from './src/routes/images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '12mb' })); // 압축 이미지 base64 수용
app.use(cookieParser());
app.use(attachUser);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/me', memberRoutes);
app.use('/api/images', imageRoutes);

// 정적 프론트엔드
app.use(express.static(path.join(__dirname, 'public')));

// 공통 에러 핸들러
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ message: '서버 오류가 발생했습니다.' });
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] http://localhost:${PORT} 에서 실행 중`));
  })
  .catch((err) => {
    console.error('[server] 스키마 초기화 실패:', err);
    process.exit(1);
  });
