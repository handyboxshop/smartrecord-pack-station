# Project Memory

## 2026-07-11 — Device Settings: Browser Print is workstation-local

- what: ปรับ workflow เครื่องพิมพ์ใน Device Settings ให้ตรงกับการติดตั้งจริงที่ server รันใน Docker บน NAS แต่เครื่องพิมพ์ต่ออยู่กับ Windows/macOS Pack Station
- root cause: UI เดิมเรียก `lpstat` จาก server และแสดงผลเสมือนเป็น printer ในเครื่อง Pack Station ทั้งที่ browser ไม่สามารถ enumerate printer ชื่อจริงหรือยืนยัน online/offline ได้; Docker image ไม่มี `cups-client`
- correct:
  - ให้ Browser Print เป็นวิธีแนะนำ/ค่าเริ่มต้น พร้อมเลือกกระดาษ A4 หรือ 100x150 mm และปุ่ม test print ที่เปิด OS print dialog
  - เก็บเฉพาะ paper-size preference ใน `localStorage` ของ workstation/browser (`smartrecord.browserPrintPreferences`); ไม่ย้าย camera/scanner deviceId ไป server
  - แยก NAS / CUPS discovery เป็นตัวเลือกเสริม ชื่อชัดเจน และเมื่อไม่มี `lpstat` ให้ตอบ `NAS_CUPS_UNSUPPORTED` โดยไม่เผย executable หรือ filesystem path
  - ลบชื่อ driver/local printer แบบคาดเดาและไม่แสดงสถานะ online ที่ไม่ได้ตรวจจริง
  - รักษา `settings:manage` ที่ route NAS/CUPS และ sanitize unhandled API error ก่อนตอบ browser
- Verification:
  - `npm test --prefix web` ผ่าน 124/124 (ต้องรันนอก sandbox เพื่อเปิด localhost สำหรับ server runtime tests)

## 2026-06-30

ปรับ Rebrand + Theme UI เป็น HYD FURNITURE:

- เปลี่ยน brand display หลักในหน้า login และ header เป็น `HYD FURNITURE`
- คงชื่อระบบ `SmartRecord Pack Station` และ subtitle `SMARTRECORD PACK STATION`
- เปลี่ยน placeholder อีเมลแสดงผลเป็น `user@example.local`
- อัปเดต asset โลโก้หลักเป็น `web/public/assets/hyd-furniture-logo.png`
- ปรับ CSS theme token หลักเป็นโทน warm wood / cream / charcoal:
  - `--brand-primary: #A66A32`
  - `--brand-primary-dark: #7C4A22`
  - `--brand-bg: #F8F3EA`
  - `--brand-card: #FFF8EF`
  - `--brand-border: #E6D6C2`
  - `--brand-text: #2B2927`
  - `--brand-muted: #7A6A5B`
- Scope รอบนี้แตะเฉพาะ brand text, logo asset และ visual theme เท่านั้น
- ไม่แตะ Pack Station logic, OCR, AWB/orderNumber validation chain หรือ business rule

## 2026-06-24

ปรับกฎซ้ำของ Manual Import จากใบปะหน้า:

- Server/domain service เป็นผู้ตัดสิน duplicate ของใบปะหน้าด้วยคู่ `เลขออเดอร์ + AWB`
- ถ้า `orderNumber` และ `AWB` ตรงกับ ORDER_DB เดิม จะตอบ `ORDER_DUPLICATE_LABEL` และห้ามนำเข้า/สแกนซ้ำ
- ถ้า AWB เดิมแต่เลขออเดอร์ไม่ตรง จะตอบ `ORDER_AWB_CONFLICT` เพื่อกันการผูกวิดีโอผิดออเดอร์
- ถ้าไม่มีเลขออเดอร์ในฟอร์ม manual ยังกันซ้ำด้วย AWB แบบเดิมและตอบ `ORDER_ALREADY_EXISTS`
- หน้า Connect / Import แสดงสถานะซ้ำเป็นกล่อง warning สีเหลือง และเปิด popup “ห้ามสแกน/นำเข้าซ้ำ” พร้อมเลขออเดอร์และ AWB
- เพิ่ม regression test ยืนยันกฎ duplicate/conflict ของ shipping label import
- ปรับ Reports table ให้เอาปุ่มซ้ำออกจากแถวรายงาน:
  - คอลัมน์ Storage เหลือเฉพาะ chip ที่จัดเก็บ เช่น `💾 local`, `🗄️ NAS`
  - คอลัมน์การกระทำเหลือปุ่มหลัก `▶ ดู` เพื่อเปิด dialog รายละเอียด
  - ลิงก์/คัดลอกยังทำต่อได้จาก dialog รายละเอียด เพื่อลดปุ่มทับซ้อนในตาราง
- เพิ่มวันที่นำเข้าในรายการ Connect / Import:
  - `createManualOrder` เก็บ `importedAt` ลง ORDER_DB โดยใช้ `labelFile.importedAt` จาก server upload เมื่อเป็นใบปะหน้า
  - `/api/orders/sync` ส่ง `importedAt` กลับให้ UI
  - การ์ดรายการนำเข้าแสดง field `วันที่นำเข้า`; order เก่าที่ไม่มี timestamp จะแสดง `-`
  - Browser verify กับใบปะหน้า Shopee จริงแล้วแสดง `24/6/2569 18:07:25`
- นำส่วนที่ไม่ถอยระบบจาก `smartrecord-pack-station V6.zip` เข้ามาใช้:
  - เพิ่ม `labelService` สำหรับบันทึก/แสดงรายการใบปะหน้าแบบ manual โดย server ตรวจ platform, วันที่, mime type และขนาดไฟล์
  - เพิ่ม permission/module `labels:manage` และแท็บ `ปริ้นใบปะหน้า`
  - เพิ่ม API `GET /api/labels` และ `POST /api/labels`
  - เพิ่มหน้า upload รูปใบปะหน้า, preview, list ใบปะหน้า และปุ่ม print ใบปะหน้า
  - เพิ่ม config กลาง `labelPrint` และ `integrations.bulkImportConfirmThreshold`
  - เพิ่ม confirm dialog ก่อนนำเข้าออเดอร์จำนวนมาก และแสดงรายการ skipped import
  - ไม่ทับไฟล์ V6 ทั้งชุด เพราะ V6 zip มีหลายไฟล์ที่เก่ากว่า current state และจะทำให้ OCR/PDF/video streaming/user audit/device settings ถอยกลับ

## 2026-06-22

เริ่มโปรเจกต์ SmartRecord Pack Station จาก prototype เดิม:

- ไฟล์ต้นทางที่ผู้ใช้ให้: `/Users/mac/Desktop/พ่อสร้างโฮม/Program/INDEX/SmartRecord & AWB/smartrecord-prototype V2.html`
- Prototype เป็น HTML เดี่ยวประมาณ 2,044 บรรทัด มี HTML/CSS/JS รวมกัน
- Flow หลักที่พบ:
  - Pack Station: สแกน AWB หรือเลขออเดอร์
  - เริ่มอัดวิดีโอผ่าน browser camera
  - สแกน SKU/barcode สินค้า
  - ยิง AWB ซ้ำเพื่อปิดกล่อง
  - ถ้าสแกนสินค้าไม่ครบ มี confirm modal เพื่อ force close
  - จำลอง upload ไป NAS
  - Complete screen พร้อม share link
  - Reports/Search ดูย้อนหลังและเปิด detail
  - Connect/Import ตั้งค่า Shopee, Lazada, TikTok Shop, 3PL และ sync/import mock orders
- Prototype ยังเป็น mock ทั้งหมด:
  - `ORDER_DB`, `RECORDS`, `EMPLOYEES`, connection status และ order pool ฝังใน JS
  - ค่า NAS `YOUR_MAIN_NAS_IP`, station `STATION-07`, employee, timeout, file size formula, upload step threshold, URLs ฝังใน UI/JS
  - Client เป็นผู้ตัดสิน business flow เกือบทั้งหมด

เพิ่ม MVP แรกใน `web/`:

- ใช้ Node HTTP server แบบไม่มี dependency ภายนอก เพื่อให้รันได้ทันทีใน workspace ที่ network ถูกจำกัด
- UI อยู่ใน `web/public/`
- API อยู่ใน `web/server/index.mjs`
- Business rules อยู่ใน `web/src/domain/packService.mjs`
- Mock orders อยู่ใน `web/data/mock-orders.json`
- Config กลางอยู่ใน `web/config/app-config.example.json`
- Automated tests อยู่ใน `web/tests/packService.test.mjs`
- Server เป็นผู้ตัดสิน:
  - เปิด pack session เฉพาะ AWB ที่รู้จัก
  - รับ scan event และอัปเดตจำนวนสินค้า
  - ปฏิเสธ barcode ที่ไม่อยู่ในออเดอร์
  - ป้องกัน over-scan
  - บังคับเหตุผลก่อน force close เมื่อสแกนไม่ครบ
  - สร้าง record หลังปิด session

ปรับธีมเว็บตามโลโก้บริษัท:

- Source logo: `/Users/mac/Desktop/พ่อสร้างโฮม/LOGO/ChatGPT Image May 13, 2026, 10_37_23 AM.png`
- Asset ในเว็บ: `web/public/assets/hyd-furniture-logo.png`
- Theme direction: soft cream, warm wood, charcoal และ beige accent ตามแบรนด์ HYD FURNITURE
- Header เปลี่ยนจาก SmartRecord-only เป็น HYD FURNITURE + SmartRecord Pack Station
- ตรวจด้วย in-app browser แล้ว โลโก้โหลดสำเร็จและ CSS variables สีแบรนด์ทำงานจริง

พัฒนาต่อจาก MVP:

- เพิ่ม stage `Upload` ระหว่าง Pack และ Complete ตาม prototype เดิม
- Upload stage ใช้ config กลาง `upload.simulationSteps` ไม่ฝัง step/pct ในโค้ด UI
- Public config ส่ง `upload.simulationSteps` ให้ client เพื่อ render ขั้นตอน
- Reports เพิ่ม search/filter:
  - ค้นหา AWB, platform, employee, station
  - กรอง status `pass` / `warn`
  - กรอง platform Shopee/Lazada/ทั่วไป
- ตรวจผ่าน browser แล้ว:
  - Demo Lazada flow ไปถึง complete ได้
  - Reports search `LZD` เหลือ 1 รายการตรงกับ record

กู้และพัฒนาแท็บ Connect / Import:

- เพิ่มแท็บ `Connect / Import` กลับเข้า UI
- เพิ่ม server endpoints:
  - `POST /api/connect/test`
  - `POST /api/connect/save`
  - `POST /api/orders/sync`
  - `POST /api/orders/import`
- เพิ่ม `web/src/domain/importService.mjs` ให้ server เป็นผู้ sync/import และ mutate ORDER_DB ฝั่ง server
- เพิ่ม mock sync data ที่ `web/data/mock-sync-orders.json`
- รองรับ mock connection success/error:
  - Shopee success
  - Lazada success
  - TikTok token expired error
  - 3PL success
- ตรวจด้วย API แล้ว: sync Shopee 3 รายการ, import 1 รายการ, AWB ที่ import start pack ได้ทันที
- ตรวจด้วย browser แล้ว: แท็บ Connect / Import แสดง 4 platform cards และ sync list

นำระบบจาก `/Users/mac/Downloads/smartrecord-prototype.html` เข้ามาเพิ่มเติม:

- ใช้ไฟล์ prototype 2,044 บรรทัดเป็น reference ใหม่
- เพิ่ม webcam preview/record badge/timer ใน Pack Station
- เริ่ม camera เมื่่อเปิด pack session และหยุดเมื่อปิด session/reset
- เพิ่ม seeded historical records 26 รายการฝั่ง server เพื่อให้ Reports มีข้อมูลตั้งต้นเหมือน prototype
- Reports เพิ่ม filters ครบขึ้น:
  - AWB/platform/employee/station search
  - status
  - platform
  - employee
  - date range
- Reports เพิ่ม detail dialog พร้อม stream mock, metadata, file size, storage, status และ copy link
- Complete receipt เปลี่ยนเป็น copy link action
- Connect / Import เพิ่ม select all / clear selection เหมือน prototype
- ตรวจด้วย API:
  - `/api/reports` มี 26 records
  - TikTok mock connection ส่ง token expired error
  - sync ready orders ได้ 8 รายการ
- ตรวจด้วย browser:
  - localhost มี tabs Pack Station / Reports / Connect / Import / Rules
  - มี video element, detail dialog, report filters และ platform cards
  - Reports มี 26 rows และคลิกเปิด detail ได้

เพิ่ม video recording/upload จริงระดับ local MVP:

