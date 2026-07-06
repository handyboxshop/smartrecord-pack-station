# Architecture Proposal

## เป้าหมาย

แปลง prototype SmartRecord Pack Station ให้เป็น WEB APP ที่ใช้งานจริง ดูแลต่อได้ ปลอดภัย และ deploy ได้ โดยไม่ละเมิดกฎเหล็กเรื่อง config กลางและ server authority

## ข้อเสนอ A: Next.js Full-stack App

ใช้ Next.js + TypeScript + API routes/server actions + database + storage adapter

ข้อดี:
- เหมาะกับ UI แบบ dashboard/pack station
- แยก client/server ได้ชัด
- ทำ auth, role, API, report, upload flow ใน repo เดียว
- สอดคล้องกับโปรเจกต์ `furniture-factory-erp` ที่มีอยู่ใน workspace

ข้อเสีย:
- ต้องจัดระเบียบ server boundary ให้เข้ม ไม่เช่นนั้น logic อาจไหลกลับไป client
- Video recording/upload ต้องออกแบบดี เพราะไฟล์อาจใหญ่

## ข้อเสนอ B: Static Frontend + Separate Backend API

ใช้ frontend แยกจาก backend เช่น React/Vite + Node/Fastify หรือ NestJS

ข้อดี:
- แยก local pack station และ server API ชัดเจน
- เหมาะถ้าจะต่อ hardware/NAS/local network แบบจริงจัง
- scale backend แยกได้ง่าย

ข้อเสีย:
- โครงสร้างเยอะขึ้นตั้งแต่แรก
- ต้องดูแล deploy สองส่วน

## ข้อเสนอ C: Local-first Pack Station + Cloud/Admin Web

มี local app สำหรับสถานีแพค และ web/admin สำหรับรายงาน/ค้นย้อนหลัง

ข้อดี:
- เหมาะถ้าหน้างานต้องพึ่งกล้อง/NAS/เครือข่ายภายใน
- ลดความเสี่ยง upload วิดีโอใหญ่ผ่าน browser ตรงไป cloud
- ทำงานได้ดีใน warehouse/local network

ข้อเสีย:
- ซับซ้อนกว่า MVP
- ต้องออกแบบ sync queue, retry, offline state

## Recommendation

เริ่มด้วยข้อเสนอ A: Next.js Full-stack App ก่อน เพื่อให้ได้ MVP เร็วและมี test/structure ชัด จากนั้นแยก storage adapter และ integration adapter ให้พร้อมย้ายไปข้อเสนอ C หากหน้างานต้องการ local-first จริง

## Server Authority Boundary

ฝั่ง server ต้องเป็นผู้ตัดสิน:

- ตรวจว่า AWB มีอยู่และพร้อมแพคหรือไม่
- เริ่ม pack session
- รับ scan event และคำนวณสถานะรายการสินค้า
- อนุญาต/ปฏิเสธการ force close
- จบ session และสร้าง record
- สร้าง signed/controlled share link
- ตรวจสิทธิ์ admin ก่อนบันทึก API credential
- sync/import order จาก external platform

ฝั่ง client ทำหน้าที่:

- รับ barcode input
- แสดงสถานะล่าสุดจาก server
- จัดการ camera preview/recording UI
- upload video chunk/blob ผ่าน endpoint ที่ server อนุญาต

