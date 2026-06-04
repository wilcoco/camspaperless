# CAMS 점검관리 (CAMS Paperless)

구성원에게 **업무(점검·체크리스트)** 를 할당하고, **주기별(일/주/월/분기/년/사용자정의)** 로 수행 여부를
확인·리포트·경고하는 웹앱입니다. 모바일 우선 반응형 UI로 현장에서 **사진·점검일자·특이사항**을 입력하고,
**현장 QR 인증**과 **GPS 위치**로 “해당 위치에서 실제 수행했음”을 증빙합니다.

- 담당자 ─ 역할(업무) ─ 수행기록 구조
- 관리자: 업무 등록 / 담당자 배정 / 진행 현황 대시보드 / 업무별 리포트 / GPS 지도
- 구성원: 내 담당 업무, 다가오는 마감·미수행 **워닝**, 현장에서 즉시 수행 기록 제출
- 로그인: **CAMS ERP 로그인 API** 연동
- 배포: GitHub → **Railway** (Postgres 플러그인)

---

## 빠른 시작 (로컬)

```bash
npm install
cp .env.example .env      # 값 채우기 (아래 참고)
npm start                 # http://localhost:3000
```

로컬에서 Postgres가 필요합니다. `DATABASE_URL` 에 접속 정보를 넣으세요.

## 환경변수

| 변수 | 필수 | 설명 |
|------|:---:|------|
| `DATABASE_URL` | ✅ | Postgres 접속 URL (Railway Postgres가 자동 주입) |
| `CAMS_API_KEY` | ✅ | CAMS ERP 로그인 API Key (담당자에게 발급) — **절대 코드에 넣지 말 것** |
| `JWT_SECRET` | ✅ | 세션 서명용 랜덤 문자열 |
| `ADMIN_EMPLOYEE_IDS` | ✅ | 관리자 사번 목록(콤마 구분). 해당 사번 로그인 시 관리자 권한 |
| `TZ` | 권장 | 주기 날짜 계산 기준 시간대 (예: `Asia/Seoul`) |
| `STORAGE_DRIVER` | | `db`(기본) 또는 `s3` |
| `S3_*` | | `STORAGE_DRIVER=s3` 일 때 Cloudflare R2 등 설정 |
| `PORT` | | Railway가 자동 주입 |

> ⚠️ `CAMS_API_KEY` 는 환경변수로만 주입하세요. 코드/깃에 절대 포함하지 않습니다.

## Railway 배포

1. 이 저장소를 GitHub에 푸시 → Railway에서 **New Project → Deploy from GitHub repo** 선택
2. **Add Plugin → PostgreSQL** 추가 (자동으로 `DATABASE_URL` 주입됨)
3. 서비스 **Variables** 탭에서 환경변수 추가:
   - `CAMS_API_KEY` = 발급받은 키
   - `JWT_SECRET` = 임의의 긴 랜덤 문자열
   - `ADMIN_EMPLOYEE_IDS` = 관리자 사번들 (예: `103485,100001`)
   - `TZ` = `Asia/Seoul`
4. 배포 후 도메인 접속 → 관리자 사번으로 로그인 → 업무 등록/배정

헬스체크 경로는 `/api/health` 입니다 (`railway.json`에 설정됨).

### 이미지 저장소 비용

점검 사진은 업로드 전 **클라이언트에서 1280px / JPEG 압축**(장당 약 150~300KB)되므로
저장 비용이 매우 작습니다. 기본값은 **Postgres에 저장(`db`)** 이라 추가 서비스가 필요 없습니다.
규모가 커지면 환경변수만 바꿔 **Cloudflare R2(S3 호환, egress 무료)** 로 전환하세요:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=camspaperless
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://<공개 R2 도메인>
```

---

## 사용 흐름

### 관리자
1. **업무관리** 에서 업무 등록 — 주기(일/주/월/분기/년/N일), 사진·GPS·QR 필수 여부, 체크리스트 항목 지정
2. QR 필수 업무는 목록의 **QR** 버튼으로 코드를 인쇄해 현장 구역에 부착
3. **배정** 에서 업무에 담당자 사번 등록(미가입자도 사번으로 미리 배정 가능, 추후 로그인 시 정보 자동 갱신)
4. **현황** 에서 이번 주기 완료율·마감 임박 확인, **리포트** 에서 담당자별 수행/미수행/특이사항, **지도** 에서 GPS 분포 확인

### 구성원
1. CAMS 사번/비번으로 로그인
2. **내 업무** 에서 담당 업무와 상태(완료/대기/마감임박/미수행) 확인, 상단에 **처리 필요 워닝**
3. 업무를 눌러 사진 촬영 → (필요 시) GPS 가져오기 → 현장 QR 스캔 → 체크리스트·특이사항 입력 → 제출

---

## 주기/상태 규칙

- 각 업무는 자체 주기를 가지며, 수행 기록은 해당 주기 키(예: `2026-06`, `2026-W23`, `2026-Q2`, `C5`)에 귀속됩니다.
- 상태: `완료`(현재 주기 수행) · `대기` · `마감임박`(마감 N일 전) · `미수행`(의무였던 직전 주기 누락).
- 담당/업무 시작일 **이전** 주기는 의무로 보지 않으므로, 새로 배정된 업무가 곧바로 ‘미수행’으로 표시되지 않습니다.

## 기술 스택

- 백엔드: Node.js (ESM) + Express + PostgreSQL(`pg`)
- 인증: CAMS ERP API 프록시 + JWT 쿠키 세션
- 프론트: 바닐라 JS(모바일 우선) · Leaflet(지도) · html5-qrcode(QR) · 클라이언트 이미지 압축
- 저장소: 이미지 = Postgres(`bytea`) 또는 S3 호환(R2)

## 프로젝트 구조

```
server.js                 진입점 (Express, 스키마 초기화)
src/
  db.js                   Postgres 풀 + 스키마
  cams.js                 CAMS ERP 로그인 연동
  auth.js                 JWT 세션 / 권한 미들웨어
  periodicity.js          주기 키·범위·상태 계산
  storage.js              이미지 저장소 (db / s3)
  routes/
    auth.js               로그인/로그아웃/me
    admin.js              업무·배정·리포트·QR·지도 (관리자)
    member.js             내 업무·워닝·수행기록 (구성원)
    images.js             DB 이미지 서빙
public/                   프론트엔드 (index/app/admin + js/css)
```
