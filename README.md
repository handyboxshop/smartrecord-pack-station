# SmartRecord Pack Station

ระบบเว็บแอปสำหรับสถานีแพคสินค้า: สแกน AWB, อัดวิดีโอการแพค, ตรวจรายการสินค้า, บันทึกหลักฐาน, ค้นย้อนหลัง และเชื่อมต่อออเดอร์จากช่องทางขาย

## สถานะปัจจุบัน

- มี prototype เดิมเป็น HTML ไฟล์เดียวที่ `local/reference/smartrecord-prototype-v2.html`
- MVP แรกอยู่ที่ `web/` เป็น Node server + static web app แบบไม่มี dependency ภายนอก เพื่อให้รันได้ทันทีและมี automated test
- กฎโปรเจกต์และความรู้โปรเจกต์อยู่ใน `docs/`

## โครงสร้างโฟลเดอร์

- `docs/` เอกสารกฎ, memory, decision log, architecture proposal
- `local/` ไฟล์สำหรับทดลองในเครื่อง, reference, mock data, notes
- `web/` source code เว็บแอปที่จะ upload/deploy จริง
- `web/config/` ไฟล์ตั้งค่ากลาง ห้ามฝังตัวเลข/เงื่อนไขกระจายในโค้ด
- `deploy/` ไฟล์ deploy, environment notes, server/NAS notes
- `tests/` test plan และ automated tests

## หลักการทำงาน

ทุกการเปลี่ยนแปลงต้องยึด `docs/PROJECT_RULES.md` เป็นหลัก และต้องมี automated test รองรับก่อนนับว่างานเสร็จ

## Run

```bash
cd web
npm test
npm run dev
```

เปิดเว็บที่ `http://localhost:4173`
