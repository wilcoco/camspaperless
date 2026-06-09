import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL 환경변수가 설정되지 않았습니다.');
}

// Railway Postgres는 보통 SSL을 요구하지 않지만, 외부 접속 URL의 경우 필요할 수 있다.
const needSsl = /sslmode=require/.test(process.env.DATABASE_URL || '') ||
  process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needSsl ? { rejectUnauthorized: false } : false,
});

// 유휴 커넥션 오류로 프로세스가 죽지 않도록 처리 (Railway에서 흔함)
pool.on('error', (err) => {
  console.error('[db] 유휴 커넥션 오류:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

// 스키마 생성 (idempotent)
export async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      employee_id  TEXT PRIMARY KEY,
      name         TEXT,
      department   TEXT,
      join_date    TEXT,
      role         TEXT NOT NULL DEFAULT 'member',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT,
      category      TEXT,
      cycle_type    TEXT NOT NULL DEFAULT 'monthly',
      cycle_days    INTEGER,
      warn_before_days INTEGER NOT NULL DEFAULT 3,
      require_photo BOOLEAN NOT NULL DEFAULT true,
      require_gps   BOOLEAN NOT NULL DEFAULT false,
      require_qr    BOOLEAN NOT NULL DEFAULT false,
      location_name TEXT,
      qr_token      TEXT UNIQUE,
      gps_lat       DOUBLE PRECISION,
      gps_lng       DOUBLE PRECISION,
      checklist     JSONB NOT NULL DEFAULT '[]',
      start_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      active        BOOLEAN NOT NULL DEFAULT true,
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id           SERIAL PRIMARY KEY,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      employee_id  TEXT NOT NULL REFERENCES users(employee_id) ON DELETE CASCADE,
      assigned_by  TEXT,
      active       BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (task_id, employee_id)
    );

    CREATE TABLE IF NOT EXISTS records (
      id            SERIAL PRIMARY KEY,
      assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
      task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      employee_id   TEXT NOT NULL,
      performed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      period_key    TEXT NOT NULL,
      note          TEXT,
      status        TEXT NOT NULL DEFAULT 'ok',
      photo_url     TEXT,
      gps_lat       DOUBLE PRECISION,
      gps_lng       DOUBLE PRECISION,
      qr_verified   BOOLEAN NOT NULL DEFAULT false,
      checklist_results JSONB NOT NULL DEFAULT '[]',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS images (
      id           TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      data         BYTEA NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_records_task_period ON records(task_id, period_key);
    CREATE INDEX IF NOT EXISTS idx_records_employee ON records(employee_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_employee ON assignments(employee_id);
  `);

  // 마이그레이션: 장소/체크리스트/QR/GPS 를 배정(assignment) 단위로 이동.
  // 같은 업무라도 구성원마다 구역·체크리스트·QR이 다를 수 있다. task 값은 "기본값(템플릿)"으로 유지.
  await query(`
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS location_name TEXT;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS qr_token TEXT;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS gps_lat DOUBLE PRECISION;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS gps_lng DOUBLE PRECISION;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_assignments_qr ON assignments(qr_token) WHERE qr_token IS NOT NULL;

    -- 기존 배정에 task 기본값 백필
    UPDATE assignments a SET location_name = t.location_name
      FROM tasks t WHERE a.task_id = t.id AND a.location_name IS NULL AND t.location_name IS NOT NULL;
    UPDATE assignments a SET checklist = t.checklist
      FROM tasks t WHERE a.task_id = t.id AND a.checklist = '[]'::jsonb AND t.checklist <> '[]'::jsonb;
    UPDATE assignments a SET gps_lat = t.gps_lat, gps_lng = t.gps_lng
      FROM tasks t WHERE a.task_id = t.id AND a.gps_lat IS NULL AND t.gps_lat IS NOT NULL;
    -- QR 필수 업무의 기존 배정에 배정별 QR 토큰 발급
    UPDATE assignments a SET qr_token = gen_random_uuid()::text
      FROM tasks t WHERE a.task_id = t.id AND t.require_qr AND a.qr_token IS NULL;
  `);

  console.log('[db] 스키마 준비 완료');
}