- Browser ใช้ `MediaRecorder` อัด webcam เป็น `.webm`
- เมื่อปิด session ระบบหยุด recorder แล้ว `POST /api/video/upload`
- Server รับ binary `video/webm` และเขียนไฟล์ลง `web/local-nas/videos`
- Config ใหม่: `upload.localNasPath`
- Server ผูก metadata ไฟล์กลับเข้า record ด้วย `attachVideoToRecord`
- Complete receipt และ detail panel แสดงชื่อไฟล์วิดีโอเมื่อมีไฟล์
- ตรวจด้วย API แล้ว:
  - อัปโหลด binary จำลองสำเร็จ
  - ไฟล์ถูกสร้างใน `web/local-nas/videos/...webm`
  - `/api/reports` มี `video` metadata ใน record

เพิ่มการเลือกที่จัดเก็บไฟล์:

- Config กลาง `upload.storageTargets` มีตัวเลือก:
  - `main-nas` ค่าเริ่มต้น: NAS หลัก `YOUR_MAIN_NAS_IP`
  - `custom-nas`: NAS กำหนดเอง สำหรับกรอก Custom Path เอง
  - `local-machine`: เก็บลงเครื่องนี้
  - `local-backup`: สำรองในเครื่องนี้
  - `local-cloud-sync`: Cloud Sync
  - `backup-nas`: NAS สำรอง `YOUR_BACKUP_NAS_IP`
- หน้า Pack Station มี dropdown `ที่จัดเก็บไฟล์วิดีโอ` พร้อมค่าเริ่มต้น
- `startPackSession` รับ `storageTargetId` และ record เก็บ `storage.targetId/label/provider/host`
- `/api/video/upload` รับ `storageTargetId` และเขียนไฟล์ไปยัง path ของ target ที่เลือก
- ตรวจด้วย API แล้ว: เลือก `local-backup` แล้วไฟล์ถูกเขียนไป `local-nas/local-backup/...webm`
- ตรวจด้วย browser แล้ว: dropdown แสดง target ตาม config และ default เป็น `main-nas`
- Settings dialog แสดง provider type ให้ชัดเจน: NAS / เครื่องนี้ / Cloud Sync
- `Custom Path` ยังเป็น optional override สำหรับ path เริ่มต้น และ server ยังจำกัด path ให้อยู่ใน project-local storage เพื่อความปลอดภัย
- Frontend validate `Custom Path / Website URL` ทันที: URL ใช้ได้เฉพาะ Cloud Sync, ห้าม `..`, ห้าม absolute path นอก project-local storage; ปุ่ม Save disabled เมื่อ path ผิด
- Backend `/api/video/upload` ตอบ error 400 แบบอ่านได้เมื่อ custom path ไม่ปลอดภัย แทนการปล่อยเป็น generic server error
- Cloud Sync รองรับ `Website URL` เว็บภายนอกได้เฉพาะ provider `cloud-sync`; NAS/เครื่องนี้ยังห้าม URL
- เมื่อ Cloud Sync ใช้ URL เว็บภายนอก server ยังเขียนไฟล์ลง local staging (`local-nas/cloud-sync`) และบันทึก `externalUrl`/`storageMode=external-cloud-sync` ใน video metadata เพื่อเตรียมต่อ API เว็บจริงภายหลัง

แก้ login copy-paste:

- Login trim อีเมลและรหัสผ่านหัวท้ายทั้ง frontend/backend เพื่อกันช่องว่างติดมาจากการ copy-paste
- เพิ่ม test `login tolerates copy-pasted whitespace around credentials`
- ตรวจ HTTP แล้ว `admin@example.local` / รหัสเดิม เข้าได้แม้มีช่องว่างหัวท้าย

ปรับ Employee ในหน้า User Admin:

- เปลี่ยนจาก dropdown `Employee ID` เป็นช่องกรอก 2 ช่อง: `ชื่อพนักงาน` และ `เลขประจำตัวพนักงาน`
- มี datalist แนะนำจาก `config.employees.list`
- ถ้ากรอกชื่อพนักงานที่มีใน list จะเติมเลขพนักงานให้อัตโนมัติ และถ้ากรอกเลขจะเติมชื่อกลับให้
- Backend เก็บ/ส่ง `employeeName` คู่กับ `employeeId`; user เก่าที่มีแค่ `employeeId` จะ derive ชื่อจาก config ให้
- Audit log เปลี่ยน label เป็น `พนักงาน` และแสดงรูปแบบ `ชื่อ (EMP-xxxx)`

แก้ camera preview ในหน้า Pack:

- สาเหตุเดิม: `noCam` overlay กินเต็ม record frame และอยู่ตำแหน่งเดียวกับ AWB overlay ทำให้ข้อความ “ไม่พบกล้อง / ยังไม่ได้อนุญาต” ซ้อนกับ AWB
- แก้เป็น `.sessionOverlay` สำหรับกล่อง AWB โดยตรง และย้าย `noCam` เป็นแถบสถานะด้านล่างของ frame
- ข้อความใหม่: `ยังไม่พบภาพจากกล้อง กรุณาอนุญาตกล้องใน Browser`
- ตาม decision ล่าสุด: การเลือก/Test กล้องอยู่ใน `Device Settings` เท่านั้น ไม่อยู่ใต้ Webcam ในหน้า Pack
- เพิ่ม `refreshCameraDevices()` เพื่อ enumerate `videoinput` จริงจาก browser หลัง permission เปิด
- เพิ่ม helper เปิดกล้องกลาง `openCameraStream()` พร้อม fallback จาก device เฉพาะกลับไป default camera เมื่อ device เก่าไม่พร้อม
- เพิ่ม `cameraErrorMessage()` เพื่อแยกสาเหตุ: permission block, ไม่พบกล้อง, กล้องถูกโปรแกรมอื่นใช้งาน, browser ไม่รองรับ
- Browser verify ล่าสุดเปิดกล้องไม่ได้เพราะ permission: `เปิดกล้องไม่ได้: กรุณาอนุญาต Camera Permission ใน Browser`
- เพิ่ม `cameraPermissionStatus` ใน Device Settings เพื่ออ่าน state `navigator.permissions.query({ name: "camera" })`
- Browser verify ล่าสุด permission เป็น `denied`: ไม่มี popup ขึ้น เพราะ site ถูกบล็อกแล้ว ต้องปลดบล็อกจาก Site Settings ของ Browser
- ย้าย AWB/Platform ออกจาก overlay กลาง record frame ไปอยู่ใน `metaGrid` ใต้ภาพกล้อง เพื่อไม่บังวิดีโอหลัก
- เปลี่ยน `deviceSummary` หน้า Scan จากข้อความยาวเป็น status chips 5 รายการ: พนักงาน, กล้อง, เครื่องพิมพ์ฉลาก, ที่จัดเก็บวิดีโอ, Barcode Scanner
- สีเขียว `.connected` = พร้อม/ตั้งค่าใช้งานได้, สีแดง `.disconnected` = ยังไม่ได้เชื่อมต่อหรือ permission ไม่ผ่าน
- Browser verify ล่าสุด: `พนักงาน: สมชาย ป.` เขียว, `กล้อง` แดงเพราะ camera permission denied, printer/storage/scanner เขียว
- Device Settings เครื่องพิมพ์ฉลากแบ่ง dropdown เป็น `เครื่องพิมพ์ที่เคยเชื่อมต่อ` และ `Browser Print ค้นหาเพื่อเชื่อมต่อเครื่องพิมพ์`
- `browser-print` เป็นโหมดค้นหา/เลือกตอนสั่งพิมพ์ จึงยังไม่ถือว่าเชื่อมต่อเครื่องเฉพาะและ chip เครื่องพิมพ์เป็นแดง
- เลือกเครื่องที่เคยเชื่อมต่อ เช่น `TSC TE244 / TTP Series` แล้ว status/chip เครื่องพิมพ์เป็นเขียว
- เพิ่ม Platform select ก่อนเริ่มแพคทุกครั้ง: `Shopee`, `Lazada`, `Tiktok`, `custom`; ค่า platform ที่เลือก override platform จาก order ตอนเปิด session
- Browser verify: เลือก `Tiktok` แล้วเริ่ม AWB `SPX-TH-88213940` ได้ session platform เป็น `Tiktok`
- เพิ่ม printer discovery endpoint `/api/devices/printers` ใช้ local server เรียก `lpstat -p` เพื่อค้นหา printer driver ในเครื่อง
- Device Settings ปุ่ม `ค้นหาเครื่องพิมพ์ในเครื่อง` เติม optgroup `เครื่องพิมพ์ที่พบในเครื่อง`; browser verify พบ `EPSON L3250 Series` และเลือกแล้ว status/chip เครื่องพิมพ์เป็นเขียว
- ลบ Tab `Rules` และ `rulesView` ออกจากหน้าเว็บแล้ว; navigation เหลือ Pack Station / Reports / Connect / Import / Users

เพิ่ม Settings ขวาบน:

- Header ขวาบนมีปุ่ม `Settings`
- Settings modal รวมค่า:
  - ที่จัดเก็บไฟล์วิดีโอ
  - Set กล้อง Test
  - เลือก Driver เครื่องพิมพ์ฉลาก
  - Barcode Scanner เข้า USB
- Config กลาง `devices` เพิ่ม:
  - camera options
  - label printer drivers
  - barcode scanner modes
- Settings บันทึกลง `localStorage` ของ browser และใช้ตอนเริ่ม pack session
- หน้า Pack แสดง summary ของ Settings ปัจจุบัน
- ตรวจด้วย browser แล้ว:
  - Settings dialog เปิดได้
  - มี storage targets 3 รายการ
  - มี camera option
  - มี printer drivers: Browser Print, TSC, Xprinter, Zebra/ZPL
  - มี scanner modes: USB Keyboard Wedge, Manual Input
  - เปลี่ยนเป็น NAS สำรอง / Zebra ZPL / Manual Input แล้ว summary เปลี่ยนตาม

เพิ่ม custom storage path:

- Settings มีช่องกรอก path ที่ต้องการนำไฟล์วิดีโอไปวาง
- ค่าถูกเก็บใน `deviceSettings.customStoragePath`
- Upload endpoint รับ query `customPath`
- Server ใช้ custom path แทน `storageTarget.localPath` เมื่อมีค่า
- Server block path ที่มี `..` หรือ path absolute ที่อยู่นอก project root
- ตรวจด้วย API แล้ว: custom path `local-nas/custom-user-path` เขียนไฟล์สำเร็จ
- ตรวจด้วย browser แล้ว: ช่องกรอก path แสดงใน Settings

เพิ่ม Login / User Account / Permission:

- เพิ่ม auth config กลางใน `web/config/app-config.example.json`
- Role เริ่มต้น:
  - `admin`: pack, reports, integrations, settings, users
  - `manager`: pack, reports, integrations, settings
  - `packer`: pack เท่านั้น
  - `auditor`: reports เท่านั้น
- User เริ่มต้นเป็น password hash แบบ PBKDF2-SHA256 ไม่เก็บ plaintext:
  - `admin@example.local` / `[กำหนดรหัสจริงใน app-config.json บน NAS]`
  - `manager@example.local` / `[กำหนดรหัสจริงใน app-config.json บน NAS]`
  - `packer@example.local` / `[กำหนดรหัสจริงใน app-config.json บน NAS]`
  - `auditor@example.local` / `[กำหนดรหัสจริงใน app-config.json บน NAS]`
- เพิ่ม `web/src/domain/authService.mjs`
  - login/logout/session token
  - role permission guard
  - list/create/update user แบบ in-memory MVP
  - server ไม่ส่ง `passwordHash/passwordSalt` กลับไป client
- เพิ่ม endpoints:
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - `POST /api/auth/logout`
  - `GET /api/users`
  - `POST /api/users`
  - `POST /api/users/update`
- ครอบ API ด้วย permission ฝั่ง server:
  - pack endpoints และ video upload ต้องมี `pack:use`
  - reports ต้องมี `reports:view`
  - connect/import ต้องมี `integrations:manage`
  - users ต้องมี `users:manage`
- Frontend:
  - หน้า login ก่อนเข้า app
  - topbar แสดง user/role และ logout
  - ซ่อนแท็บตาม permission
  - เพิ่มแท็บ Users สำหรับ admin สร้าง user และดู permission
  - Settings ถูกซ่อนถ้าไม่มี `settings:manage`
- ตรวจด้วย browser แล้ว:
  - admin login แล้วเห็นทุกแท็บและหน้า Users มี 4 users
  - packer login แล้วเห็นเฉพาะ Pack Station กับ Rules
  - API `/api/users` ด้วย token packer ถูกปฏิเสธ `FORBIDDEN`
- Automated tests เพิ่ม `authService.test.mjs`; test รวมผ่าน 13 รายการ

ปรับ User Account / Permission ตามระบบเปิดใบสั่งผลิต:

- อ้างอิงระบบ `projects/furniture-factory-erp/lib/auth-service.ts` และ `lib/auth-config.ts`
- แนวที่นำมาใช้:
  - permission รายโมดูลแบบ `canView/canEdit`
  - custom role
  - audit log เมื่อสร้าง/แก้ไข user
  - admin เท่านั้นที่จัดการ user ได้
- SmartRecord mapping:
  - `pack` -> `pack:use`
  - `reports` -> `reports:view`
  - `connect` -> `integrations:manage`
  - `settings` -> `settings:manage`
  - `users` -> `users:manage`
