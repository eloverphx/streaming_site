// cloudflare-sync.js
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { markAsProcessed, isProcessed } from './db.js';
import ffmpeg from 'fluent-ffmpeg';

/* ================= CONFIG ================= */

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  throw new Error('CF_ACCOUNT_ID or CF_API_TOKEN not set');
}

const BASE_DIR = path.resolve('./public');
const VIDEO_DIR = path.join(BASE_DIR, 'videos');
const THUMB_DIR = path.join(BASE_DIR, 'thumbnails');

// Same scoreboard file used by server.js (data/scoreboard.json)
const SCOREBOARD_FILE = "/scoreboard/data/scoreboard.json";

/* ================= CLOUDFLARE CLIENT ================= */

const cf = axios.create({
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`,
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 20000
});

/* ================= STATE ================= */

export const cloudflareSyncStatus = {
  running: false,
  lastRun: null,
  totalVideos: 0,
  downloaded: 0,
  skipped: 0,
  errors: [],
  currentVideo: null,
  progress: 0
};

// NEW: Recursively search for a file in all subfolders
function fileExistsDeep(dir, filename) {
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const file of files) {
    if (!file.isDirectory() && file.name === filename) return true;
  }
  return false;
}

/* ================= SOCKET HELPER ================= */

function emitSync(event, payload = {}) {
  if (global.__io) {
    global.__io.emit(event, payload);
  }
}

/* ================= INIT ================= */

function ensureDirs() {
  [BASE_DIR, VIDEO_DIR, THUMB_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

/* ================= HELPERS ================= */

async function listStreams() {
  try {
    console.log('📡 Fetching list of streams from Cloudflare...');
    const res = await cf.get('/stream');
    console.log('✅ Streams fetched successfully');
    return res.data?.result || [];
  } catch (err) {
    console.error('❌ Error fetching streams:', err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

async function getStreamStatus(uid) {
  try {
    console.log(`📡 Fetching status for stream UID: ${uid}`);
    const res = await cf.get(`/stream/${uid}`);
    console.log(`✅ Status for UID ${uid}:`, res.data?.result?.status?.state);
    return res.data?.result?.status?.state;
  } catch (err) {
    console.error(`❌ Error fetching status for UID ${uid}:`, err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

function getHlsUrl(uid) {
  return `https://videodelivery.net/${uid}/manifest/video.m3u8`;
}

async function downloadFile(url, outPath) {
  try {
    console.log(`📡 Downloading file from URL: ${url}`);
    const res = await axios.get(url, { 
      responseType: 'stream', 
      timeout: 60000,
      headers: { 'Accept': '*/*' }
    });

    // 🛑 CHECK: If Cloudflare sends HTML, it's an error page, not a video
    const contentType = res.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      throw new Error('Access Denied or Error Page returned (Check Cloudflare Domain Restrictions)');
    }

    const writer = fs.createWriteStream(outPath);
    res.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`✅ File downloaded successfully to: ${outPath}`);
        resolve();
      });
      writer.on('error', reject);
    });
  } catch (err) {
    console.error(`❌ Error downloading file from URL ${url}:`, err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

async function captureThumbnail(uid, filename) {
  const url = `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg`;
  const outPath = path.join(THUMB_DIR, `${filename}.jpg`);

  try {
    await downloadFile(url, outPath);
  } catch {
    // Thumbnail not available yet — safe to ignore
    console.log(`⚠️ Thumbnail not available for ${uid}, skipping`);
  }
}

// 🎬 NEW: Generate thumbnail from video using ffmpeg (fallback if CF thumbnail fails)
async function generateThumbnailFromVideo(videoPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['10%'],  // Capture at 10% into video
        filename: path.basename(outPath),
        folder: path.dirname(outPath),
        size: '1280x720'
      })
      .on('end', () => {
        console.log('✅ Thumbnail generated from video:', outPath);
        resolve();
      })
      .on('error', (err) => {
        console.error('❌ Thumbnail generation failed:', err.message);
        reject(err);
      });
  });
}

