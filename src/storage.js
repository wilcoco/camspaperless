// 이미지 저장소 추상화. STORAGE_DRIVER 환경변수로 db / s3 전환.
import crypto from 'crypto';
import { query } from './db.js';

const DRIVER = (process.env.STORAGE_DRIVER || 'db').toLowerCase();

// dataURL(data:image/jpeg;base64,...) 또는 base64 문자열을 받아 {buffer, contentType} 반환
function parseImageInput(input) {
  if (!input || typeof input !== 'string') return null;
  const m = input.match(/^data:([^;]+);base64,(.*)$/);
  let contentType = 'image/jpeg';
  let b64 = input;
  if (m) {
    contentType = m[1];
    b64 = m[2];
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) return null;
  return { buffer, contentType };
}

// --- S3 (Cloudflare R2 등) 드라이버 (지연 로딩) ---
let s3Client = null;
async function getS3() {
  if (s3Client) return s3Client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  return s3Client;
}

/**
 * 이미지를 저장하고 공개 접근용 URL(또는 내부 경로)을 반환.
 * @returns {Promise<string|null>} photo_url
 */
export async function saveImage(input) {
  const parsed = parseImageInput(input);
  if (!parsed) return null;
  const { buffer, contentType } = parsed;
  const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const id = crypto.randomUUID();

  if (DRIVER === 's3') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const key = `records/${id}.${ext}`;
    const client = await getS3();
    await client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    const base = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return base ? `${base}/${key}` : key;
  }

  // 기본: DB(bytea)에 저장하고 /api/images/:id 로 제공
  await query(
    'INSERT INTO images (id, content_type, data) VALUES ($1, $2, $3)',
    [id, contentType, buffer]
  );
  return `/api/images/${id}`;
}

export async function getImage(id) {
  const { rows } = await query('SELECT content_type, data FROM images WHERE id = $1', [id]);
  return rows[0] || null;
}