- Config กลาง `auth.modules` เป็น single source of truth สำหรับเมนูและ permission mapping
- Role preset ใช้ `modulePermissions` แทน string permission ตรง ๆ แต่ server ยัง derive `permissions` เพื่อคุม API เดิม
- หน้า Users เพิ่ม:
  - role preset: Admin, Manager, Packer, Auditor, Custom
  - permission matrix ดู/แก้ไขรายโมดูล
  - custom role name
  - edit user จากรายการเดิม
  - audit log
- ตรวจด้วย browser แล้ว:
  - Admin เห็น matrix ครบ 5 โมดูล
  - Preset role lock checkbox
  - เลือก Custom แล้ว checkbox ปลดล็อก
  - สร้าง `station-lead@example.local` พร้อม custom role ได้
  - audit log เกิด 1 event ใน session dev
- Automated tests ครอบ custom role และ permission normalization แล้ว; test รวมผ่าน 14 รายการ

ขยาย User History / Activity ตามคำขอ:

- แยก log เป็น 2 ประเภท:
  - `auditLogs`: ประวัติการแก้ไข User / Permission พร้อมรายละเอียดว่า field ไหนเปลี่ยนจากค่าอะไรเป็นอะไร
  - `activityLogs`: ประวัติการทำงานของแต่ละ user ในระบบ
- `authService` เพิ่ม:
  - `listActivity(token, { email })`
  - `recordActivity(token, activity)`
  - login/logout activity
  - create/update user activity
  - audit change detail สำหรับ name, role, employeeId, active, permissions และ password changed
- Server เพิ่ม endpoint:
  - `GET /api/users/activity`
  - `GET /api/users/activity?email=...`
- Server ผูก activity กับ action จริง:
  - pack start
  - pack scan / rejected scan
  - pack close / force close
  - video upload
  - reports view
  - connection test/save
  - orders sync/import
- หน้า Users เพิ่ม:
  - กล่อง `ประวัติการแก้ไข User / Permission`
  - กล่อง `ประวัติการทำงานของ User`
  - filter เลือก user เพื่อดู activity ย้อนหลังเฉพาะคน
- ตรวจด้วย browser แล้ว:
  - หน้า Users มี 4 section: create form, user list, user audit, user activity
  - สร้าง custom user ผ่าน UI ได้
  - audit แสดงรายละเอียดเช่น ชื่อ, Role, Employee ID, สถานะ, สิทธิ์
  - แก้ user เดิมแล้ว audit แสดง old -> new
  - filter activity ราย user ได้
- Automated tests เพิ่มกรณี user update audit + activity history; test รวมผ่าน 15 รายการ

Merge จาก `smartrecord-pack-station-updated.zip`:

- Source zip: `/Users/mac/Desktop/พ่อสร้างโฮม/Program/INDEX/SmartRecord & AWB/smartrecord-pack-station-updated.zip`
- ตรวจแล้ว zip มี UI update ที่มีประโยชน์ แต่ `web/public/assets/app.js` ใน zip มี object ซ้ำและถ้าเอาทับตรง ๆ จะทำให้ JS พัง รวมถึงจะย้อนฟีเจอร์ activity history
- สิ่งที่ merge เข้าเวอร์ชันปัจจุบัน:
  - login card ใหม่ พร้อม error box, password toggle และ loading state
  - topbar user chip/dropdown พร้อม role badge
  - settings modal แบบจัด section: storage, camera, printer, scanner
  - camera preview ใน settings test โดยใช้ stream แยกจากกล้อง pack station
- สิ่งที่รักษาไว้จากเวอร์ชันปัจจุบัน:
  - user audit log แบบบอก field old -> new
  - activity history/filter ราย user
  - server-side permission guard และ activity recording
- ตรวจแล้ว:
  - `node --check` ผ่านสำหรับ app.js/server/authService
  - `npm test` ผ่าน 15 รายการ
  - browser login admin ได้, user dropdown เปิดได้, settings modal เปิดได้, Users activity history ยังอยู่
  - browser console ไม่มี error

UI polish ตามรายการ Login / Topbar / Settings:

- Login:
  - error state แยกเป็นกล่อง `#loginError`
  - hint ไม่แสดง plaintext credentials
  - login button มี loading text `กำลังตรวจสอบ...`
  - password toggle แสดงเป็น `👁`
- Topbar:
  - station ID และ clock อยู่ใน `.stationInfo`
  - user chip มี avatar ตัวอักษรแรก, ชื่อ, role badge
  - dropdown มีชื่อเต็ม, อีเมล, divider, `⚙ Device Settings`, `↩ ออกจากระบบ`
  - Settings/Logout ย้ายเข้า dropdown ไม่ลอยบนแถบ
- Settings Dialog:
  - 4 section icon/title: `💾` ที่จัดเก็บวิดีโอ, `📷` กล้อง Webcam, `🖨` เครื่องพิมพ์ฉลาก, `⊞` Barcode Scanner
  - ปุ่ม `▶ ทดสอบกล้อง` เปิด preview ใน modal ผ่าน `settingsCameraStream`
  - Save/Cancel อยู่ footer `.settingsActions`
  - Save/Cancel/Close เรียก `closeSettingsDialog()` เพื่อหยุด preview และปิด dialog
- ตรวจด้วย browser แล้ว login UI, topbar dropdown, settings sections/footer ตรงตาม spec และไม่มี console error
- `npm test` ผ่าน 15 รายการ

## ประเด็นที่ต้องยืนยันกับผู้ใช้

- ยืนยัน storage ปลายทาง: NAS local, cloud object storage, หรือ hybrid
- ยืนยัน platform integration ระยะแรก: Shopee/Lazada/TikTok/3PL/CSV
- ยืนยันว่าจะย้าย MVP นี้ไป Next.js ทันที หรือทำ Node server ให้ครบ flow ก่อน

## Save Point 2026-06-23 — นำ zip เวอร์ชันปรับปรุงมาใช้

- Source zip: `/Users/mac/Downloads/smartrecord-pack-station (1).zip`
- ก่อนทับโปรเจกต์ได้สำรองเวอร์ชันเดิมไว้ที่ `/Users/mac/Documents/PORSANG HOME/backups/smartrecord-pack-station-before-zip-20260623-1330`
- เปลี่ยน project root ปัจจุบันเป็นชุดจาก zip ใหม่ที่ `/Users/mac/Documents/PORSANG HOME/projects/smartrecord-pack-station`
- ตรวจหลังนำมาใช้:
  - `node --check web/public/assets/app.js` ผ่าน
  - `node --check web/server/index.mjs` ผ่าน
  - `npm test` ผ่าน 24/24
  - เปิดจริงที่ `http://localhost:4173/` แล้ว login admin ได้
  - login มี error box, password toggle และไม่มี plaintext credential ใน hint
  - หน้า Pack Station มี Platform selector: Shopee, Lazada, Tiktok, custom
  - Device summary แสดงพนักงานชื่อจริง, กล้อง, เครื่องพิมพ์ฉลาก, ที่จัดเก็บวิดีโอ, Barcode Scanner
  - Rules tab ไม่อยู่ใน navigation
  - Device Settings มีปุ่มค้นหาเครื่องพิมพ์ในเครื่อง
- Rollback: ถ้า zip ใหม่นี้ไม่ถูกใจ ให้ย้าย backup path ด้านบนกลับมาแทน `projects/smartrecord-pack-station`

## 2026-06-23 — ทำให้ Custom Path / Website URL ใช้งานได้จริงขึ้น

- Root cause: Device Settings เดิม validate custom path แค่ฝั่ง client และใช้จริงเฉพาะตอน `/api/video/upload`; ปุ่ม Save ยังไม่ได้ให้ server ตรวจหรือเขียนไฟล์ทดสอบ ทำให้ผู้ใช้เห็นว่า path/URL “เหมือนบันทึกได้” แต่ยังไม่พิสูจน์ว่าใช้ได้จริง
- แก้ไข:
  - เพิ่ม domain function `verifyStorageDestination()` ใน `web/src/domain/storagePath.mjs`
  - เพิ่ม endpoint `POST /api/devices/storage/test` พร้อม permission `settings:manage`
  - Save Settings เรียก server เพื่อตรวจ storage ก่อนบันทึก `localStorage`
  - Server ลอง `mkdir`, เขียนไฟล์ probe, แล้วลบ probe เพื่อพิสูจน์ path เขียนได้จริง
  - Custom Path รองรับ path ภายในโปรเจกต์และ absolute path ที่ไม่ใช่ root ของเครื่อง
  - Website URL ใช้ได้เฉพาะ target `cloud-sync`; server บันทึกเป็น external destination และเขียนไฟล์จริงลง local fallback folder
  - Receipt/Record detail แสดง destination ของวิดีโอ: relative file path หรือ external URL + local fallback
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `node --check web/server/index.mjs` ผ่าน
  - `npm test` ผ่าน 28/28
  - ตรวจ HTTP จริงกับ `http://localhost:4173/api/devices/storage/test`:
    - `local-machine + local-nas/browser-verified-path` ผ่านและ writable
    - `local-cloud-sync + https://drive.google.com/drive/folders/demo` ผ่าน พร้อม `externalUrl`
    - `main-nas + https://drive.google.com/drive/folders/demo` ถูก reject ด้วย `INVALID_CUSTOM_STORAGE_URL`
- ข้อจำกัดที่ตั้งใจ: Google Drive folder URL ยังไม่ใช่ upload API; ระบบจึงยังไม่ส่งไฟล์ขึ้น Google Drive โดยตรงจนกว่าจะต่อ Google Drive API/OAuth หรือ local sync agent จริง

## 2026-06-23 — แยกสถานะบันทึกออเดอร์กับสถานะวิดีโอ

- what: หน้าสรุปหลังแพคขึ้นหัว “บันทึกสำเร็จ” แม้ `Video File` เป็น “ไม่มีไฟล์วิดีโอ” และ `Destination` เป็น `-`
- root cause: flow ปิด session สร้าง record สำเร็จได้แม้ browser ไม่มี blob วิดีโอ เช่น กล้องเปิดไม่ได้, permission ถูกบล็อก, หรือ `MediaRecorder` ไม่เริ่มทำงาน แต่ UI final receipt ใช้ข้อความสำเร็จแบบรวม ทำให้เข้าใจว่า upload วิดีโอสำเร็จด้วย
- correct:
  - หลัง `stopAndUploadRecording()` ถ้าไม่ได้ video ให้ตั้ง `record.videoMissingReason`
  - หัวหน้า complete เปลี่ยนเป็น “บันทึกออเดอร์สำเร็จ แต่ไม่มีวิดีโอ”
  - Receipt เพิ่ม `Video Status` และแสดงสาเหตุแทนคำว่าไม่มีไฟล์เฉย ๆ
  - Toast แยก “บันทึก record และวิดีโอสำเร็จ” กับ “บันทึกออเดอร์แล้ว แต่ไม่มีไฟล์วิดีโอ”
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 28/28

## 2026-06-23 — เพิ่มแบบฟอร์มนำเข้าออเดอร์เอง

- เพิ่มฟอร์มในหน้า Connect / Import ใต้ Sync Orders:
  - AWB / Order ID
  - Platform: Shopee, Lazada, TikTok, 3PL/custom
  - ลูกค้า / ร้านค้า
  - จำนวนรายการสินค้า 1-50
- Server endpoint ใหม่ `POST /api/orders/manual` ใช้ permission `integrations:manage`
- Server/domain service `createManualOrder()` เป็นผู้ validate และเพิ่มออเดอร์เข้า ORDER_DB ใน memory
- หลังนำเข้า UI เติม AWB ไปหน้า Pack Station เพื่อยิงต่อได้ทันที
- เพิ่ม activity log `orders_manual_create`
- Verification:
  - `node --check` ผ่านสำหรับ `importService.mjs`, `server/index.mjs`, `app.js`
  - `npm test` ผ่าน 30/30
  - Browser DOM มี `#manualOrderForm` และ field ครบ
  - HTTP จริง: สร้าง AWB `FORM-*` จาก `/api/orders/manual` แล้ว `/api/pack/start` ใช้ AWB นั้นได้ทันที

## 2026-06-23 — ไม่สร้างลิงก์วิดีโอถ้าไม่มีไฟล์จริง

- what: หน้าสรุปแสดงปุ่มคัดลอกลิงก์ เช่น `https://YOUR_SHARE_DOMAIN/v/...` ทั้งที่ `Video File` เป็น “ไม่มีไฟล์วิดีโอ”
- root cause: `packService.closePackSession()` สร้าง `shareLink` ตั้งแต่ปิดออเดอร์ ก่อนขั้นตอน upload/attach video จึงมี fake clip URL แม้ browser ไม่ได้ส่งไฟล์วิดีโอ
- correct:
  - ตอน close session ตั้ง `record.shareLink = null`
  - สร้าง `shareLink` เฉพาะใน `attachVideoToRecord()` หลัง upload สำเร็จและมี video metadata จริง
  - UI complete/report/detail แสดง “ไม่มีลิงก์วิดีโอ” และปิดปุ่ม copy เมื่อไม่มี `record.video` หรือไม่มี `shareLink`