// 🎬 NEW: HLS → MP4 converter with progress tracking and quality selection
async function convertHlsToMp4(hlsUrl, outPath, uid) {
  return new Promise((resolve, reject) => {
    let lastProgress = 0;

    ffmpeg(hlsUrl)
      .inputOptions([
        '-protocol_whitelist', 'file,http,https,tcp,tls',
        '-allowed_extensions', 'ALL'
      ])
      .outputOptions([
        '-c', 'copy',        // remux only (FAST, no re-encode)
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart'  // Enable web streaming
      ])
      .output(outPath)
      .on('start', cmd => {
        console.log('🎬 ffmpeg started:', cmd);
        cloudflareSyncStatus.currentVideo = uid;
      })
      .on('progress', (progress) => {
        // progress.percent is sometimes undefined, use timemark as fallback
        const percent = progress.percent || 0;
        
        // Only emit every 5% to reduce socket spam
        if (Math.floor(percent / 5) > Math.floor(lastProgress / 5)) {
          lastProgress = percent;
          cloudflareSyncStatus.progress = Math.round(percent);
          
          emitSync('sync:video:progress', { 
            uid, 
            percent: Math.round(percent),
            timemark: progress.timemark 
          });
          
          console.log(`📊 Progress for ${uid}: ${Math.round(percent)}%`);
        }
      })
      .on('end', () => {
        console.log('✅ HLS → MP4 complete:', outPath);
        
        // Verify file size (sanity check)
        const stats = fs.statSync(outPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        if (stats.size < 5 * 1024 * 1024) {  // Less than 5MB
          console.warn(`⚠️ Warning: Video file is suspiciously small (${sizeMB}MB)`);
        } else {
          console.log(`✅ Video size: ${sizeMB}MB`);
        }
        
        cloudflareSyncStatus.currentVideo = null;
        cloudflareSyncStatus.progress = 0;
        resolve();
      })
      .on('error', (err) => {
        console.error('❌ ffmpeg error:', err.message);
        cloudflareSyncStatus.currentVideo = null;
        cloudflareSyncStatus.progress = 0;
        
        // Clean up partial file
        if (fs.existsSync(outPath)) {
          fs.unlinkSync(outPath);
          console.log('🗑️ Cleaned up partial file');
        }
        
        reject(err);
      })
      .run();
  });
}

/* ================= SCOREBOARD-BASED NAMING ================= */

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alnum -> dash
    .replace(/^-+|-+$/g, '');      // trim dashes
}

