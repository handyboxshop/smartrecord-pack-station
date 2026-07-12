# Decision Log

## 2026-07-12 — PR-H1 M-1/M-2: Strict Pack Guide Projection and Centralized Cleanup

## Decision

- ให้ Pack-facing pre-pack guide ใน authenticated config ใช้ literal allowlist `{ url }` เท่านั้น และห้าม pass-through source object ทุกแบบ
- ไม่ส่ง `updatedAt` ให้ Pack เพราะ Pack UI ใช้เฉพาะ `url`; `updatedAt` คงอยู่ใน Settings-facing metadata สำหรับ owner/admin ที่มี `settings:manage`
- ใช้ cleanup กลางตัวเดียวสำหรับ logout, `AUTH_REQUIRED`, `SESSION_EXPIRED`, authenticated-config failure และก่อนยอมรับ authenticated identity ใหม่

## Rationale

- metadata ของไฟล์และ actor identity ไม่จำเป็นต่อการเริ่มแพค และ future field ต้องไม่สามารถ leak โดยบังเอิญ
- session failure ต้องหยุด camera/MediaRecorder/timer และล้าง privileged data/DOM ในจุดเดียวเพื่อไม่ให้บัญชีสิทธิ์ต่ำเห็น state ของบัญชีเดิม
- public login-safe config และ device-local preferences เป็น state ที่ตั้งใจให้คงอยู่ จึงไม่ล้างระหว่าง authenticated cleanup

## Consequences

- Pack response ไม่มี `updatedBy`, actor name/email, file metadata, validation config, default URL หรือ field ใหม่ในอนาคต
- Settings metadata ยังคง protected ด้วย `settings:manage` และ owner/admin role guard ที่ตรงกับ upload route
- async authenticated responses และ camera acquisition ที่เริ่มก่อน cleanup จะถูก ignore/release ด้วย generation guard

## 2026-07-12 — Separate public and authenticated configuration

- Decision: หน้า Login ใช้ `GET /api/config/public` ซึ่ง whitelist เฉพาะข้อมูล app ขั้นต่ำ; `GET /api/config` ต้องมี valid session และส่ง section ตาม permission ของ current user
- Reason: ลด metadata exposure ก่อน authentication โดยยังให้ Auditor และ custom roles โหลดเฉพาะหน้าที่ได้รับสิทธิ์ได้ แม้ไม่มี `pack:use`
- Security boundary: server เป็นผู้ตัดสิน section ที่เปิดเผย; frontend optional chaining เป็นเพียงความทนทานของ UI ไม่ใช่ permission enforcement
- Scope: PR-H1 เท่านั้น ไม่แตะ video security, owner privilege, streaming, rate limit, runtime persistence หรือ production deployment

## 2026-07-12 — Preserve a sanitized Pack configuration lifecycle

- Decision: แยก `upload` response เป็น pack-facing allowlist สำหรับ `pack:use` และ settings-facing response สำหรับ `settings:manage`; Pack response มีเฉพาะ progress steps และ target identity ที่จำเป็นต่อ flow
- Storage rule: client ใช้ saved target ได้เฉพาะ ID ที่ server ส่งมา; target ที่หายไปหรือไม่อนุญาตต้อง fallback ไป server-approved default และ Pack flow ไม่ส่ง arbitrary target/custom path จาก client
- Session rule: token จาก login จะ persist หลัง authenticated config สำเร็จเท่านั้น; config failure ต้องพยายาม logout server session และล้าง authenticated state เดิมทั้งหมดแม้ logout request ล้มเหลว
- Verification rule: lifecycle coverage ต้องเรียก behavior ที่ใช้จริงผ่าน exported controller/helpers ไม่ใช้ source-regex เป็นหลัก และ server tests ต้องตรวจ actual response field absence สำหรับ Packer, Auditor, custom report-only และ privileged roles

## 2026-06-22

- สร้างโครงโปรเจกต์ `projects/smartrecord-pack-station/`
- บันทึกกฎเหล็กและ memory เริ่มต้น
- ผู้ใช้เคาะให้เริ่มทำได้
- เลือกทำ MVP แรกด้วย Node server + static web app แบบ zero-dependency ก่อน เพื่อให้รันและ test ได้จริงทันทีภายใต้ข้อจำกัด network/dependency
- ยังเก็บทิศทาง Next.js Full-stack เป็น architecture ระยะถัดไป เมื่อพร้อมติดตั้ง dependency และแยก production deployment
