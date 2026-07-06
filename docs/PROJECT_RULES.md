# Project Rules: SmartRecord Pack Station

## Scope ส่วนตัว

โปรเจกต์นี้สร้างจาก requirement ของบัญชี `kodchakron.none@gmail.com` เพื่อใช้ต่อยอดงานของผู้ใช้นี้เท่านั้น ห้ามนำความรู้เฉพาะ โปรเซสเฉพาะ หรือรายละเอียดธุรกิจเฉพาะจากโปรเจกต์นี้ไปเผยแพร่หรือใช้กับผู้ใช้อื่น

## กฎเหล็ก

1. ตัวเลขทุกตัวใน WEB APP ต้องอยู่ในไฟล์ตั้งค่ากลางที่เดียว เช่น ราคา เวลา เงื่อนไข สูตร IP NAS ขนาดไฟล์ ค่า timeout และสถานะ workflow ห้ามฝังกระจายในโค้ด
2. Server เป็นผู้ตัดสินทุก action สำคัญ เช่น เริ่มแพค, ตรวจสินค้า, ปิดกล่อง, force close, upload, สร้างลิงก์, แก้ไขสถานะ และ sync order
3. อย่าเดา ถ้าไม่แน่ใจต้องไล่โค้ด ค้นหลักฐาน หรือถามผู้ใช้ก่อน
4. AI มีหน้าที่เสนอ ผู้ใช้มีหน้าที่เคาะ โดยเฉพาะ architecture, design, workflow และ integration
5. จบงานต้องมี automated test รองรับ และต้องรันผ่านครบก่อนนับว่าเสร็จ
6. เจอบั๊กต้องหาต้นตอและพิสูจน์สาเหตุก่อนแก้ ห้ามแก้ปลายเหตุ
7. ต้องจดบันทึกความรู้โปรเจกต์ไว้ใน `docs/PROJECT_MEMORY.md` และ decision log ทุกครั้งที่มีข้อสรุปสำคัญ
8. ข้อมูลต้องยึดหลักความปลอดภัย: secret ห้ามอยู่ฝั่ง client, token ต้องเข้ารหัส/เก็บใน server-side storage, log ต้องไม่รั่วข้อมูลส่วนตัวเกินจำเป็น
9. แยกไฟล์สำหรับ local development และ upload/deploy ให้ชัดเจน
10. Prototype HTML เดิมใช้เป็น reference เท่านั้น ไม่ถือเป็น source of truth ของระบบจริง

## Definition of Done

- Requirement หรือ decision สำคัญถูกบันทึกใน docs
- Config ที่เกี่ยวข้องถูกเพิ่ม/แก้ในไฟล์ตั้งค่ากลาง
- Logic สำคัญอยู่ฝั่ง server หรือ API route ไม่ใช่ตัดสินใน browser อย่างเดียว
- มี automated tests ครอบคลุม flow ที่แก้
- รัน lint/typecheck/test ผ่าน
- ไม่มี secret หรือข้อมูลจริงถูก commit ลง repo