- Verification:
  - `node --check web/src/domain/packService.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 30/30
  - HTTP จริง: สร้าง/ปิด record แบบไม่มี upload video แล้ว response ได้ `shareLink: null`

## 2026-06-23 — shareLink ต้องชี้ไฟล์วิดีโอจริง

- what: ผู้ใช้ต้องการให้ `shareLink` ยังมีอยู่ได้ แต่ต้องเป็นลิงก์จริงไปยังไฟล์วิดีโอที่บันทึกไว้ ไม่ใช่ fake URL `YOUR_SHARE_DOMAIN`
- root cause: เดิม `shareLink` สร้างจาก config `shareLinks.publicBaseUrl` และไม่ได้ผูกกับไฟล์จริงบน storage
- correct:
  - เพิ่ม endpoint `GET /api/video/stream/:recordId`
  - หลัง `/api/video/upload` เขียนไฟล์สำเร็จ server สร้าง `video.shareLink` เป็น URL จริงของ endpoint stream เช่น `http://localhost:4173/api/video/stream/<recordId>`
  - `packService.attachVideoToRecord()` ใช้ `video.shareLink` เป็น `record.shareLink`
  - record ที่ไม่มี video ยังคง `shareLink: null`
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/src/domain/packService.mjs` ผ่าน
  - `npm test` ผ่าน 30/30
  - HTTP จริง: upload binary 8 bytes แล้ว fetch `shareLink` ได้ status 200, `content-type: video/webm`, bytes ตรงกับไฟล์ที่อัปโหลด

## 2026-06-23 — เพิ่ม diagnostics สาเหตุไม่มีวิดีโอ

- what: ผู้ใช้ถามว่าทำไมระบบไม่บันทึกวิดีโอ แม้เลือก Cloud Sync แล้วหน้าสรุปขึ้น “ไม่มีไฟล์วิดีโอ”
- root cause: storage target จะทำงานหลัง browser ส่ง video blob แล้วเท่านั้น แต่ flow ปัจจุบันไม่มี diagnostics ละเอียดพอว่า fail ที่ขั้นกล้อง, MediaRecorder, chunk, หรือ upload
- correct:
  - เพิ่ม `recordingDiagnostics` ฝั่ง browser เก็บสถานะ camera started, camera error, recorder started, recorder error, upload error, chunks, bytes
  - `missingVideoReason()` แสดงสาเหตุเฉพาะเจาะจงกว่าเดิม
  - `stopRecordingBlob()` เรียก `mediaRecorder.requestData()` ก่อน `stop()` เพื่อดึง chunk สุดท้ายจาก browser
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 30/30

## 2026-06-23 — แก้ upload วิดีโอไม่แนบ auth token

- what: กล้องเปิดและ REC ทำงาน แต่หน้าสรุปยังไม่มีไฟล์วิดีโอ และแสดงสาเหตุ “กรุณาเข้าสู่ระบบ”
- root cause: `stopAndUploadRecording()` ใช้ `fetch('/api/video/upload')` ตรง ๆ แต่ไม่ได้แนบ `Authorization: Bearer <token>` เหมือน helper `api()` ขณะที่ server endpoint `/api/video/upload` บังคับ permission `pack:use`
- correct:
  - เพิ่ม Authorization header ใน fetch upload video โดยใช้ `state.authToken`
  - หากไม่มี token server จะยัง reject ตามเดิมเพื่อความปลอดภัย
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 30/30

## 2026-06-23 — ปรับ Device Settings ที่จัดเก็บวิดีโอจาก V4

- Source: `/Users/mac/Desktop/พ่อสร้างโฮม/Program/INDEX/SmartRecord & AWB/smartrecord-pack-station V4.zip`
- Merge เฉพาะ Device Settings storage UI ไม่ทับ backend/shareLink/upload-token fixes ล่าสุด
- เปลี่ยน Storage Target จาก dropdown เป็น card picker:
  - NAS หลัก
  - NAS กำหนดเอง
  - เก็บที่เครื่องนี้
  - สำรองในเครื่องนี้
  - Cloud Sync
  - NAS สำรอง
- ช่อง Custom Path / Website URL ถูกซ่อนโดย default และแสดงเฉพาะ target ที่ต้องใช้ custom input เช่น Cloud Sync หรือ NAS กำหนดเอง
- เพิ่ม `renderStorageCards()` และ `updateCustomPathUI()` ใน `app.js`
- เพิ่ม CSS `.storageCard*` และ `.storageCustomWrap`
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 30/30
  - Browser verify: `#storageTargetSelect` ไม่มีแล้ว, `.storageCard` มี 6 cards, Cloud Sync แสดงช่อง URL และ hint ถูกต้อง

## 2026-06-23 — Reports Storage/Link actions

- ปรับตาราง Reports:
  - คอลัมน์ `Storage` แสดง provider พร้อมปุ่ม `เปิด` และ `คัดลอกที่อยู่` เมื่อ record มีไฟล์วิดีโอจริง
  - คอลัมน์ `Link` แสดงปุ่ม `เปิด`, `คัดลอกลิงก์`, และ `คัดลอกที่อยู่` เมื่อ record มีไฟล์วิดีโอจริง
  - record ที่ไม่มีวิดีโอจริงยังแสดง `ไม่มีวิดีโอ`
- การเปิดที่เก็บ:
  - ถ้าเป็น `externalUrl` จะเปิด URL ภายนอก
  - ถ้าเป็น local/server storage จะเปิดไฟล์ผ่าน `record.shareLink` ที่เป็น `/api/video/stream/:recordId`
- การคัดลอกที่อยู่:
  - ใช้ `video.externalUrl` ก่อน
  - ถ้าไม่มี external URL ใช้ `video.relativePath`
  - fallback เป็น `record.shareLink`
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 30/30
  - Browser verify ด้วย record `REPORT-*` ที่มีไฟล์จริง: Storage มี `เปิด/คัดลอกที่อยู่`; Link มี `เปิด/คัดลอกลิงก์/คัดลอกที่อยู่`

## 2026-06-23 — Reports UX stat bar และ badge/pill

- what: ผู้ใช้ต้องการปรับหน้า Reports ให้อ่านง่ายขึ้น เห็นภาพรวมทันที และแยก action เปิด/คัดลอกชัดเจน
- root cause: หน้าเดิมใช้ text ดิบ (`pass/warn`, `nas/local`) และปุ่ม link เดียว ทำให้แยกสถานะ/แพลตฟอร์ม/ที่เก็บ/การกระทำได้ยาก
- correct:
  - เพิ่ม stat bar 4 ช่อง: รายการทั้งหมด, ผ่าน, มีข้อสังเกต, ขนาดรวม
  - เปลี่ยน status เป็น pill สี: ผ่าน/มีข้อสังเกต
  - เปลี่ยน platform เป็น pill สีตาม Shopee/Lazada/TikTok/custom
  - เปลี่ยน storage เป็น pill พร้อมไอคอน: `💾 local`, `🗄️ NAS`, `☁️ Cloud Sync`
  - แยก action เป็น `▶ ดู`, `เปิดไฟล์`, `📋 ลิงก์` และฝั่ง storage มี `เปิด`, `📋 ที่อยู่`
  - ปรับ filter bar ให้ search กว้างขึ้นและ dropdown มี emoji prefix
  - dialog รายละเอียดตัดชื่อไฟล์/path ยาวด้วย `truncateMiddle()` และใส่ `title` tooltip เต็ม
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 30/30
  - Browser verify ที่ `http://localhost:4173/`:
    - stat bar แสดง `28 รายการทั้งหมด`, `26 ผ่าน`, `2 มีข้อสังเกต`, `4.0 GB ขนาดรวม`
    - ตารางมี 28 rows, `platformPill/statusBadge/storagePill` ครบ
    - record ที่มี video จริงแสดงปุ่ม `เปิด`, `📋 ที่อยู่`, `▶ ดู`, `เปิดไฟล์`, `📋 ลิงก์`
    - detail dialog แสดงชื่อไฟล์/path แบบตัดกลางพร้อม tooltip เต็ม

## 2026-06-23 — Video file naming rule

- what: ผู้ใช้ต้องการให้ไฟล์วิดีโอจัดเก็บเป็นโฟลเดอร์รายเดือน `YYYY-MM` และชื่อไฟล์ `YYYYMMDD_เลขพัสดุ_STATUS.webm`
- root cause: เดิม server ตั้งชื่อไฟล์เป็น `AWB-recordId.webm` และวางไว้ใต้ storage root ตรง ๆ ทำให้จัดเรียงตามเดือนไม่ได้ และชื่อไม่สื่อสถานะตรวจสอบ
- correct:
  - เพิ่ม helper กลาง `buildVideoFileLocation()` ใน `src/domain/videoFileNaming.mjs`
  - `/api/video/upload` หา record ที่ปิดกล่องแล้วก่อนตั้งชื่อไฟล์ เพื่อใช้ `record.status` เป็น `PASS/WARN`
  - เขียนไฟล์ไปที่ `<storageRoot>/YYYY-MM/YYYYMMDD_<AWB>_<STATUS>.webm`
  - sanitize AWB/status ก่อนใช้เป็นชื่อไฟล์
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/src/domain/videoFileNaming.mjs` ผ่าน
  - `npm test` ผ่าน 32/32
  - HTTP upload จริงสร้างไฟล์ได้ที่ `local-nas/videos/2026-06/20260623_NAME-1782220316448_PASS.webm`

## 2026-06-23 — Reports date filters วัน/เดือน/ปี

- what: ผู้ใช้ต้องการให้ Tab Reports / รายงานย้อนหลัง เลือกวันที่ เดือน ปี ได้
- root cause: filter เดิมเป็นช่วงวันที่ตายตัว (`วันนี้`, `7 วันล่าสุด`, `30 วันล่าสุด`) จึงเลือกวัน/เดือน/ปีเฉพาะเจาะจงไม่ได้
- correct:
  - เปลี่ยน `dateFilter` เดิมเป็น 3 controls: `reportDayFilter`, `reportMonthFilter`, `reportYearFilter`
  - วันเลือกได้ `01-31`, เดือนแสดงชื่อเดือนภาษาไทย, ปี populate จากปีที่มีใน records จริง
  - `filterRecords()` กรองตาม day/month/year ที่เลือก โดยเลือกบางช่องได้ เช่น เฉพาะเดือนหรือเฉพาะปี
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 32/32
  - Browser verify ที่ `http://localhost:4173/`: เลือก `23 / 6 / 2026` แล้วตาราง Reports เหลือ 2 รายการ และ summary เป็น `กรองแล้ว 2 / 27 รายการ`

## 2026-06-23 — Reports detail video playback จริง

- what: ผู้ใช้ต้องการให้พื้นที่ “คลิกเพื่อดูสตรีม (จำลอง)” ใน dialog รายละเอียด สามารถดูวิดีโอย้อนหลังได้จริง
- root cause: detail dialog ยังเป็น static mock block แม้ record มี `shareLink` จริงแล้ว และ endpoint stream ยังไม่รองรับ HTTP Range สำหรับการเล่น/กรอวิดีโอที่ดีใน browser
- correct:
  - เปลี่ยน `streamMock` เป็น `detailVideoPlayer`
  - `openRecordDetail()` render `<video controls preload="metadata" playsinline>` เมื่อ record มี `video` และ `shareLink`
  - record ที่ไม่มีวิดีโอแสดง fallback “ไม่มีวิดีโอ” พร้อมเหตุผล
  - เพิ่ม HTTP Range support ให้ `GET /api/video/stream/:recordId` ตอบ `206`, `Content-Range`, `Accept-Ranges: bytes`
  - เพิ่ม helper/test `parseHttpRange()`
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 36/36
  - HTTP Range จริงกับ `shareLink` ได้ status `206`, `Content-Range: bytes 0-3/17`, `Accept-Ranges: bytes`
  - Browser verify: dialog ของ record `PLAY-*` มี `<video controls>` ใช้ `src=http://localhost:4173/api/video/stream/...` และไม่มีข้อความ “จำลอง”

## 2026-06-23 — Reject invalid tiny video uploads

- what: ผู้ใช้เปิด detail record `PLAY-*` แล้ว player แสดง 0:00/จอดำ ดูย้อนหลังไม่ได้
- root cause: record `PLAY-*` ที่ใช้ verify ก่อนหน้าอัปโหลด byte จำลองขนาด 17 bytes ไม่ใช่ WebM ที่ encode จาก MediaRecorder จริง แต่ server เดิมรับเป็น upload สำเร็จเพราะตรวจแค่ว่ามี bytes และ content type เป็น `video/webm`
- correct:
  - เพิ่ม config กลาง `upload.minVideoSizeBytes`
  - `/api/video/upload` reject ไฟล์ที่เล็กกว่าค่านี้ด้วย `VIDEO_TOO_SMALL`
  - detail video player เพิ่ม hint และจับ `video.error` เพื่อบอกว่าไฟล์เสียหรือ browser ไม่รองรับ แทนจอดำเงียบ ๆ
  - restart server เพื่อล้าง in-memory record ทดสอบที่เป็นไฟล์เสีย
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 36/36
  - HTTP upload ไฟล์ 9 bytes ถูก reject: `VIDEO_TOO_SMALL`

