# JKT48 Restock Notifier

Cloudflare Worker dan GitHub Actions yang memeriksa stok Meet & Greet, 2Shot, dan Video Call setiap 10 menit lalu mengirim restock ke Telegram.

GitHub Actions dipakai untuk membaca API karena request langsung dari Cloudflare Worker terkena Managed Challenge. Saat bot `/off`, workflow berhenti sebelum mengakses JKT48.

## Data yang perlu disiapkan

### 1. Telegram bot token

1. Buka Telegram dan chat `@BotFather`.
2. Kirim `/newbot`, lalu ikuti instruksinya.
3. Simpan token berbentuk `123456789:AA...` sebagai `TELEGRAM_BOT_TOKEN`.

### 2. Telegram chat ID

1. Chat bot yang baru dibuat dan kirim `/start`.
2. Buka `https://api.telegram.org/bot<TOKEN_ANDA>/getUpdates` di browser.
3. Cari `message.chat.id`; angka tersebut adalah `TELEGRAM_CHAT_ID`.

Untuk grup, tambahkan bot ke grup, kirim sebuah pesan, lalu ulangi `getUpdates`. Chat ID grup biasanya diawali `-`.

## Deploy

```powershell
npm install
npx wrangler login
npm run check
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

Masukkan nilai secret hanya ketika prompt Wrangler muncul. Tambahkan nilai `INGEST_TOKEN` yang sama di GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

## Verifikasi

```powershell
npx wrangler tail
```

Kirim `/on 3h`, lalu tunggu maksimal 10 menit atau jalankan workflow **Poll JKT48 stock** secara manual. Run pertama membuat baseline dan tidak mengirim notifikasi.

## Perintah lokal

```powershell
npm test
npm run check
npm run dev
```

Salin `.dev.vars.example` menjadi `.dev.vars` hanya jika ingin mencoba dengan secret lokal. `.dev.vars` tidak boleh di-commit.
