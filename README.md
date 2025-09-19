# FLV to HLS Conversion Server

Server Node.js untuk mengkonversi live stream FLV ke format HLS agar dapat diputar di iOS Safari.

## 🎯 Masalah yang Diselesaikan

- iOS Safari tidak mendukung format FLV secara native
- flv.js tidak berjalan di iOS
- Video dashcam dari MettaXiot tidak dapat diputar di aplikasi mobile iOS

## 🔧 Solusi

Server ini menggunakan **FFmpeg** untuk melakukan real-time conversion dari stream FLV ke HLS (HTTP Live Streaming), format yang didukung penuh oleh iOS.

## 📋 Prerequisites

1. **Node.js** (versi 16 atau lebih baru)
2. **FFmpeg** (wajib terinstall di system)

### Instalasi FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg
```

**Windows:**
1. Download dari https://ffmpeg.org/download.html
2. Extract dan tambahkan ke system PATH

**Verifikasi instalasi:**
```bash
ffmpeg -version
```

## 🚀 Instalasi dan Menjalankan Server

### 1. Setup Server

```bash
# Buat folder untuk server
mkdir flv-to-hls-server
cd flv-to-hls-server

# Copy file server.js dan package.json ke folder ini

# Install dependencies
npm install

# Jalankan server
npm start

# Atau untuk development (dengan auto-restart)
npm run dev
```

### 2. Server akan berjalan di `http://localhost:3001`

Anda akan melihat output seperti ini:
```
=================================
FLV to HLS Conversion Server
=================================
Server running on port 3001
Health check: http://localhost:3001/api/health
HLS files served at: http://localhost:3001/hls/
✅ FFmpeg is available
=================================
```

## 📡 API Endpoints

### 1. Mulai Konversi Stream
```http
POST /api/stream/start
Content-Type: application/json

{
  "flvUrl": "http://example.com/stream.flv",
  "streamId": "unique-stream-id"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Stream conversion started",
  "hlsUrl": "http://localhost:3001/hls/unique-stream-id/playlist.m3u8",
  "streamId": "unique-stream-id"
}
```

### 2. Hentikan Stream
```http
POST /api/stream/stop
Content-Type: application/json

{
  "streamId": "unique-stream-id"
}
```

### 3. Cek Status Stream
```http
GET /api/stream/status/unique-stream-id
```

### 4. Daftar Stream Aktif
```http
GET /api/streams/active
```

### 5. Health Check
```http
GET /api/health
```

## 🔄 Cara Kerja System

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐
│   MettaXiot │────│     Your     │────│  HLS Server │────│   iOS App    │
│   FLV Stream│    │   Frontend   │    │  (FFmpeg)   │    │   (Safari)   │
└─────────────┘    └──────────────┘    └─────────────┘    └──────────────┘
       │                   │                   │                   │
       │ 1. FLV Stream     │                   │                   │
       │◄──────────────────│                   │                   │
       │                   │ 2. Start Conversion                   │
       │                   │──────────────────►│                   │
       │                   │                   │ 3. FFmpeg Process │
       │                   │                   │   FLV → HLS       │
       │                   │                   │                   │
       │                   │ 4. HLS URL        │                   │
       │                   │◄──────────────────│                   │
       │                   │ 5. Load HLS Stream                    │
       │                   │──────────────────────────────────────►│
```

### Proses Detail:

1. **Frontend** mendapatkan URL FLV dari MettaXiot
2. **Frontend** mengirim request ke HLS server dengan URL FLV
3. **HLS Server** memulai proses FFmpeg untuk konversi real-time
4. **FFmpeg** membaca stream FLV dan mengkonversi ke segmen HLS (.ts files)
5. **HLS Server** menyediakan playlist.m3u8 yang bisa dibaca iOS
6. **iOS App** memutar stream menggunakan native HLS player

## 📱 Cara Menggunakan di Frontend

### 1. Ganti FlvVideoPlayer dengan HlsVideoPlayer

```javascript
// Sebelumnya
import FlvVideoPlayer from './FlvVideoPlayer';

// Sekarang
import HlsVideoPlayer from './HlsVideoPlayer';

