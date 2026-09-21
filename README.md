# JKT48 Restock Notifier

Cloudflare Worker yang memeriksa stok Meet & Greet, 2Shot, dan Video Call setiap menit lalu mengirim perubahan kuota ke Telegram.

> Status saat ini: Worker, KV, dan Telegram sudah terkonfigurasi, tetapi Cron dinonaktifkan karena endpoint JKT48 mengembalikan Cloudflare Managed Challenge (`403`, `cf-mitigated=challenge`) untuk eksekusi Cron produksi. Aktifkan kembali hanya setelah tersedia akses API resmi/whitelist dari upstream.

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
npm run deploy
```

Masukkan nilai secret hanya ketika prompt Wrangler muncul. Deployment pertama otomatis membuat namespace KV dan menuliskan ID-nya ke `wrangler.jsonc`.

## Verifikasi

```powershell
npx wrangler tail
```

Setelah akses upstream tersedia dan Cron diaktifkan kembali, tunggu run berikutnya. Run pertama membuat baseline dan tidak mengirim notifikasi. Buka URL `workers.dev` hasil deployment untuk melihat waktu pemeriksaan terakhir dan error API terakhir.

## Perintah lokal

```powershell
npm test
npm run check
npm run dev
```

Salin `.dev.vars.example` menjadi `.dev.vars` hanya jika ingin mencoba dengan secret lokal. `.dev.vars` tidak boleh di-commit.
