// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

export async function initDB() {
  db = await open({
    filename: './cloudflare_videos.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      uid TEXT PRIMARY KEY,
      filename TEXT,
      status TEXT,
      created_at TEXT
    )
  `);

  const pragma = await db.all(`PRAGMA table_info(videos)`);
  const hasOriginalCreatedAt = pragma.some(col => col.name === 'original_created_at');
  const hasLastError = pragma.some(col => col.name === 'last_error');

  if (!hasOriginalCreatedAt) {
    await db.exec(`ALTER TABLE videos ADD COLUMN original_created_at TEXT`);
  }
  if (!hasLastError) {
    await db.exec(`ALTER TABLE videos ADD COLUMN last_error TEXT`);
  }
}

export async function markAsProcessed(uid, filename, status, originalCreatedAt = null, lastError = null) {
  await db.run(
    `INSERT OR REPLACE INTO videos (uid, filename, status, created_at, original_created_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uid, filename, status, new Date().toISOString(), originalCreatedAt, lastError]
  );
}

export async function updateFilename(uid, newFilename) {
  await db.run(
    `UPDATE videos SET filename = ? WHERE uid = ?`,
    [newFilename, uid]
  );
}

// This is the critical change: only return true if it's actually on disk
export async function isProcessed(uid) {
  const row = await db.get(`SELECT status FROM videos WHERE uid = ?`, [uid]);
  return row?.status === 'downloaded';
}

// Add this export so cloudflare-sync.js doesn't error on import
export async function getProcessedRecord(uid) {
  return await db.get(`SELECT * FROM videos WHERE uid = ?`, [uid]);
}