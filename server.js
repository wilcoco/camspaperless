import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { initSchema } from './src/db.js';
import { attachUser } from './src/auth.js';
import { logCamsConfig } from './src/cams.js';
import authRoutes from './src/routes/auth.js';
import adminRoutes from './src/routes/admin.js';
import memberRoutes from './src/routes/member.js';
import imageRoutes from './src/routes/images.js';
import diagRoutes from './src/routes/diag.js';

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
app.use('/api/diag', diagRoutes);

// 정적 프론트엔드 — 배포 직후 신/구 JS가 섞여 캐시되면 화면이 통째로 죽으므로
// 항상 재검증(no-cache)하게 한다. 파일이 그대로면 304라 비용은 거의 없다.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));

// 공통 에러 핸들러
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ message: '서버 오류가 발생했습니다.' });
});

const PORT = process.env.PORT || 3000;

// 헬스체크가 즉시 통과하도록 HTTP 서버를 먼저 바인딩한 뒤,
// 스키마 초기화는 비동기로(재시도 포함) 수행한다. DB가 잠깐 늦게 떠도 컨테이너가 죽지 않는다.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] 포트 ${PORT} 에서 수신 중`);
  if (!process.env.DATABASE_URL) {
    console.warn('[server] 경고: DATABASE_URL 이 설정되지 않았습니다. Railway에 PostgreSQL 플러그인을 추가하세요.');
  }
  logCamsConfig();
});

async function initWithRetry(maxAttempts = 10) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initSchema();
      return;
    } catch (err) {
      const wait = Math.min(30000, 2000 * attempt);
      console.error(`[server] 스키마 초기화 실패 (시도 ${attempt}/${maxAttempts}): ${err.message}. ${wait}ms 후 재시도`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.error('[server] 스키마 초기화를 끝내 완료하지 못했습니다. DATABASE_URL/Postgres 상태를 확인하세요.');
}

initWithRetry();

