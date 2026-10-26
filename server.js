// server.js
import ffmpeg from 'fluent-ffmpeg';
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import session from 'express-session';
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import mergeRouter from "./merge.js";
import { initDB } from "./db.js";
import {
  syncCloudflareVideos,
  cloudflareSyncStatus
} from "./cloudflare-sync.js";
import renameRouter from "./rename.js";

/*
|--------------------------------------------------------------------------
| Paths / Globals
|--------------------------------------------------------------------------
*/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3301;

const VIDEO_DIR = path.join(__dirname, 'public', 'videos');
const THUMB_DIR = path.join(__dirname, 'public', 'thumbnails');

// Track server start for uptime
const serverStart = Date.now();

// Set ffmpeg paths for Debian (changed from Alpine)
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

/*
|--------------------------------------------------------------------------
| App & Server
|--------------------------------------------------------------------------
*/
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" }
});

// Make io globally accessible to sync module
global.__io = io;

/*
|--------------------------------------------------------------------------
| Middleware (MUST BE BEFORE ROUTES)
|--------------------------------------------------------------------------
*/
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));

app.use(session({
  secret: process.env.ADMIN_PASSWORD || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, 
    httpOnly: true,
    secure: false
  }
}));

/*
|--------------------------------------------------------------------------
| Auth Middleware
|--------------------------------------------------------------------------
*/
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    return next();
  }
  
  // ✅ Smart redirect: JSON for API calls, HTML for browser
  if (req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.redirect('/admin/login');
}

/*
|--------------------------------------------------------------------------
| Startup Safety: Ensure folders exist
|--------------------------------------------------------------------------
*/
async function ensureFolders() {
  await fs.mkdir("./public/videos", { recursive: true });
  await fs.mkdir("./public/thumbnails", { recursive: true });
  await fs.mkdir("./public/uploads", { recursive: true });
}

await ensureFolders().catch(err => {
  console.error("❌ Failed to create required folders:", err);
  process.exit(1);
});

// Initialize the database
await initDB().catch(err => {
  console.error("❌ Failed to initialize database:", err);
  process.exit(1);
});

/*
|--------------------------------------------------------------------------
| PUBLIC ROUTES
|--------------------------------------------------------------------------
*/

// Serve admin.js from root directory
app.get('/admin.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.js'));
});

// ✅ Block direct access to admin.html (redirect to /admin)
app.get('/admin.html', (req, res) => {
  res.redirect('/admin');
});

// Robust video streaming with Range support
app.get('/videos/:filename', async (req, res) => {
  try {
    const videoPath = path.join(__dirname, 'public', 'videos', req.params.filename);
    const stats = await fs.stat(videoPath);
    const fileSize = stats.size;
    const range = req.headers.range;

    if (!range) {
      // No range header: send whole file
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes'
      };
      res.writeHead(200, head);
      fsSync.createReadStream(videoPath).pipe(res);
      return;
    }

    // Parse Range: "bytes=start-end"
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Safety checks
    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = (end - start) + 1;
    const file = fsSync.createReadStream(videoPath, { start, end });

    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    };

    res.writeHead(206, head); // Partial Content
    file.pipe(res);
  } catch (err) {
    console.error("❌ Video stream error:", err);
    res.status(404).send("Video not found");
  }
});

// Static assets (kept AFTER /videos route so it doesn't override it)
app.use(express.static(path.join(__dirname, "public")));

/*
|--------------------------------------------------------------------------
| HEALTH ENDPOINTS
|--------------------------------------------------------------------------
*/

// Simple health endpoint for Docker healthcheck
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// JSON health endpoint used by your health page
app.get('/api/health', (req, res) => {
  const now = Date.now();
  const uptimeSeconds = (now - serverStart) / 1000;

  res.json({
    ok: true,
    uptime: uptimeSeconds,
    timestamp: new Date(now).toISOString(),
    status: cloudflareSyncStatus
  });
});

// Existing Cloudflare status endpoint (kept as-is)
app.get('/api/cloudflare/status', (req, res) => {
  res.json({
    success: true,
    status: cloudflareSyncStatus
  });
});

