# SmartRecord Pack Station Project Memory

## Brand

- Current display brand: `HYD FURNITURE`
- Placeholder/example email domain for UI and mock auth users: `hyd.furniture`

## OCR / Label Import Stack

- PDF preview/render in browser: เหมาะกับ `pdf.js`
- OCR engine ฝั่ง server: `tesseract`
- PDF to image conversion ก่อน OCR: `pdftoppm`
- เอกสารสแกนหลายหน้า/หมุนเอียง/ต้องการ OCR layer: พิจารณา `OCRmyPDF` เป็น preprocessing layer ภายหลัง

## Current Decisions

- ค่าเริ่มต้น `pdfDpi` ใช้ `300` เพื่อให้เหมาะกับ OCR เอกสารมากขึ้น
- ค่าเริ่มต้น OCR language ใช้ `tha+eng`
- OCR pipeline รองรับ `OCRmyPDF` แบบ optional เพื่อ preprocess PDF ก่อนแปลงเป็น PNG
- ถ้าเปิด preprocess แล้ว `OCRmyPDF` ไม่พร้อมใช้งาน:
  - ระบบจะ fallback ไปใช้ PDF ต้นฉบับต่อได้ ถ้า `continueOnSoftFail=true`
  - warning จะถูกส่งกลับมาให้ฝั่ง client รับรู้
- OCR config รองรับ per-platform tuning ผ่าน `ocr.platforms.shopee|lazada|tiktok`
- OCR / shipping label import จะสร้าง persistent order ทันทีเมื่อมี `AWB` ที่ไม่ว่าง แม้ OCR จะอ่าน field อื่นไม่ครบ
- เมื่อไม่มี `orderNumber` ใช้ deterministic fallback `AWB-${awb}` เพื่อรักษา identity contract โดยไม่ชน AWB อื่น
- ถ้าไม่มี `SKU`:
  - ไม่ block import
  - ให้ import ได้ตามปกติ
  - ให้ส่ง warning กลับไปที่ UI ว่า `ไม่มี SKU กรุณาแก้ไข/กรอกข้อมูล หรือไม่กรอกก็ได้`
- Field OCR ที่ขาดสำหรับ shipping label ใช้ fallback: platform `custom`, buyer `Unverified customer`, SKU ว่าง, product `Unverified item from shipping label`, quantity `1`, และ barcode เป็น AWB เมื่อ SKU ว่าง
- Orders ที่ใช้ fallback มี `reviewRequired: true`; รวม OCR quantity ที่หาย/ไม่ใช่ positive integer แม้จะ persist quantity fallback เป็น `1`; แสดงให้ตรวจสอบภายหลังได้ แต่ไม่ block การเริ่ม pack session
- เมื่อแก้ไข order ที่นำเข้ามา ระบบคำนวณ `reviewRequired` ใหม่จาก platform, buyer, order number และ item lines; จะลบ field นี้ออกเมื่อแก้ fallback/incomplete value ครบแล้ว โดย SKU ว่างเพียงอย่างเดียวไม่ต้อง review หากมี barcode ใช้งานได้
- ค่าเริ่มต้น storage ตอน development ให้ใช้ `local-machine`
- `NAS host` หรือ `IP` เป็นแค่ label/ปลายทางแสดงผล ไม่ใช่ path ที่เขียนไฟล์จริง
- path ที่ระบบเขียนไฟล์จริง ต้องดูจาก `localPath` หรือ mounted path ที่ user กรอก
- ถ้า target แบบ NAS ยังชี้ไปที่ project path เช่น `local-nas/videos` ให้ถือเป็น `simulated / mounted required`
- NAS จริงจะใช้งานได้ต่อเมื่อ mount path แล้ว เช่น `/Volumes/SmartRecord` หรือ `/data/smartrecord`
- Device Settings เก็บ storage target, custom path, camera และ scanner ไว้เฉพาะ Browser/คอมพิวเตอร์ของ Pack Station นั้น ไม่ใช่ค่า shared บน server
- การกดบันทึก Device Settings จะให้ SmartRecord server ตรวจสอบปลายทาง storage; API/UI ต้องคืนเฉพาะสถานะและข้อความปลอดภัย ห้ามส่ง resolved path, write path หรือ raw filesystem error กลับ Browser
- NAS target ที่ยังต้อง mount ต้องคืนสถานะ `STORAGE_MOUNT_UNAVAILABLE` และห้ามยืนยัน writable จาก local fallback
- AWB-detected shipping labels ไม่ใช้ in-memory draft เป็น source of truth: order และ label ต้องถูก persist ผ่าน existing order/label persistence flow ทันที