## 2026-06-24 — Prevent opening app as file://

- what: ผู้ใช้เปิด `web/public/index.html` ด้วย `file://` แล้วหน้าแตกเป็น HTML ดิบ รูป/logo/css ไม่โหลด และ API ใช้งานไม่ได้
- root cause: `index.html` ใช้ absolute asset path เช่น `/assets/styles.css` และ app ต้องเรียก API บน server; การเปิดผ่าน `file://` ทำให้ path ชี้ผิดและไม่มี backend
- correct:
  - เพิ่ม inline guard ใน `<head>`: ถ้า `window.location.protocol === "file:"` ให้ redirect ไป `http://localhost:4173/`
  - start local dev server ใหม่ที่ port 4173
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 36/36
  - `lsof` พบ `node` listen ที่ `*:4173`
  - `curl -I http://localhost:4173/` ได้ `HTTP/1.1 200 OK`

## 2026-06-24 — Account control delete user guard

- what: ผู้ใช้ถามว่า User Account / Permission ครบหรือยัง และต้องการเพิ่ม role custom/role_name, `user_module_permissions`, `audit_logs`, ปุ่มลบผู้ใช้งาน, ลบได้เฉพาะ owner/admin, กันลบตัวเอง, กันลบ role owner, และบันทึก audit log
- current state:
  - `roleName`/custom role/module permissions/audit logs มีใน `authService` แล้ว แต่ runtime ปัจจุบันยังเป็น in-memory prototype ไม่ใช่ DB จริง
  - เพิ่ม production schema draft ที่ `deploy/schema.sql` สำหรับ `users.role_name`, `user_module_permissions`, `audit_logs`
- correct:
  - เพิ่ม role preset `owner`
  - เพิ่ม `authService.deleteUser()`
  - เพิ่ม endpoint `POST /api/users/delete`
  - เพิ่มปุ่ม `ลบ` ในหน้า Users
  - server guard:
    - actor ต้องมี `users:manage` และ role เป็น `owner` หรือ `admin`
    - ห้ามลบตัวเอง
    - ห้ามลบผู้ใช้ role `owner`
    - ลบสำเร็จแล้วล้าง session ของ target user
    - บันทึก `auditLogs` และ `activityLogs` ว่าใครลบใคร
  - UI disable ปุ่มลบสำหรับตัวเองและ role owner และ refresh list ทันทีหลังลบ
- Verification:
  - `node --check web/src/domain/authService.mjs` ผ่าน
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 38/38
  - HTTP verify: create/delete user แล้ว user หายจาก list, audit ล่าสุดเป็น `delete_user`
  - HTTP verify: ลบตัวเองได้ `DELETE_SELF_FORBIDDEN`; ลบ role owner ได้ `DELETE_OWNER_FORBIDDEN`
  - Browser verify: หน้า Users มีปุ่ม `ลบ`, admin ตัวเอง disabled, ลบ user ชั่วคราวแล้ว list เหลือ `4 users` และ audit log แสดง `delete_user`

## 2026-06-24 — Manual shipping label OCR import

- what: ผู้ใช้ต้องการให้แท็บ Connect / Import เพิ่มโหมด “นำเข้าออเดอร์แบบ Manual” โดยอัปโหลดแค่ไฟล์ใบปะหน้า Shopee/Lazada/TikTok แล้วระบบ OCR แยก platform, order number, AWB, customer, SKU, quantity, carrier เพื่อบันทึกเข้า ORDER_DB และนำไปสแกนแพคพร้อมวิดีโอได้
- root cause:
  - ระบบเดิมมี manual form สำหรับกรอก AWB เอง และ sync mock orders แต่ยังไม่มี flow รับไฟล์ใบปะหน้า/OCR/parser
  - เครื่อง local ตอนตรวจยังไม่มี Tesseract (`tesseract: command not found`) จึงไม่ควรแสดงผลหลอกว่า OCR สำเร็จ
- correct:
  - เพิ่ม config กลาง `ocr` ใน `web/config/app-config.example.json`: engine/command/languages/psm/max file size
  - เพิ่ม `shippingLabelParser.mjs` สำหรับ detect/parse Shopee, Lazada, TikTok จาก OCR text
  - เพิ่ม `ocrService.mjs` เรียก Tesseract ผ่าน server และตอบ `OCR_ENGINE_NOT_AVAILABLE` ชัดเจนถ้าเครื่องยังไม่ติดตั้ง
  - เพิ่ม endpoint `POST /api/orders/label/import`
    - guard ด้วย `integrations:manage`
    - รับไฟล์ใบปะหน้า raw upload
    - เก็บไฟล์ต้นฉบับใน `local-nas/labels/YYYY-MM`
    - OCR + parse + ให้ `importService.createOrderFromShippingLabel()` บันทึกเข้า ORDER_DB
  - เพิ่ม UI ใน Connect / Import: “นำเข้าออเดอร์แบบ Manual จากใบปะหน้า” พร้อม file input, status, preview fields
  - ข้อมูล SKU ที่ Shopee ไม่มีให้เป็นค่าว่าง/รอเติมจากไฟล์ออเดอร์ ไม่สร้างข้อมูลปลอม
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/src/domain/shippingLabelParser.mjs` ผ่าน
  - `node --check web/src/domain/ocrService.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 43/43 รวม parser tests สำหรับ Shopee/Lazada/TikTok และ importService label attachment
  - API verify กับไฟล์ `ใบปะหน้า - Shopee.png`: login ผ่าน, endpoint รับไฟล์/บันทึก `local-nas/labels/2026-06/...`, และตอบ `OCR_ENGINE_NOT_AVAILABLE` ตามจริงเพราะเครื่องยังไม่มี Tesseract
  - Browser verify ที่ `http://localhost:4173/`: หน้า Connect / Import มีฟอร์ม `#labelImportForm`, ปุ่ม “อ่านใบปะหน้าและนำเข้า”, file input required, status `OCR engine: tesseract · ภาษา tha+eng`

## 2026-06-24 — Install Tesseract OCR and Thai traineddata

- what: ผู้ใช้ส่งลิงก์ official Tesseract installation docs เพื่อเปิด OCR ใบปะหน้าให้ใช้งานจริง
- root cause:
  - เครื่องมี Homebrew แต่ยังไม่มี `tesseract`
  - เอกสาร official ระบุว่าต้องติดตั้งทั้ง OCR engine และ language traineddata
  - Homebrew package `tesseract` มีเฉพาะ `eng`, `osd`, `snum`; ระบบ SmartRecord ใช้ `tha+eng` จึงต้องเพิ่ม `tesseract-lang`
- correct:
  - ติดตั้ง `brew install tesseract`
  - ติดตั้ง `brew install tesseract-lang`
  - ตรวจ `tesseract --list-langs` ต้องมี `eng` และ `tha`
  - ใช้ `tesseract ... -l tha+eng --psm 6` กับไฟล์ใบปะหน้าจริง แล้วปรับ parser ให้ทน OCR noise:
    - `THO...` จาก OCR ต้อง normalize เป็น `TH0...`
    - Shopee receiver ที่ OCR อ่านเป็น `ผู้รับ (60)` ต้องจับชื่อลูกค้าได้
    - Shopee ที่ OCR เห็นแค่ `EXPRESS` ให้ตั้ง carrier เป็น `Flash Express`
- Verification:
  - `tesseract --version` ได้ `5.5.2`
  - `tesseract --list-langs` พบ `eng` และ `tha`
  - `npm test` ผ่าน 44/44
  - API verify กับ `ใบปะหน้า - Shopee.png` ผ่าน `200 OK` และ parse ได้:
    - platform `Shopee`
    - orderNumber `2606047GU07A12`
    - awb `TH01288T6C4J4A`
    - customerName `ธนงศักดิ์ บุญโสม ว 24`
    - sku ว่างตามข้อจำกัดใบปะหน้า Shopee
    - quantity `1`
    - carrier `Flash Express`
    - labelFile ถูกเก็บใน `local-nas/labels/2026-06/...`

## 2026-06-24 — Prepare UGREEN NAS DXP4800 Plus Docker deployment

- what: ผู้ใช้ต้องการนำโปรเจกต์ SmartRecord Pack Station ไปติดตั้งบนตัวกลาง UGREEN NAS DXP4800 Plus
- current state:
  - ระบบเหมาะกับการรันเป็น Docker container บน NAS: Node server + static web + Tesseract OCR
  - กล้อง/Barcode scanner/Printer ยังอยู่ที่เครื่อง Pack Station ฝั่ง Windows/macOS ที่เปิด browser
  - NAS ทำหน้าที่เป็น server + storage กลาง
- correct:
  - เพิ่ม `web/Dockerfile`
    - ใช้ Node 22 slim
    - ติดตั้ง `tesseract-ocr`, `tesseract-ocr-eng`, `tesseract-ocr-tha`
    - เพิ่ม healthcheck ไปที่ `/api/health`
  - เพิ่ม `web/.dockerignore`
  - เพิ่ม `deploy/docker-compose.ugreen.yml`
    - map port `4173:4173`
    - mount `deploy/smartrecord-data/local-nas` ไปที่ `/app/local-nas`
  - เพิ่มคู่มือ `deploy/UGREEN_NAS_DXP4800_PLUS.md`
  - เพิ่ม `npm run start`
  - เพิ่ม env runtime path:
    - `SMARTRECORD_CONFIG_PATH`
    - `SMARTRECORD_ORDERS_PATH`
    - `SMARTRECORD_SYNC_ORDERS_PATH`
  - เพิ่ม `GET /api/health`
- Verification:
  - `node --check server/index.mjs` ผ่าน
  - `npm test` ผ่าน 44/44
  - เครื่อง dev นี้ไม่มี Docker CLI (`docker: command not found`) จึงยังไม่ได้ build image local; ต้อง build บน UGREEN NAS/เครื่องที่มี Docker
- Remaining production gap:
  - Runtime data ยังเป็น in-memory prototype สำหรับ orders/users/records ระหว่าง container restart
  - ก่อนใช้งานจริงเต็มระบบควรต่อ database ถาวรสำหรับ `ORDER_DB`, `RECORDS`, users, audit logs

## 2026-06-24 — Multi-label PDF shipping label import

- what: ผู้ใช้ลองอัปโหลด PDF TikTok ที่มีใบปะหน้ามากกว่า 1 คำสั่งซื้อ แล้ว Tesseract ตอบ `Pdf reading is not supported`
- root cause:
  - Tesseract อ่าน PDF ตรง ๆ ไม่ได้ ต้องแปลงเป็น image ก่อน
  - ไฟล์ตัวอย่าง `ใบปะหน้า Tiktok แบบหลายใบ.pdf` มี metadata `Pages: 1` แต่ในหน้าเดียวมีใบปะหน้า 2 ใบวางซ้าย/ขวา จึงต้องรองรับหลาย labels ใน OCR text เดียว ไม่ใช่แค่หลาย PDF pages
  - SKU parser เดิมกว้างเกินไปและเคยจับวันที่ `13-06-2026` เป็น SKU
- correct:
  - ติดตั้ง Poppler (`pdftoppm`) บนเครื่อง dev
  - เพิ่ม `convertPdfToPngPages()` ใน `ocrService.mjs`
  - เพิ่ม config กลาง:
    - `ocr.pdfCommand`
    - `ocr.pdfDpi`
    - `ocr.maxPdfPages`
  - เพิ่ม `poppler-utils` ใน Dockerfile สำหรับ UGREEN NAS
  - endpoint `/api/orders/label/import`:
    - PDF -> PNG per page
    - OCR แต่ละ page
    - parse/import หลาย labels จาก OCR text เดียว
    - return `imported`, `skipped`, `errors`, `totalLabels`, `totalPages`
  - UI preview รองรับผล batch หลายรายการ
  - บีบ SKU regex ให้ SKU ต้องมีตัวอักษรก่อน hyphen เพื่อไม่จับวันที่เป็น SKU
