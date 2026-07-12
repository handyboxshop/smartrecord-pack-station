# Decision Log

## 2026-07-12 — Separate public and authenticated configuration

- Decision: หน้า Login ใช้ `GET /api/config/public` ซึ่ง whitelist เฉพาะข้อมูล app ขั้นต่ำ; `GET /api/config` ต้องมี valid session และส่ง section ตาม permission ของ current user
- Reason: ลด metadata exposure ก่อน authentication โดยยังให้ Auditor และ custom roles โหลดเฉพาะหน้าที่ได้รับสิทธิ์ได้ แม้ไม่มี `pack:use`
- Security boundary: server เป็นผู้ตัดสิน section ที่เปิดเผย; frontend optional chaining เป็นเพียงความทนทานของ UI ไม่ใช่ permission enforcement
- Scope: PR-H1 เท่านั้น ไม่แตะ video security, owner privilege, streaming, rate limit, runtime persistence หรือ production deployment

## 2026-06-22

- สร้างโครงโปรเจกต์ `projects/smartrecord-pack-station/`
- บันทึกกฎเหล็กและ memory เริ่มต้น
- ผู้ใช้เคาะให้เริ่มทำได้
- เลือกทำ MVP แรกด้วย Node server + static web app แบบ zero-dependency ก่อน เพื่อให้รันและ test ได้จริงทันทีภายใต้ข้อจำกัด network/dependency
- ยังเก็บทิศทาง Next.js Full-stack เป็น architecture ระยะถัดไป เมื่อพร้อมติดตั้ง dependency และแยก production deployment