## Duplicate / Conflict Rules

- `AWB` ต้อง unique เสมอ
- `orderNumber` ไม่จำเป็นต้อง unique
- `1 orderNumber` มีได้หลาย `AWB`
- แต่ `1 AWB` ห้ามไปอยู่หลาย `orderNumber`
- ถ้าไม่มี `AWB` => `AWB_REQUIRED`
- ถ้ามี `AWB` แต่ไม่มี `orderNumber` => `ORDER_NUMBER_REQUIRED`
- `AWB ซ้ำ + orderNumber ซ้ำ` => `ORDER_DUPLICATE_LABEL`
- `AWB ซ้ำ + orderNumber ไม่ซ้ำ` => `ORDER_AWB_CONFLICT`
- `orderNumber ซ้ำ + AWB ไม่ซ้ำ` => อนุญาต (`ALLOW_MULTI_AWB`)
- เมื่อ `orderNumber` ซ้ำ แต่ `AWB` เป็นตัวใหม่:
  - ห้าม block import
  - ให้ผูก `AWB` ใหม่เข้ากับ `orderNumber` เดิม
  - ให้ message ฝั่ง server/client ว่า `เพิ่มพัสดุใหม่ให้กับออเดอร์เดิม`

## Learning Capture

### What

- ก่อนหน้านี้ duplicate/conflict rule ใน code, UI, และ memory ไม่ตรงกัน ทำให้บางเคส `orderNumber ซ้ำ + AWB ใหม่` ถูก block ทั้งที่ธุรกิจจริงต้อง allow
- ก่อนหน้านี้ใบปะหน้าที่ OCR ได้บางส่วนแต่ยัง import ไม่สำเร็จ แสดงในผลอ่านชั่วคราวได้ แต่หายจากชุดข้อมูลที่หน้า `Connect / Import` ใช้ render ทำให้ user แก้ไข/ลบต่อไม่ได้

### Root Cause

- ใช้กติกาเดิมที่บังคับ `orderNumber` ให้ unique และมีการกระจาย rule ซ้ำหลายชั้น ทำให้ behavior ไม่สอดคล้องกันทั้ง import service, warning UI, และเอกสาร project memory
- ฝั่ง server register ใบปะหน้าไว้สำหรับพิมพ์ได้ แต่ไม่ได้เก็บ row แบบ draft ไว้ใน import service จึงไม่มี canonical record สำหรับ edit/delete หลัง upload

### Correct

- เมื่อ parser อ่าน `AWB` ได้แล้วแต่ยังขาด `orderNumber` ให้ถือเป็น recoverable parse result
- server ต้องส่ง partial fields กลับไปที่ UI เพื่อให้ user กรอก `orderNumber` เพิ่ม และ import ต่อแบบ manual
- duplicate / conflict ต้องตัดสินจาก service กลางชุดเดียว
- ห้ามใช้ `orderNumber ซ้ำ` เป็น conflict ถ้า `AWB` เป็นคนละตัว
- ให้ถือว่า `orderNumber ซ้ำ + AWB ใหม่` คือการเพิ่มพัสดุใหม่ให้กับออเดอร์เดิม
- อย่าฝืนใช้ OCR config เดียวกับทุกแพลตฟอร์ม เพราะ layout ของ Shopee, Lazada, TikTok ต่างกัน
- ให้เริ่มจาก generic OCR ก่อน แล้ว rerun ด้วย platform-specific tuning เมื่อ detect platform ได้
- ถ้าใบปะหน้า upload แล้วอ่านได้เพียงบางส่วน (`SKU_REQUIRED`, `PRODUCT_NAME_REQUIRED`, `QTY_REQUIRED`, `ORDER_NUMBER_REQUIRED`)
  - ให้เก็บเป็น draft ใน service กลาง
  - หน้า `Connect / Import` ต้องเห็น row นี้และมีปุ่ม `แก้ไข` / `ลบ`
  - เมื่อ user แก้ครบแล้วให้ promote draft เดิมเข้า `ORDER_DB` แทนการสร้างคนละ record

## Source ZIP / Runtime Separation

- source project ต้องไม่พก runtime files เช่น `local-nas`, `videos`, `labels`, `cloud-sync`
- runtime folders ให้ server สร้างตอน startup เอง

## Out Of Scope / Next Step

- ยังไม่ได้ใช้ `pdf.js` เพื่อปรับ preview workflow ฝั่ง client
- ถ้าจะยกระดับ OCR ต่อ:
  - เก็บ per-platform OCR tuning (`psm`, regex, fallback rules)
  - เพิ่ม regression test ระดับ API สำหรับ label import missing-order-number flow
