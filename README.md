# ChatApp v3.0 — Production-Ready Real-time Chat

Stack lengkap sesuai referensi: **Node.js + Express + Socket.IO + RabbitMQ + Redis + SQLite + JWT**

---

## 🚀 Cara Menjalankan

### Prasyarat
- Node.js v18+
- RabbitMQ (port 5672)
- Redis (port 6379)

### Setup Cepat
```bash
# 1. Install dependencies
npm install

# 2. Konfigurasi (opsional — default sudah bisa jalan)
cp .env.example .env
nano .env

# 3. Jalankan
npm start

# 4. Development (auto-restart)
npm run dev
```

### Jalankan RabbitMQ + Redis (jika belum ada)
```bash
# Docker (paling mudah)
docker run -d --name redis    -p 6379:6379 redis:alpine
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:management

# Atau install langsung (Ubuntu/Debian)
sudo apt install redis-server rabbitmq-server
sudo systemctl start redis rabbitmq-server
```

### Akses
| URL | Keterangan |
|-----|------------|
| `http://localhost:3000` | Chat App |
| `http://localhost:3000/admin` | Admin Panel |
| `http://localhost:15672` | RabbitMQ Management UI |

**Login admin: `admin` / `admin123`**

---

## 📁 Struktur Project

```
chatapp/
├── server.js               # Entry point — boot semua services
├── app.js                  # Express app factory
├── .env                    # Environment variables
├── package.json
│
├── src/
│   ├── config/
│   │   ├── database.js     # SQLite (sql.js) — schema, repo, seed
│   │   └── redis.js        # ioredis — cache, online users, sessions
│   │
│   ├── services/
│   │   ├── broker.js       # RabbitMQ (amqplib) — exchanges, queues, pub/sub
│   │   └── socket.js       # Socket.IO handlers + admin namespace
│   │
│   ├── middleware/
│   │   └── security.js     # JWT, rate limit, helmet, cors, Joi, sanitizer
│   │
│   ├── routes/
│   │   ├── auth.js         # /api/auth/register|login|logout|me
│   │   ├── chat.js         # /api/rooms, /api/rooms/:id/messages
│   │   └── admin.js        # /api/admin/* (semua admin endpoints)
│   │
│   └── utils/
│       └── logger.js       # Winston logger + Morgan stream
│
├── public/
│   ├── index.html          # Chat App frontend
│   └── admin/
│       └── index.html      # Admin Dashboard
│
└── data/
    └── chatapp.db          # SQLite database file (auto-created)
```

---

## 🛠️ Tech Stack

| Layer | Package | Fungsi |
|-------|---------|--------|
| Runtime | `node` v18+ | JavaScript runtime |
| Framework | `express` v5 | REST API |
| Config | `dotenv` | Environment variables |
| Realtime | `socket.io` | WebSocket bidirectional |
| Database | `sql.js` (SQLite) | Persistent storage (pure JS) |
| Cache | `ioredis` | Redis — session cache, online users |
| Broker | `amqplib` | RabbitMQ — message routing |
| Auth | `jsonwebtoken` | JWT access tokens |
| Password | `bcryptjs` | Bcrypt hashing |
| Validation | `joi` | Input schema validation |
| Security | `helmet` | HTTP security headers |
| CORS | `cors` | Cross-origin control |
| Rate Limit | `express-rate-limit` | Brute-force protection |
| Logging | `winston` + `morgan` | Structured logging |
| ID | `uuid` | Unique identifiers |

---

## 📡 RabbitMQ Architecture

### Exchanges
| Exchange | Type | Fungsi |
|----------|------|--------|
| `chatapp.topic` | topic | Routing berdasarkan routing key |
| `chatapp.fanout` | fanout | Broadcast ke semua consumer |

### Queues & Bindings
| Queue | Binding | Konsumsi |
|-------|---------|----------|
| `q.chat` | `chat.#` | Semua pesan chat |
| `q.audit` | `user.#`, `admin.#` | Audit trail |
| `q.notifications` | `user.#` | Notifikasi user |
| `q.admin` | `#` (semua) | Admin monitoring feed |

### Topics
```
chat.message     — Pesan baru terkirim
chat.typing      — User sedang mengetik
chat.read        — Pesan dibaca
user.status      — Online/offline
user.login       — User login
user.logout      — User logout
user.banned      — User diblokir
admin.action     — Aksi admin
system.alert     — Alert sistem
system.broadcast — Broadcast ke semua user
```

---

## 🔐 Keamanan

| Fitur | Detail |
|-------|--------|
| JWT Auth | 24 jam, verifikasi di setiap request |
| Password | bcrypt hash (salt rounds 10) |
| Joi Validation | Schema validation semua input |
| Rate Limiting | Login 10x/15min, API 120x/min, Socket 60msg/min |
| Helmet | 11 security headers HTTP |
| CORS | Kontrol origin yang diizinkan |
| XSS Sanitizer | Strip script tags, event handlers |
| Suspicious Detector | Auto-flag pesan mencurigakan |
| Session Cache | Redis — revoke instan tanpa DB |
| Redis Session | Cache session untuk performa |

---

## 🛡️ Admin Panel

**URL:** `/admin` | **Login:** `admin / admin123`

Fitur:
- Dashboard statistik real-time (users, messages, sessions, broker events)
- Grafik aktivitas pesan 7 hari
- Manajemen user: ban/unban
- Monitor sesi aktif + revoke paksa
- Pesan flagged + hapus
- Audit log semua aksi
- Live broker events via WebSocket `/admin-ws`
- Broadcast ke semua pengguna online

---

## 🗄️ Database

### Migrasi ke MongoDB
```javascript
// src/config/database.js — ganti initDB() dengan:
const mongoose = require('mongoose');
await mongoose.connect(process.env.MONGODB_URI);
// Buat Mongoose models untuk User, Room, Message, Session, AuditLog
```

### Migrasi ke PostgreSQL
```javascript
const { Sequelize } = require('sequelize');
const sequelize = new Sequelize(process.env.DATABASE_URL);
```

---

## 🌐 Socket.IO Events

### Client → Server
| Event | Payload | Keterangan |
|-------|---------|------------|
| `get_rooms` | — | Minta daftar room |
| `join_room` | `{ roomId }` | Masuk room & ambil pesan |
| `send_message` | `{ roomId, text }` | Kirim pesan |
| `typing` | `{ roomId }` | Mulai mengetik |
| `stop_typing` | `{ roomId }` | Berhenti mengetik |

### Server → Client
| Event | Payload | Keterangan |
|-------|---------|------------|
| `rooms` | `Room[]` | Daftar room |
| `room_messages` | `{ roomId, messages[] }` | Riwayat pesan |
| `new_message` | `Message` | Pesan masuk |
| `typing` | `{ roomId, name }` | Indikator mengetik |
| `stop_typing` | `{ roomId }` | Stop mengetik |
| `user_status` | `{ userId, status }` | Status user berubah |
| `message_deleted` | `{ msgId }` | Pesan dihapus admin |
| `system_broadcast` | `{ message, from }` | Broadcast admin |
| `banned` | `{ reason }` | User diblokir |
| `admin_alert` | `{ type, ... }` | Alert ke admin |

---

## 🔌 Swap ke MongoDB (opsional)

```bash
npm install mongoose
```
```env
DB_TYPE=mongodb
MONGODB_URI=mongodb://localhost:27017/chatapp
```
Implementasikan `UserRepo`, `RoomRepo`, dst. sebagai Mongoose models dengan interface yang sama.