- Verification:
  - `pdftoppm -v` ได้ Poppler 26.06.0
  - `pdfinfo` ไฟล์ตัวอย่างเห็น `Pages: 1`
  - `node --check server/index.mjs`, `ocrService.mjs`, `shippingLabelParser.mjs`, `public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 45/45
  - API verify กับ PDF TikTok หลายใบสำเร็จ:
    - importedCount `2`
    - totalPages `1`
    - label 1: AWB `798786566023`, Order `584505631971771834`, SKU `3CWG-4`
    - label 2: AWB `798892416184`, Order `584506147567208403`, SKU `3CWG-1`

## 2026-06-24 — Full system test pass and OCR regression fixes

- what: ผู้ใช้ให้ทดสอบทุกระบบที่มีและระบุจุดที่ควรทำเพิ่ม/ปรับปรุง
- root cause:
  - API smoke พบว่า `/api/orders/label/import` เมื่อ import ใบปะหน้าซ้ำทั้งหมดจะคืนผลสำเร็จแบบ `order=null` แต่ audit log ยังอ่าน `result.data.order.awb` ทำให้ server ตอบ `500`
  - ออเดอร์จาก OCR TikTok เก็บ platform เป็น `TikTok Shop` แต่ `packService` เดิมรับเฉพาะ `Tiktok` แบบ exact match ทำให้ API เปิด pack session จาก imported order ได้ไม่ครบกรณี
  - Multipart upload ไม่ใช่ protocol ที่ UI ใช้อยู่; UI ส่ง raw binary + `fileName` query จึงควรถือว่า multipart เป็น unsupported path และควรเพิ่ม error ที่ชัดเจนภายหลัง
- correct:
  - เปลี่ยน audit log ของ label import ให้รองรับ batch result:
    - นับ `imported/skipped/errors`
    - เลือก `targetId` จาก imported AWB ก่อน แล้ว fallback เป็น skipped AWB
    - ไม่อ้าง `data.order` เมื่อไม่มีออเดอร์ใหม่
  - เพิ่ม platform alias ใน `packService`:
    - `Shopee/shopee`
    - `Lazada/lazada`
    - `Tiktok/tiktok/TikTok Shop`
    - `custom/3pl/ทั่วไป`
  - เพิ่ม regression test `pack session normalizes imported TikTok platform labels`
- Verification:
  - `node --check server/index.mjs` ผ่าน
  - `node --check src/domain/packService.mjs` ผ่าน
  - `node --check tests/packService.test.mjs` ผ่าน
  - `npm test` ผ่าน 46/46
  - API smoke ผ่าน:
    - `GET /api/health` -> 200
    - login admin -> 200
    - `GET /api/config` -> 200
    - `GET /api/reports` -> 200, 26 records
    - `POST /api/orders/sync` -> 200, 8 orders
    - storage test local -> 200
    - invalid tiny video upload -> 400 `VIDEO_TOO_SMALL`
  - OCR API verify หลังแก้:
    - import PDF TikTok หลายใบครั้งแรก -> 200, importedCount `2`
    - import PDF เดิมซ้ำ -> 200, importedCount `0`, skippedCount `2`, ไม่เกิด 500
    - `POST /api/pack/start` กับ AWB OCR โดยไม่ส่ง platform -> 200, platform `Tiktok`
    - `POST /api/pack/start` กับ platform `tiktok` lowercase -> 200, platform `Tiktok`
  - Browser smoke:
    - login ผ่าน
    - Pack Station แสดงสถานะ device/employee
    - Reports มี stat bar และ filter วัน/เดือน/ปี
    - Connect / Import มี manual form + OCR import
    - Users มี custom role, module permission, delete button, audit/activity panels
    - console error ไม่มีใน tab หลัก
- Remaining production gaps:
  - Runtime data ยังเป็น in-memory prototype ต้องต่อ DB จริงก่อนใช้งานจริงต่อเนื่อง
  - Shopee/Lazada/TikTok/3PL connection ยังเป็น mock integration
  - Cloud Sync URL ยังเป็น metadata/external destination ไม่ใช่ Google Drive API upload จริง
  - Docker build ยังไม่ได้ verify บนเครื่องนี้เพราะไม่มี Docker CLI
  - ต้องทดสอบกล้อง/เครื่องพิมพ์/Barcode scanner บนเครื่อง Pack Station จริงแต่ละ OS
  - ควรเพิ่ม manual review/edit screen สำหรับ OCR confidence ต่ำหรือ field หาย

## 2026-06-24 — Shipping label OCR product name extraction

- what: ผู้ใช้ต้องการให้โหมด `Connect / Import > นำเข้าออเดอร์แบบ Manual จากใบปะหน้า` แยกข้อมูลครบ:
  - platform
  - เลขออเดอร์
  - เลขพัสดุ AWB
  - ชื่อลูกค้า
  - SKU
  - ชื่อสินค้า
  - จำนวนสินค้า
  - ขนส่ง
- root cause:
  - parser เดิมมี `sku` แต่ยังไม่มี data contract `productName`
  - `importService.createOrderFromShippingLabel()` เดิมใช้ชื่อ placeholder จาก SKU แทนชื่อสินค้าจริงจากใบปะหน้า
  - OCR จริงจาก Shopee ตัดชื่อสินค้าหลายบรรทัด และคำว่า “จำนวน” ถูกอ่านเป็น `จํานวน` ทำให้ regex เดิมไม่ match
  - OCR จริงจาก Lazada แยก SKU `3CWDO-C2G-03` เป็น `SCWDO-C2G-` + `03` ข้ามบรรทัด และอ่านเลข 3 เป็น S
- correct:
  - เพิ่ม field `productName` ใน `shippingLabelParser`
  - เพิ่ม parser ชื่อสินค้า:
    - Shopee: อ่านส่วนหลัง header `# ชื่อสินค้า / ตัวเลือกสินค้า / จำนวน`, รวมหลายบรรทัด, ตัดบรรทัด qty/summary/order noise
    - Lazada: อ่านชื่อสินค้าก่อน SKU ในตาราง OCR และรองรับ SKU fragmented `SCWDO-C2G-` + `03`
    - TikTok: อ่านชื่อสินค้าก่อน seller SKU และรองรับ batch PDF หลาย label
  - เพิ่ม normalization `SCW...` -> `3CW...` สำหรับ SKU OCR noise
  - `importService` ใช้ `parsed.productName` เป็น `order.items[0].name`
  - UI preview แสดง `ชื่อสินค้า` และ batch row แสดง SKU + ชื่อสินค้า
- Verification:
  - `node --check src/domain/shippingLabelParser.mjs` ผ่าน
  - `node --check src/domain/importService.mjs` ผ่าน
  - `node --check public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 46/46
  - API verify ด้วยไฟล์จริง:
    - Shopee PNG:
      - platform `Shopee`
      - orderNumber `2606047GU07A12`
      - AWB `TH01288T6C4J4A`
      - customerName `ธนงศักดิ์ บุญโสม ว 24`
      - SKU ว่างตามใบปะหน้า
      - productName `ตู้เหล็กมาตรฐาน ตู้ไซร์ ตู้คอนโทรล ตู้ไฟ ตู้ไฟสวิทช์บอร์ด (พร้อม กุญแจล็อคตู้) WLL MOUNTING CABINET`
      - quantity `1`
      - carrier `Flash Express`
    - Lazada PNG:
      - platform `Lazada`
      - orderNumber `1101259465611295`
      - AWB `LEXDO0185476846`
      - SKU `3CWDO-C2G-03`
      - productName อ่านได้จาก OCR table
      - quantity `1`
      - carrier `LEX`
    - TikTok multi-label PDF:
      - แยก 2 labels
      - label 1 SKU `3CWG-4`, productName `ตู้เหล็อุมาตรฐาน ตู้ไซร์ ตู้คอนโทรล`
      - label 2 SKU `3CWG-1`, productName `ดู้เหล็กมาตรฐาน ตู้ไซร์ ตู้คอนโทรล`
  - API `POST /api/pack/start` หลัง import แสดง `items[0].name` เป็นชื่อสินค้า OCR จริงสำหรับ Shopee/Lazada/TikTok
  - Remaining:
  - ชื่อลูกค้า TikTok จาก PDF หลายใบยังว่าง เพราะ OCR layout แบบ 2 label ในหน้าเดียวทำให้แยก receiver ต่อ label ยาก ควรเพิ่ม manual review/edit ก่อน import ในงานจริง
  - ชื่อสินค้า Lazada/TikTok ยังขึ้นกับคุณภาพ OCR จึงควรเก็บ raw text/preview เพื่อให้แก้ไขได้ก่อน save

## 2026-06-24 — Display SKU as product name plus SKU

- what: ผู้ใช้ระบุ `SKU = (Product Name ชื่อสินค้า + SKU)`
- root cause:
  - ถ้าเอา product name ไปทับค่า `sku` จริง จะทำให้ server-side scan validation ที่เทียบ `item.sku`/`barcode` พัง
  - ความต้องการเป็นเรื่องการอ่านข้อมูลใน UI มากกว่าการเปลี่ยน business key
- correct:
  - เพิ่ม helper UI `productSkuText(productName, sku)`
  - หน้า OCR preview แสดงแถว `SKU` เป็น `ชื่อสินค้า · SKU`
  - batch result แสดง `SKU ชื่อสินค้า · SKU`
  - หน้า Pack Station แสดง `SKU: ชื่อสินค้า · SKU · Barcode: ...`
  - ไม่เปลี่ยนค่า `item.sku` จริงใน server/domain model
- Verification:
  - `node --check public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 46/46

## 2026-06-24 — Connect/Import synced order card review form

- what: ผู้ใช้ต้องการดู/แก้ “แบบฟอร์มที่โชว์” ในหน้า `Connect / Import` หลังนำเข้าใบปะหน้า ว่าควรแสดงอะไร
- root cause:
  - card เดิมใน `Sync Orders` แสดงแค่ AWB, platform, buyer, จำนวนรายการ, status
  - หลัง OCR import แล้วข้อมูลสำคัญ เช่น เลขออเดอร์, ชื่อสินค้า+SKU, ขนส่ง ไม่ถูกส่งกลับมาใน `/api/orders/sync` และไม่ถูกโชว์ใน card
- correct:
  - `/api/orders/sync` enrich ข้อมูลจาก `ORDER_DB` เมื่อมีออเดอร์ที่นำเข้าแล้ว:
    - `platformLabel`
    - `orderNumber`
    - `buyer`
    - `sku`
    - `productName`
    - `barcode`
    - `carrier`
    - `itemLines`
  - ปรับ card ใน `renderSyncOrders()` ให้เป็นแบบฟอร์มอ่านตรวจ:
    - AWB + platform pill
    - เลขออเดอร์
    - ลูกค้า
    - SKU = `ชื่อสินค้า · SKU`
    - ขนส่ง
    - จำนวน
    - status
  - เพิ่ม CSS ให้ card รองรับข้อความยาวและไม่ล้น layout
- Verification:
  - `node --check src/domain/importService.mjs` ผ่าน
  - `node --check public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 46/46
  - API verify หลัง import ตัวอย่าง Shopee/Lazada/TikTok:
    - `/api/orders/sync` คืน field ครบสำหรับ AWB `TH01288T6C4J4A`, `LEXDO0185476846`, `798786566023`
  - Browser verify หน้า `Connect / Import`:
    - card แสดง `เลขออเดอร์`, `ลูกค้า`, `SKU`, `ขนส่ง`, `จำนวน`
    - ตัวอย่าง Shopee แสดง `SKU` เป็น `ชื่อสินค้า · SKU ว่าง`
    - ไม่มี console error

## 2026-06-24 — Swap Connect/Import panel order

- what: ผู้ใช้ต้องการย้ายส่วน `Manual จากใบปะหน้า + Sync Orders` ไปไว้ฝั่งซ้ายมือ และสลับ `API Credentials` ไปฝั่งขวา
- correct:
  - สลับ panel order ใน `connectGrid`
  - เปลี่ยนหัว panel ซ้ายเป็น `Manual Import / Sync Orders`
  - ปรับ grid column ให้ฝั่งซ้ายกว้างกว่า เพราะข้อมูล OCR/order card ยาวกว่า API credential form
- Verification:
  - `node --check public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 46/46
  - Browser verify:
    - panel 1 ซ้าย = `Manual Import / Sync Orders`
    - panel 2 ขวา = `API Credentials`
    - ไม่มี console error

## 2026-06-24 — Label Print tab uses Connect / Import labels

- what: ผู้ใช้ต้องการให้แท็บ `ปริ้นใบปะหน้า` ใช้ใบปะหน้าที่อัปโหลดจาก `Connect / Import > นำเข้าออเดอร์แบบ Manual จากใบปะหน้า`
- root cause:
  - V6 เพิ่มแท็บปริ้นใบปะหน้าเป็นฟอร์มอัปโหลดแยก ทำให้ flow ซ้ำซ้อนกับ Manual OCR Import
  - รูปใบปะหน้าที่อยู่หลัง API protected route ไม่ควรถูกฝังเป็น `<img src="/api/...">` ตรง ๆ เพราะ browser image request ไม่ส่ง Bearer token
- correct:
  - ถอด upload form ออกจากแท็บ `ปริ้นใบปะหน้า`
  - เพิ่ม source card ชี้ให้ไปอัปโหลดที่ `Connect / Import`
  - เมื่อ `POST /api/orders/label/import` สำเร็จหรือถูกข้ามเพราะ duplicate ให้ server ลงทะเบียน label ด้วย `labelService.registerImportedLabel()`
  - `GET /api/labels` คืนรายการจาก Connect / Import พร้อม `imageDataUrl` สำหรับ preview/print ใน browser
  - คง `/api/labels/file/:id` ไว้สำหรับเปิดไฟล์ต้นฉบับแบบ server-authorized ต่อได้
