# Install SmartRecord On UGREEN NAS DXP4800 Plus

คู่มือนี้สำหรับติดตั้ง SmartRecord Pack Station เป็นตัวกลางบน UGREEN NAS DXP4800 Plus ผ่าน Docker / Container Manager

## Architecture

```text
Pack Station browser (Windows/macOS)
  -> http://NAS-IP:4173
  -> SmartRecord Node server in Docker
  -> /app/local-nas mounted to NAS shared folder
  -> videos, shipping labels, cloud-sync fallback
```

## What Works In This Docker Package

- Web app + Node backend
- OCR ด้วย Tesseract
- ภาษา OCR: `tha+eng`
- Storage folder สำหรับวิดีโอและใบปะหน้า
- Health check: `GET /api/health`

## Important Limits

- เวอร์ชันนี้ยังเป็น MVP แบบ in-memory สำหรับ orders/users/records ระหว่าง container runtime
- ไฟล์วิดีโอและใบปะหน้าถูก persist ผ่าน volume `./smartrecord-data/local-nas`
- Production จริงควรต่อ database ถาวรสำหรับ `ORDER_DB`, `RECORDS`, users, audit logs
- Webcam/Barcode/Printer อยู่ฝั่งเครื่อง Pack Station ที่เปิด browser ไม่ได้อยู่บน NAS

## NAS Preparation

1. เปิด Docker / Container Manager บน UGOS Pro
2. สร้าง shared folder เช่น `SmartRecord`
3. วางโปรเจกต์นี้ลงใน shared folder
4. เปิด Terminal/SSH หรือใช้ UI ของ Container Manager เพื่อรัน compose

## Deploy With Docker Compose

จากโฟลเดอร์ `deploy`:

```bash
docker compose -f docker-compose.ugreen.yml up -d --build
```

เปิดเว็บ:

```text
http://NAS-IP:4173
```

ตรวจ health:

```bash
curl http://NAS-IP:4173/api/health
```

ควรได้:

```json
{"ok":true}
```

## Verify OCR In Container

```bash
docker exec -it smartrecord-pack-station tesseract --list-langs
```

ต้องเห็น:

```text
eng
tha
```

## Persistent Files

Container path:

```text
/app/local-nas
```

NAS host path จาก compose:

```text
deploy/smartrecord-data/local-nas
```

ภายในจะมี:

```text
videos/
labels/
cloud-sync/
```

## Recommended Network Setup

- ให้ NAS มี static IP เช่น `192.168.1.40`
- ให้เครื่อง Pack Station เปิดเว็บผ่าน `http://192.168.1.40:4173`
- กล้อง/เครื่องพิมพ์/Barcode scanner ต่ออยู่กับ Windows/macOS Pack Station
- NAS ทำหน้าที่เป็น server + storage กลาง

## Rollback

หยุด container:

```bash
docker compose -f docker-compose.ugreen.yml down
```

ไฟล์วิดีโอและใบปะหน้ายังอยู่ใน:

```text
deploy/smartrecord-data/local-nas
```