// Penggunaan
<HlsVideoPlayer
  channelId={1}
  deviceId="12345"
  camType="METTAX"
  isActive={true}
  serverUrl="http://localhost:3001" // URL server HLS
  onLoadingComplete={() => console.log('Video loaded')}
  onError={(error) => console.error('Video error:', error)}
/>
```

### 2. Update untuk Production

Untuk production, ganti `serverUrl` dengan URL server yang sudah di-deploy:

```javascript
<HlsVideoPlayer
  serverUrl="https://your-hls-server.com"
  // ... props lainnya
/>
```

## 🏗️ Deployment ke Production

### Option 1: VPS/Server Sendiri

```bash
# Di server
git clone your-repo
cd flv-to-hls-server
npm install
npm start

# Atau menggunakan PM2 untuk production
npm install -g pm2
pm2 start server.js --name hls-server
pm2 startup
pm2 save
```

### Option 2: Docker

Buat file `Dockerfile`:

```dockerfile
FROM node:18-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
```

```bash
# Build dan run
docker build -t flv-to-hls-server .
docker run -p 3001:3001 flv-to-hls-server
```

### Option 3: Cloud Services

Server ini bisa di-deploy ke:
- **Heroku** (perlu buildpack FFmpeg)
- **DigitalOcean App Platform**
- **Railway**
- **AWS EC2/ECS**
- **Google Cloud Run**

## ⚡ Performance & Optimization

### Resource Usage per Stream:
- **CPU**: ~10-30% per stream (tergantung resolusi)
- **Memory**: ~50-100MB per stream
- **Network**: 2x bandwidth FLV original (input + output)

### Optimizations:
1. **Preset ultrafast**: Untuk low latency, tapi file size lebih besar
2. **Segment duration**: 2 detik untuk balance latency vs efficiency
3. **Cleanup otomatis**: Segment lama dihapus otomatis

### Limits:
- Server bisa handle ~5-10 concurrent streams pada VPS 2GB RAM
- Untuk lebih banyak stream, gunakan load balancer atau clustering

## 🐛 Troubleshooting

### Video tidak muncul di iOS:
```javascript
// Pastikan video element memiliki atribut ini
<video
  playsInline        // Penting untuk iOS
  muted             // iOS memerlukan muted untuk autoplay
  autoPlay          // Autoplay setelah loaded
  controls
/>
```

### Stream terputus-putus:
1. Cek bandwidth internet
2. Turunkan resolusi di FFmpeg args
3. Increase segment duration dari 2 ke 4 detik

### FFmpeg error:
1. Pastikan FFmpeg terinstall: `ffmpeg -version`
2. Cek format input stream masih FLV
3. Lihat log error di server console

### Memory usage tinggi:
1. Limit jumlah concurrent streams
2. Implement stream timeout/cleanup
3. Monitor dengan `pm2 monit`

## 📊 Monitoring

### Log Locations:
- Server logs: Console output atau file log
- FFmpeg logs: Tersedia di server console
- Stream status: `/api/streams/active`

### Metrics yang dimonitor:
- Jumlah active streams
- CPU/Memory usage per stream  
- Network bandwidth usage
- Error rate conversion

## 🔒 Security Considerations

1. **Rate Limiting**: Implement rate limiting untuk API
2. **Authentication**: Tambahkan auth untuk start/stop stream
3. **CORS**: Configure CORS sesuai domain frontend
4. **File Cleanup**: Pastikan cleanup berjalan dengan baik
5. **Resource Limits**: Set limits untuk prevent abuse

## 🎛️ Configuration Options

Edit di `server.js` untuk customize:

```javascript
// FFmpeg options
const ffmpegArgs = [
    '-i', flvUrl,
    '-c:v', 'libx264',        // Video codec
    '-c:a', 'aac',            // Audio codec  
    '-preset', 'ultrafast',    // Speed vs quality
    '-hls_time', '2',         // Segment duration
    '-hls_list_size', '10',   // Max segments in playlist
    // ... other options
];
```

## 📞 Support

Jika ada masalah atau pertanyaan:
1. Cek troubleshooting section di atas
2. Lihat log server untuk error details
3. Test dengan curl/Postman untuk isolate masalah
4. Verify FFmpeg installation dan versi# flv-to-hls