/*
|--------------------------------------------------------------------------
| CLOUDFLARE SYNC ROUTES
|--------------------------------------------------------------------------
*/
app.post('/api/cloudflare/sync', async (req, res) => {
  try {
    const { force } = req.body;
    // Fire-and-forget to avoid blocking HTTP response
    syncCloudflareVideos({ force: !!force });
    res.json({ success: true, message: 'Cloudflare sync started' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/*
|--------------------------------------------------------------------------
| VIDEOS API
|--------------------------------------------------------------------------
*/
app.get("/api/videos", async (req, res) => {
  try {
    const videoFiles = await fs.readdir("./public/videos");
    const thumbFiles = new Set(
      await fs.readdir("./public/thumbnails").catch(() => [])
    );

    const videos = videoFiles
      .filter(f => f.endsWith(".mp4"))
      .map(file => {
        const uid = path.basename(file, ".mp4");
        const hasThumb = thumbFiles.has(`${uid}.jpg`);

        return {
          title: file,
          ext: "mp4",
          src: `/videos/${file}`,
          thumb: hasThumb ? `/thumbnails/${uid}.jpg` : null
        };
      });

    videos.sort((a, b) => {
      const timeA = new Date(a.title.split('.')[0]).getTime();
      const timeB = new Date(b.title.split('.')[0]).getTime();
      return timeB - timeA;
    });

    res.json(videos);
  } catch (err) {
    console.error("❌ Error listing videos:", err);
    res.status(500).json([]);
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN AUTH ROUTES
|--------------------------------------------------------------------------
*/

// Login page
app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Login</title>
      <style>
        body {
          margin: 0;
          font-family: system-ui, -apple-system, sans-serif;
          background: linear-gradient(180deg, #051226 0%, #061423 100%);
          color: #e6eef8;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .login-box {
          background: #081724;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 40px;
          width: 100%;
          max-width: 400px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        h1 { margin: 0 0 24px; font-size: 24px; text-align: center; }
        input {
          width: 100%;
          padding: 12px;
          margin-bottom: 16px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          color: #fff;
          font-size: 16px;
          box-sizing: border-box;
        }
        button {
          width: 100%;
          padding: 12px;
          background: #22c55e;
          border: none;
          border-radius: 8px;
          color: #000;
          font-weight: bold;
          font-size: 16px;
          cursor: pointer;
        }
        button:hover { background: #16a34a; }
        .error { color: #f97373; text-align: center; margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h1>🔒 Admin Login</h1>
        <form method="POST" action="/admin/login">
          <input type="password" name="password" placeholder="Enter password" required autofocus>
          <button type="submit">Login</button>
        </form>
        ${req.query.error ? '<div class="error">❌ Invalid password</div>' : ''}
      </div>
    </body>
    </html>
  `);
});

// Login handler
app.post('/admin/login', (req, res) => {
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const inputPassword = req.body.password;

  console.log(`🔐 Login attempt: ${inputPassword ? '***' : 'EMPTY'}`);

  if (inputPassword === password) {
    req.session.authenticated = true;
    req.session.save((err) => {
      if (err) {
        console.error("❌ Session save error:", err);
        return res.redirect('/admin/login?error=session');
      }
      console.log("✅ Login successful");
      res.redirect('/admin');
    });
  } else {
    console.log("❌ Login failed: Incorrect password");
    res.redirect('/admin/login?error=1');
  }
});

// Logout route
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

/*
|--------------------------------------------------------------------------
| PROTECTED ADMIN ROUTES
|--------------------------------------------------------------------------
*/

// Admin dashboard
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// List files for admin
app.get('/api/admin/files', requireAuth, async (req, res) => {
  try {
    const videoFiles = await fs.readdir(VIDEO_DIR);
    const thumbFiles = new Set(
      await fs.readdir(THUMB_DIR).catch(() => [])
    );

    const files = [];
    for (const file of videoFiles) {
      if (!file.endsWith('.mp4')) continue;

      const basename = path.basename(file, '.mp4');
      const hasThumbnail = thumbFiles.has(`${basename}.jpg`);
      const videoPath = path.join(VIDEO_DIR, file);
      const stats = await fs.stat(videoPath);

      files.push({
        filename: file,
        basename,
        hasThumbnail,
        thumbPath: hasThumbnail ? `/thumbnails/${basename}.jpg` : null,
        size: stats.size
      });
    }

    // Sort by date (newest first)
    files.sort((a, b) => {
      const timeA = new Date(a.filename.split('_')[0]).getTime();
      const timeB = new Date(b.filename.split('_')[0]).getTime();
      return timeB - timeA;
    });

    res.json(files);
  } catch (err) {
    console.error('❌ Error listing admin files:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete video + thumbnail (keep DB record)
app.post('/api/admin/delete', requireAuth, async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename required' });
    }

    const videoPath = path.join(VIDEO_DIR, filename);
    const basename = path.basename(filename, '.mp4');
    const thumbPath = path.join(THUMB_DIR, `${basename}.jpg`);

    let deletedVideo = false;
    let deletedThumb = false;

    // Delete video file
    if (fsSync.existsSync(videoPath)) {
      await fs.unlink(videoPath);
      deletedVideo = true;
      console.log(`🗑️ Deleted video: ${filename}`);
    }

    // Delete thumbnail
    if (fsSync.existsSync(thumbPath)) {
      await fs.unlink(thumbPath);
      deletedThumb = true;
      console.log(`🗑️ Deleted thumbnail: ${basename}.jpg`);
    }

    // ✅ Keep DB record (do NOT call db.run DELETE)
    // This prevents re-download on next sync

    res.json({ 
      success: true, 
      deletedVideo,
      deletedThumb,
      message: `Deleted ${filename} (DB record preserved)`
    });

  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Mount protected routers (FIXED: removed duplicate requireAuth)
app.use('/api/admin', requireAuth, renameRouter);
app.use('/api/admin', requireAuth, mergeRouter);

/*
|--------------------------------------------------------------------------
| SOCKET.IO
|--------------------------------------------------------------------------
*/
let liveViewers = new Set();

io.on("connection", socket => {
  console.log("🔌 Client connected:", socket.id);

  socket.emit("sync:status", cloudflareSyncStatus);

  liveViewers.add(socket.id);
  io.emit("viewers:update", { viewers: liveViewers.size });

  socket.on("disconnect", () => {
    liveViewers.delete(socket.id);
    io.emit("viewers:update", { viewers: liveViewers.size });
    console.log("🔌 Client disconnected:", socket.id);

  socket.on('videos:update', () => {
    loadRecentVideos();
});
  });
});

/*
|--------------------------------------------------------------------------
| SCHEDULER: HOURLY CLOUDFLARE SYNC
|--------------------------------------------------------------------------
*/

// Run once on startup (optional)
syncCloudflareVideos({ force: false }).catch(err => {
  console.error("❌ Initial Cloudflare sync failed:", err);
});

// Then every hour
const ONE_HOUR = 60 * 60 * 1000;
setInterval(() => {
  console.log("⏰ Hourly Cloudflare sync triggered");
  syncCloudflareVideos({ force: false }).catch(err => {
    console.error("❌ Hourly Cloudflare sync failed:", err);
  });
}, ONE_HOUR);

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Video directory: ${VIDEO_DIR}`);
  console.log(`📁 Thumbnail directory: ${THUMB_DIR}`);
});