function readScoreboardSafe() {
  try {
    if (!fs.existsSync(SCOREBOARD_FILE)) {
      console.warn('⚠️ SCOREBOARD_FILE not found:', SCOREBOARD_FILE);
      return {};
    }
    const raw = fs.readFileSync(SCOREBOARD_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('⚠️ Failed to read scoreboard.json for naming:', e.message);
    return {};
  }
}

function buildVideoFilename(stream) {
  const scoreboard = readScoreboardSafe();

  // 1. Date: prefer gameDate from scoreboard, else stream.created, else now
  const rawDate = scoreboard.gameDate || scoreboard.date || stream.created || new Date().toISOString();
  const d = new Date(rawDate);
  let dateString;
  if (isNaN(d.getTime())) {
    const now = new Date();
    dateString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  } else {
    dateString = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 2. Teams
  const home = scoreboard.homeTeam || 'Home';
  const away = scoreboard.awayTeam || 'Away';

  const homeSlug = slugify(home);
  const awaySlug = slugify(away);

  // 3. Optional period
  const periodPart = scoreboard.period ? `_period-${slugify(String(scoreboard.period))}` : '';

  // 4. UID suffix to ensure uniqueness (first 8 chars)
  const uidPart = stream.uid ? `_${stream.uid.slice(0, 8)}` : '';

  // 5. If we have usable team names, build nice filename
  if (homeSlug && awaySlug) {
    return `${dateString}_${homeSlug}-vs-${awaySlug}${periodPart}${uidPart}`;
  }

  // 6. Fallback: timestamp + UID
  const tsBase = new Date(stream.created || Date.now())
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19); // Keep only YYYY-MM-DDTHH-MM-SS
  return `${tsBase}${uidPart}`;
}

/* ================= MAIN ================= */

async function processStream(stream, force) {
  const uid = stream.uid;
  const status = await getStreamStatus(uid);

  if (status !== 'ready') {
    console.log(`⏭️ Skipping ${uid}: status is ${status}`);
    cloudflareSyncStatus.skipped++;
    return;
  }

  const filename = buildVideoFilename(stream);
  const outPath = path.join(VIDEO_DIR, `${filename}.mp4`);

  // Skip if already successfully downloaded
  if (!force && (await isProcessed(uid))) {
    console.log(`⏭️ Skipping ${uid}: already processed`);
    cloudflareSyncStatus.skipped++;
    return;
  }

  // Skip if file already exists anywhere in videos folder (resume support & moved files)
  const mp4Filename = `${filename}.mp4`;
  if (!force && fileExistsDeep(VIDEO_DIR, mp4Filename)) {
      console.log(`⏭️ Skipping ${uid}: file already exists (or was moved)`);
      await markAsProcessed(uid, filename, 'downloaded', stream.created, null);
      cloudflareSyncStatus.skipped++;
      return;
  }

  const hlsUrl = getHlsUrl(uid);

  try {
    console.log(`🎬 Starting conversion for ${uid}`);
    
    // Convert HLS → MP4
    await convertHlsToMp4(hlsUrl, outPath, uid);
    
    // Try Cloudflare thumbnail first
    await captureThumbnail(uid, filename);
    
    // If CF thumbnail failed, generate from video
    const thumbPath = path.join(THUMB_DIR, `${filename}.jpg`);
    if (!fs.existsSync(thumbPath)) {
      console.log('📸 Generating thumbnail from video...');
      try {
        await generateThumbnailFromVideo(outPath, thumbPath);
      } catch (thumbErr) {
        console.warn('⚠️ Could not generate thumbnail:', thumbErr.message);
      }
    }

    await markAsProcessed(uid, filename, 'downloaded', stream.created, null);

    cloudflareSyncStatus.downloaded++;
    emitSync('sync:video:done', { 
      uid, 
      filename,
      downloaded: cloudflareSyncStatus.downloaded 
    });
    
    console.log(`✅ Successfully processed ${uid} → ${filename}.mp4`);

  } catch (err) {
    const msg = err?.message || 'Unknown error';
    console.error(`❌ Failed processing stream UID ${uid}:`, msg);
    
    cloudflareSyncStatus.errors.push(`${uid}: ${msg}`);
    
    await markAsProcessed(uid, filename, 'error', stream.created, msg);
    
    emitSync('sync:video:error', { uid, error: msg });
  }
}

export async function syncCloudflareVideos({ force = false } = {}) {
  if (cloudflareSyncStatus.running) {
    console.log('⚠️ Sync already running, skipping');
    return;
  }

  ensureDirs();

  cloudflareSyncStatus.running = true;
  cloudflareSyncStatus.lastRun = new Date().toISOString();
  cloudflareSyncStatus.downloaded = 0;
  cloudflareSyncStatus.skipped = 0;
  cloudflareSyncStatus.errors = [];

  console.log('🚀 Starting Cloudflare sync...');

  try {
    const streams = await listStreams();
    cloudflareSyncStatus.totalVideos = streams.length;

    console.log(`📊 Found ${streams.length} streams`);

    emitSync('sync:start', { total: streams.length });

    // Process one at a time to avoid overwhelming ffmpeg/network
    // (You can increase to 2-3 if your server is powerful)
    const MAX_CONCURRENT_DOWNLOADS = 1;
    
    const tasks = streams.map((stream, index) => async () => {
      emitSync('sync:video:start', { 
        uid: stream.uid, 
        index: index + 1, 
        total: streams.length 
      });
      await processStream(stream, force);
    });

    for (let i = 0; i < tasks.length; i += MAX_CONCURRENT_DOWNLOADS) {
      const batch = tasks.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
      await Promise.all(batch.map(task => task()));
    }

    console.log('✅ Sync complete!');
    console.log(`📊 Downloaded: ${cloudflareSyncStatus.downloaded}, Skipped: ${cloudflareSyncStatus.skipped}, Errors: ${cloudflareSyncStatus.errors.length}`);

  } catch (err) {
    const msg = err?.message || 'Unknown fatal error';
    console.error('❌ Fatal sync error:', msg);
    cloudflareSyncStatus.errors.push(`Fatal: ${msg}`);
  } finally {
    cloudflareSyncStatus.running = false;
    cloudflareSyncStatus.currentVideo = null;
    cloudflareSyncStatus.progress = 0;
    emitSync('sync:complete', { status: cloudflareSyncStatus });
    global.__io.emit('videos:update');
  }
}