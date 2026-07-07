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

- ให้ NAS มี static IP เช่น `YOUR_NAS_IP`
- ให้เครื่อง Pack Station เปิดเว็บผ่าน `http://YOUR_NAS_IP:4173`
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

---

## Stage 2A Production Runtime Checklist

ก่อน Deploy จริงบน UGREEN NAS ให้เตรียม runtime data ตามโครงสร้างนี้ในโฟลเดอร์ deploy/smartrecord-data

โครงสร้างที่ต้องมี:

deploy/
  docker-compose.ugreen.yml
  smartrecord-data/
    config/
      app-config.json
    data/
      orders.json
      sync-orders.json
    local-nas/
      videos/
      labels/
      cloud-sync/

ไฟล์ที่ต้องมีบน NAS:

- smartrecord-data/config/app-config.json
  - config จริงสำหรับ production
  - ห้าม commit ขึ้น GitHub

- smartrecord-data/data/orders.json
  - runtime orders
  - ใช้กับ SMARTRECORD_ORDERS_PATH

- smartrecord-data/data/sync-orders.json
  - runtime sync/import orders
  - ใช้กับ SMARTRECORD_SYNC_ORDERS_PATH

- smartrecord-data/local-nas/videos/
  - เก็บวิดีโอแพคสินค้า

- smartrecord-data/local-nas/labels/
  - เก็บไฟล์ใบปะหน้า/OCR

ตรวจ health หลังเปิด container:

เปิด URL นี้ใน Browser:

http://YOUR_NAS_IP:4173/api/health

ถ้าปกติควรได้ JSON ที่มีค่า:

ok: true
service: smartrecord-pack-station
mode: production

ข้อควรระวัง:

- ห้ามใช้ app-config.example.json เป็นไฟล์จริงบน production
- ห้าม commit app-config.json, orders.json, sync-orders.json ที่มีข้อมูลจริง
- docker-compose.ugreen.yml กำหนด NODE_ENV=production, platform=linux/amd64, resource limit และ healthcheck แล้ว
- ถ้าเปลี่ยน port ต้องแก้ทั้ง compose และ URL ที่ใช้เปิดเว็บ