- Verification:
  - `node --check web/src/domain/labelService.mjs` ผ่าน
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 56/56
  - API verify:
    - login `admin@example.local`
    - import ตัวอย่าง Shopee ผ่าน `/api/orders/label/import`
    - `/api/labels` คืน `source: connect-import`, AWB `TH01288T6C4J4A`, order `2606047GU07A12`, `imageDataUrl: data:image/png;base64,...`
  - Browser verify:
    - แท็บ `ปริ้นใบปะหน้า` ไม่มี `#labelForm`
    - แสดง `1 ใบปะหน้า`
    - แถวแรกแสดง `TH01288T6C4J4A · Shopee`
    - ปุ่ม `Print ใบปะหน้า` ไม่ disabled
    - ไม่มี console error

## 2026-06-24 — Require shipping label before pack session

- what: ผู้ใช้ต้องการให้มีใบปะหน้าและภาพตัวอย่างการจัดวางก่อนแพค ก่อนเข้าสู่กระบวนการสแกน AWB เพื่อเริ่มบันทึกวิดีโอ
- root cause:
  - `Pack Station` เดิมเปิด session ได้ทันทีถ้า AWB อยู่ใน `ORDER_DB` แม้ order นั้นยังไม่มี `labelFile`
  - ทำให้ flow งานจริงข้ามขั้น `Connect / Import -> OCR/นำเข้าใบปะหน้า -> Print/เตรียมใบปะหน้า` ได้
- correct:
  - เพิ่ม config กลาง `packFlow.requireLabelBeforePack: true`
  - `packService.startPackSession()` ตรวจ `orders[awb].labelFile` ฝั่ง server ก่อนเปิด session
  - ถ้าไม่มีใบปะหน้า return `LABEL_REQUIRED_BEFORE_PACK` และไม่เปิดกล้อง/ไม่เริ่ม pack panel
  - เพิ่ม `labelFile` metadata ใน public session เมื่อเริ่มแพคสำเร็จ
  - เพิ่มการ์ดตัวอย่างก่อนแพคบนหน้า Scan AWB พร้อมภาพ `/assets/prepack-label-required.png` และ checklist:
    - มีใบปะหน้าจาก Connect / Import
    - วางใบปะหน้าให้อยู่ในเฟรมกล้อง
    - กล่องและสินค้าพร้อมตรวจในวิดีโอ
    - สแกน AWB เพื่อให้ server เปิด session
  - demo orders ใน `mock-orders.json` ถูกเติม `labelFile` mock เพื่อให้ demo ยังทดสอบ flow ได้
- Verification:
  - `node --check web/src/domain/packService.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - JSON config/mock orders parse ผ่าน
  - `npm test` ผ่าน 57/57
  - API verify:
    - `SPX-TH-88213940` เริ่ม pack ได้และคืน `labelFile: demo-shopee-label.png`
    - manual order `NO-LABEL-API-1` ที่ไม่มี labelFile ถูกปฏิเสธด้วย `LABEL_REQUIRED_BEFORE_PACK`
  - Browser verify:
    - หน้า Scan AWB แสดงหัวข้อ `เตรียมใบปะหน้า ก่อนสแกน AWB`
    - แสดงภาพ `/assets/prepack-label-required.png`
    - AWB ไม่มีใบปะหน้าไม่เปิด pack panel และ toast แจ้ง `ต้องมีใบปะหน้าจาก Connect / Import ก่อน จึงจะเริ่มสแกน AWB เพื่อแพคได้`
    - ไม่มี console error

## 2026-06-24 — Compact pre-pack guide UI

- what: ผู้ใช้แจ้งว่าหน้า pre-pack guide ก่อนสแกน AWB ดูไม่ดี เพราะภาพตัวอย่างใหญ่เกินและกินพื้นที่การทำงาน
- root cause:
  - ภาพตัวอย่างถูกวางเป็น hero/banner ขนาดใหญ่ ทำให้หน้าสแกน AWB ดูเหมือนหน้า presentation มากกว่า station UI
  - H1 ยาวและใหญ่เกินบริบทงานปฏิบัติการ
- correct:
  - เปลี่ยนหัวข้อเป็น `เริ่มแพคออเดอร์`
  - วางฟอร์มสแกน AWB เป็นพื้นที่หลักซ้าย
  - ย้ายภาพตัวอย่างเป็น thumbnail ใน panel ขวา ขนาดรูปประมาณ 158px สูง
  - ลด checklist เหลือ 3 ข้อที่จำเป็นต่อการปฏิบัติงาน
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 57/57
  - Browser verify:
    - form กว้าง 560px
    - guide กว้าง 360px
    - รูปตัวอย่างสูง 158px
    - H1 เป็น `เริ่มแพคออเดอร์`
    - ไม่มี console error

## 2026-06-24 — Login page uses PSH banner artwork

- what: ผู้ใช้ให้ไฟล์ `Banner  PSH.png` เพื่อใช้กับหน้า login
- root cause:
  - หน้า login แบบก่อนหน้ามีข้อความ/feature ซ้ำกับ artwork และใช้ภาพแยกที่ไม่ตรงกับ banner ล่าสุด
  - โครงเดิมเหลือ `.loginVisual` ทำให้ layout สูงผิดปกติหลังเปลี่ยน background
- correct:
  - เพิ่ม asset `/assets/login-banner-psh.png`
  - ใช้ banner เป็น background หลักของ `.loginShell`
  - ถอด intro text/feature grid ที่ซ้ำกับ banner ออกจาก HTML
  - ถอด `.loginVisual` เก่าออก เหลือฟอร์ม login เดียวบน banner
  - คง error/loading/password toggle/login form เดิมครบ
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 57/57
  - Browser verify:
    - `.loginShell` ใช้ background `login-banner-psh`
    - `.loginVisual` ไม่มีแล้ว
    - `#loginForm` ยังอยู่
    - ไม่มี console error

## 2026-06-24 — Login page split hero layout

- what: ผู้ใช้ส่งตัวอย่างหน้า login แบบ split layout: ซ้ายเป็น branding/feature, ขวาเป็น login card
- root cause:
  - แบบก่อนหน้าใช้ banner เป็น background หลัก ทำให้ตัวหนังสือใน artwork จาง/ซ้อนกับฟอร์ม และยังไม่เหมือนตัวอย่างที่แยก hero กับ form ชัดเจน
- correct:
  - ปรับ HTML เป็น `.loginShowcase` ฝั่งซ้าย และ `.loginFormPane` ฝั่งขวา
  - ฝั่งซ้ายมี product mark, headline, supporting copy, feature cards, trust bar
  - ฝั่งขวาคง `#loginForm` เดิมพร้อม error/loading/password toggle
  - CSS ใช้ two-column layout จนถึงจอเล็กจริง แล้วค่อย stack ที่ breakpoint 880px
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 57/57
  - Browser verify:
    - `.loginShowcase` และ `.loginFormPane` แสดงครบ
    - มี feature cards 4 ใบ
    - login card อยู่ฝั่งขวาใน viewport ปัจจุบัน
    - ไม่มี console error

## 2026-06-24 — Login page uses HYD FURNITURE banner only

- what: ผู้ใช้ให้ลบพื้นหลัง/hero เดิมทั้งหมด แล้วใช้ไฟล์ banner ของ HYD FURNITURE เป็นภาพหน้า login แทน
- root cause:
  - layout split hero เดิมสร้างข้อความและ feature cards ซ้ำกับ artwork ใหม่
  - การใช้ background แบบ `cover` ครอปพื้นที่ขาวด้านขวาของ banner บน viewport สูง/แคบ ทำให้ฟอร์ม login ไปทับข้อความในภาพ
- correct:
  - เพิ่ม asset `/assets/login-banner-hyd.png`
  - ถอด `.loginShowcase` และ CSS hero/feature/trust bar เดิมออกทั้งหมด
  - ให้ `.loginShell` ใช้ภาพใหม่เป็น background หลักเพียงภาพเดียว
  - ใช้ `background-size: 100% auto` เพื่อรักษาภาพเต็มความกว้างและให้ฟอร์มอยู่บนพื้นที่ขาวด้านขวา
  - คง `#loginForm`, error state, loading state และ password toggle เดิมครบ
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` จากโฟลเดอร์ `web` ผ่าน 57/57
  - Browser verify:
    - `.loginShowcase` ไม่มีแล้ว
    - `.loginShell` ใช้ background `login-banner-hyd.png`
    - `#loginForm` ยังอยู่และแสดงบนพื้นที่ขวาของ banner
    - ไม่มี console error

## 2026-06-24 — System Admin can replace pre-pack guide image

- what: ผู้ใช้ต้องการให้รูปตัวอย่าง “ก่อนเริ่มวิดีโอ” เปลี่ยนได้จากระบบ โดย role System Admin และรูปต้องเป็นสัดส่วน 1:1
- root cause:
  - รูปเดิมเป็น asset ตายตัว `/assets/prepack-label-required.png` ใน HTML ทำให้ต้องแก้โค้ดทุกครั้งเมื่ออยากเปลี่ยนรูปคู่มือ
  - ถ้าให้ client ตัดสินสัดส่วนเองจะไม่ปลอดภัย เพราะ role/validation ต้องอยู่ที่ server
- correct:
  - เพิ่ม config กลาง `systemAssets.prePackGuideImage` สำหรับ default URL, accepted MIME types, max size, required ratio `1:1`, tolerance
  - เพิ่ม domain module `imageValidation.mjs` สำหรับอ่านขนาด PNG/JPEG/WebP และ validate 1:1
  - เพิ่ม endpoint `POST /api/settings/prepack-image` ให้เฉพาะ `owner/admin` ที่มี `settings:manage` เปลี่ยนรูปได้
  - บันทึกไฟล์ใหม่เป็น `/public/assets/prepack-guide-custom.*` และบันทึก metadata ใน `web/data/app-settings.json`
  - เพิ่ม UI ใน Device Settings เฉพาะ System Admin: preview รูป, input รับ PNG/JPG/WebP, ปุ่ม `เปลี่ยนรูป`
  - หน้า Pack Station อ่านรูปจาก public config แทน hardcode asset ตายตัว
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 61/61
  - API verify:
    - `/api/config` ส่ง `systemAssets.prePackGuideImage.url`
    - admin upload รูป 640x360 ถูก reject ด้วย `IMAGE_RATIO_NOT_1_1`
    - packer upload รูป 1:1 ถูก reject ด้วย `FORBIDDEN`
  - Browser verify:
    - login ด้วย Admin แล้ว Device Settings แสดง section `รูปตัวอย่างก่อนเริ่มวิดีโอ`
    - input รับ `image/png,image/jpeg,image/webp`
    - ปุ่ม `เปลี่ยนรูป` enabled สำหรับ Admin
    - รูปหน้า Pack Station และ preview ใช้ URL จาก config
    - ไม่มี console error

## 2026-06-25 — Pre-pack guide image no longer requires 1:1 ratio

- what: ผู้ใช้แจ้งว่าไม่ต้องบังคับสัดส่วนของภาพสำหรับรูปตัวอย่างก่อนเริ่มวิดีโอ
- root cause:
  - กฎก่อนหน้าบังคับ `1:1` ทั้งใน config, server validation, client preview และข้อความ UI
  - preview ใช้ `object-fit: cover` ทำให้รูปสัดส่วนอื่นถูกครอปและดูเหมือนยังบังคับกรอบ 1:1
- correct:
  - เอา `requiredAspectRatio` และ `aspectRatioTolerance` ออกจาก config กลาง
  - เปลี่ยน `validateSquareImage` เป็น `validateImageFile` เพื่ออ่าน metadata รูปโดยไม่ reject ภาพ non-square
  - server ยังคงตรวจ MIME type, max size และอ่านขนาดรูปได้ แต่ไม่ตรวจ ratio
  - client preview ไม่ reject ภาพ non-square และเปลี่ยนข้อความเป็น `ไม่บังคับสัดส่วนภาพ`
  - CSS ของรูป preview และ guide ใช้ `object-fit: contain` เพื่อไม่ครอปรูปสัดส่วนอื่น
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `node --check web/src/domain/imageValidation.mjs` ผ่าน
  - `npm test` ผ่าน 61/61
  - API verify: `/api/config` ไม่ส่ง `requiredAspectRatio`
  - Browser verify:
    - Device Settings แสดงข้อความ `ไม่บังคับสัดส่วนภาพ`
    - ปุ่ม `เปลี่ยนรูป` ยัง enabled สำหรับ Admin
    - preview และรูป guide ใช้ `object-fit: contain`
    - ไม่มี console error

## 2026-06-25 — Removed manual Platform selector from Scan AWB form

- what: ผู้ใช้ขอให้ลบ `Platform` label และ dropdown `Shopee / Lazada / Tiktok / custom` ออกจากฟอร์มเริ่มแพค
- root cause:
  - ช่องเลือกแพลตฟอร์มในหน้า Scan AWB ซ้ำซ้อนกับข้อมูลจากออเดอร์ที่นำเข้ามาแล้ว
  - server `POST /api/pack/start` สามารถใช้ `order.platform` เป็นค่าเริ่มต้นได้อยู่แล้ว จึงไม่จำเป็นต้องให้ผู้ใช้เลือกซ้ำ
- correct:
  - ลบ field platform ออกจาก `startForm`
  - ปุ่ม demo เริ่มแพคส่งแค่ AWB เพื่อให้ server เดา platform จากออเดอร์
  - หน้า start flow ใช้ AWB อย่างเดียว ลดโอกาสเลือก platform ผิดตอนเริ่ม session
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 61/61
  - ตรวจ source แล้วไม่มี reference ของ `platformSelect` / `data-demo-platform` ใน start form อีก

## 2026-06-25 — Pack item list and close dialog now anchor to AWB

- what: ผู้ใช้ต้องการให้รายการสินค้าใน pack session อ้างอิงกับ AWB และให้ยิง AWB ซ้ำเพื่อปิดกล่องได้ชัดเจน
- root cause:
  - แถวสินค้าใน pack panel เอา `item.name` ไปแสดงร่วมกับ `item.sku` ซ้ำ ทำให้ข้อความยาวและไม่สื่อความหมายว่าเป็นรายการของ AWB ไหน
  - dialog ปิดกล่องใช้ข้อความกลางเกินไป ทำให้ไม่ชัดว่าการยิง AWB ซ้ำคือ flow ที่ตั้งใจไว้
- correct:
  - แสดง metadata รายการสินค้าเป็น `AWB · SKU · Barcode` แทนการต่อชื่อสินค้าเดิมกับ SKU ซ้ำ
  - ปรับข้อความยืนยันปิดกล่องให้ระบุ AWB ปัจจุบันและบอกชัดว่ากด AWB ซ้ำเพื่อยืนยันปิดกล่องได้
  - เปลี่ยนหัว dialog เป็น `ยืนยันปิดกล่องด้วย AWB ซ้ำ`
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน 61/61
  - grep ยืนยันว่า item list และ force-close dialog ใช้ข้อความ AWB ใหม่แล้ว

## 2026-06-25 — Imported manual label orders can now be edited and deleted

- what: ผู้ใช้ต้องการให้รายการออเดอร์ที่นำเข้าแบบ Manual จากใบปะหน้า สามารถ `แก้ไข` และ `ลบ` ได้หลังนำเข้าแล้ว
- root cause:
  - แถวรายการในหน้า Connect / Import แสดงสถานะ `นำเข้าแล้ว` อย่างเดียว ทำให้แก้ข้อมูล OCR ผิดหรือเคลียร์รายการที่นำเข้าผิดไม่ได้
  - server ยังไม่มี endpoint กลางสำหรับ update/delete imported order จึงไม่มี audit log และไม่มีจุดตัดสินกฎเดียว
  - UI เดิมใช้แถวเป็นปุ่มทั้งแถว ถ้าฝังปุ่ม `แก้ไข/ลบ` ซ้อนเข้าไปจะเกิด nested interactive controls และพฤติกรรม browser เพี้ยนได้
- correct:
  - เพิ่ม endpoint `POST /api/orders/update` และ `POST /api/orders/delete` ให้ server เป็นผู้ตัดสินการแก้ไข/ลบ และบันทึก activity log
  - เพิ่ม dialog `แก้ไขออเดอร์ที่นำเข้าแล้ว` สำหรับแก้ platform, order number, buyer, SKU, barcode, product name, qty, carrier
  - เพิ่มปุ่ม `แก้ไข` และ `ลบ` ในรายการที่นำเข้าแล้ว และลบออกจาก list ทันทีเมื่อ server ลบสำเร็จ
  - เปลี่ยน markup ของ sync row ที่นำเข้าแล้วจากปุ่มทั้งแถวเป็น `article` เพื่อเลี่ยงปุ่มซ้อนปุ่ม
  - เพิ่ม regression tests สำหรับ update/delete imported manual label orders
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/src/domain/importService.mjs` ผ่าน
  - `npm test` ผ่าน

## 2026-06-25 — AWB scan must count as item scan before becoming close-box confirmation

- what: ผู้ใช้ต้องการให้กรณีออเดอร์ใช้ AWB เดียวกันเป็น barcode ของสินค้า สามารถสแกน AWB เพื่อเดินแพคต่อได้ก่อน และค่อยสแกน AWB ซ้ำเพื่อยืนยันปิดกล่อง
- root cause:
  - logic เดิมใน `packService.scanCode()` เช็ก `cleanCode === session.awb` ก่อนเช็ก match กับ item ทำให้ AWB ถูกตีความเป็นคำสั่งปิดกล่องทันที
  - สำหรับออเดอร์ OCR/manual บางรายการ barcode ของสินค้าตั้งค่าเป็น AWB เอง จึงเกิด false close request ทั้งที่ยังต้องนับสินค้า
- correct:
  - เปลี่ยนลำดับการตัดสินใน `scanCode()` ให้หา item ที่ match barcode/SKU ก่อน
  - ถ้า code เป็น AWB และยังมี item เดิมที่ใช้ AWB นี้สแกนไม่ครบ ให้ถือเป็น item scan
  - ใช้ AWB เป็น close-box confirmation เฉพาะเมื่อ item ที่อ้างอิง AWB นั้นครบแล้ว หรือไม่มี item ที่เปิดค้างอยู่
  - เพิ่ม regression test สำหรับ flow `scan AWB = item` ครั้งแรก และ `scan AWB ซ้ำ = closeRequested` ครั้งถัดไป
- Verification:
  - `node --check web/src/domain/packService.mjs` ผ่าน
  - `npm test` ผ่าน 64/64

## 2026-06-25 — Stabilization: API client and startup must fail gracefully

- what: ผู้ใช้สั่งหยุดเพิ่มฟีเจอร์ และให้แก้เสถียรภาพก่อน โดยเฉพาะอาการที่หน้าเว็บเพี้ยนเมื่อ server/runtime ไม่พร้อม
- root cause:
  - helper `api()` และ `apiFile()` สมมติว่า `fetch()` สำเร็จเสมอและ response เป็น JSON เสมอ ทำให้ถ้า server หลุดหรือตอบไม่ครบ อาจเกิด error เงียบหรือ UI ค้าง
  - `boot()` โหลด `/api/config` แล้วใช้ `result.data` ทันที ถ้า config โหลดไม่สำเร็จ หน้า app จะล้มตั้งแต่ต้น
  - server ไม่มี error listener ตอน bind/startup ทำให้ตามรอยปัญหา runtime ยาก
- correct:
  - เพิ่ม graceful handling ใน `api()` / `apiFile()` สำหรับ `NETWORK_ERROR` และ `INVALID_RESPONSE`
  - เพิ่ม `showStartupError()` และ guard ใน `boot()` ถ้าโหลด config ไม่สำเร็จ
  - เพิ่ม `server.on("error", ...)` เพื่อ log startup/runtime bind errors ให้ชัด
- Verification:
  - `node --check web/public/assets/app.js` ผ่าน
  - `node --check web/server/index.mjs` ผ่าน
  - `npm test` ผ่าน 64/64

## 2026-06-25 — Stability backlog #1: server runtime / restart behavior

- what: ผู้ใช้ต้องการให้ dev server ของ SmartRecord Pack Station รันเสถียร, restart ชัดเจน, route/API ตอบกลับสม่ำเสมอ และตรวจ health ได้จริงหลัง restart
- root cause:
  - startup log เดิมบอกแค่ URL เดียว ทำให้แยกไม่ออกว่า mode/host/port/routing พร้อมจริงหรือยัง
  - เมื่อ port ถูกใช้งานอยู่ server ตอบ error ไม่ชัดและไม่มี script ช่วย reset process เก่า
  - contract ของ API error ยังไม่สม่ำเสมอ บาง route ใช้ `code`, บาง route ไม่มี `error`, และ auth fail ไม่ได้ส่งข้อความมาตรฐานเดียวกัน
  - loading state ฝั่ง client หลายจุด reset หลัง `await` ตรง ๆ ไม่ได้อยู่ใน `finally` จึงเสี่ยงค้างถ้ามี exception แทรก
  - regression test ที่ต้องเปิด socket ฟัง port ใช้งานไม่ได้ใน sandbox ปกติ ต้อง verify แบบยกระดับสิทธิ์ด้วย
- correct:
  - เพิ่ม startup log ชัดเจนใน `web/server/index.mjs`: service, mode, host, port, route สำคัญ, health URL
  - เพิ่ม startup failure log สำหรับกรณีโหลด runtime data ไม่สำเร็จ และกรณี `EADDRINUSE`
  - เพิ่ม JSON contract กลางสำหรับ API error: `code`, `error`, `message`, และ map HTTP status ให้เหมาะสม (`401/403/404/409/413/500`)
  - เปลี่ยน `/api/health` ให้ตอบ top-level JSON ที่อ่านและตรวจได้ง่าย
  - เพิ่ม script `server`, `check`, `server:check`, `dev:reset`
  - เพิ่ม regression test แบบ spawn server จริงสำหรับ `/api/health`, JSON 404, auth-required JSON, และ port conflict
  - ย้าย loading reset ฝั่ง client ที่เกี่ยวกับ network/server เข้า `finally`
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm run check` ผ่าน
  - `npm test` ผ่าน 68/68 เมื่อรันนอก sandbox จำกัด socket
  - `GET /api/health` ตอบ `200` พร้อม JSON service/port/time

## 2026-06-25 — Clean source / runtime separation

- what: ผู้ใช้ต้องการแยก source project ออกจาก runtime files เพื่อไม่ให้ `web/local-nas`, `local-nas`, วิดีโอ, ใบปะหน้า, logs และ cache ติดไปใน source zip
- root cause:
  - runtime folders ถูกสร้างและสะสมภายใต้ source tree เดิม เช่น `web/local-nas`
  - repository ยังไม่มี `.gitignore` ชั้น project ที่กันไฟล์ runtime ออกอย่างชัดเจน
  - `.dockerignore` เดิมยังไม่ครอบชนิดไฟล์ runtime ทั้งหมด
- correct:
  - เพิ่ม `.gitignore` ที่ root ของ project และ `web/.gitignore` เพื่อกัน runtime files, logs, cache, build artifacts, และ environment files
  - อัปเดต `web/.dockerignore` ให้กัน runtime artifacts เดียวกันก่อน build image
  - ให้ server สร้าง runtime folders ที่จำเป็นตอน startup เองแทนการพึ่งโฟลเดอร์ที่อาจติดอยู่ใน zip
  - บันทึกไว้ชัดเจนว่า source zip ต้องไม่มี runtime files
- Verification:
  - `node --check web/server/index.mjs` ผ่าน
  - `node --check web/public/assets/app.js` ผ่าน
  - `npm test` ผ่าน

## 2026-07-01 — Import service hardening: no fake SKU/item fallback outside demo mode

- what: ผู้ใช้ต้องการหยุดการสร้าง `SKU-GEN` และสินค้า fake ระหว่างนำเข้าใบปะหน้า/ออเดอร์ โดยถ้าขาด `SKU`, `productName`, หรือ `qty` ต้อง reject ทันที และยอม fallback ได้เฉพาะ demo mode
- root cause:
  - `importService` เดิมมี `ITEM_TEMPLATES` แบบ `SKU-GEN-*` และใช้ fallback name/qty อัตโนมัติ แม้ข้อมูลจากใบปะหน้าจะไม่ครบ
  - `shippingLabelParser` เดิม normalize จำนวนที่หาไม่เจอเป็น `1` ทำให้ import layer แยกไม่ออกว่า OCR อ่าน `qty` ไม่ได้จริง
  - server สร้าง `importService` แบบไม่ประกาศโหมด demo ชัดเจน ทำให้พฤติกรรม mock/demo กับพฤติกรรมใช้งานจริงปนกัน
- correct:
  - ลบ `SKU-GEN-*` และการสร้างชื่อสินค้า fake ออกจาก `web/src/domain/importService.mjs`
  - เพิ่ม `demoMode` แบบ explicit ใน `createImportService()` และให้ server เปิดเฉพาะตอน `mode !== "production"`
  - ถ้าไม่มี `SKU`, `productName`, หรือ `qty` ให้ reject ด้วย validation error (`SKU_REQUIRED`, `PRODUCT_NAME_REQUIRED`, `QTY_REQUIRED`, `ITEM_DETAILS_REQUIRED`)
  - คง fallback item generation ไว้เฉพาะ demo mode เพื่อไม่ให้ flow demo ที่ใช้ count-only แตก
  - ปรับ `shippingLabelParser` ให้ `quantity` ที่อ่านไม่เจอเป็น `0` แทนการเดาเป็น `1`
  - ลบ `.DS_Store` ออกจาก `web/public/assets` และเช็ก asset/README/docs ว่าไม่มี reference branding PORSANG เหลือในข้อความแสดงผลแล้ว
- Verification:
  - ต้องรัน `node --check web/server/index.mjs`
  - ต้องรัน `node --check web/public/assets/app.js`
  - ต้องรัน `npm test`
