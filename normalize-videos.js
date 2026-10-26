// normalize-videos.js
import ffmpeg from "fluent-ffmpeg";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIDEOS_DIR = path.join(__dirname, "public", "videos");

// Set explicit paths for Debian
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");
ffmpeg.setFfprobePath("/usr/bin/ffprobe");

async function normalizeVideo(file) {
  const inputPath = path.join(VIDEOS_DIR, file);
  const tmpOutputPath = path.join(
    VIDEOS_DIR,
    `.tmp-faststart-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`
  );

  console.log(`\n🎬 Normalizing: ${file}`);
  console.log(`   Input:  ${inputPath}`);
  console.log(`   Output: ${tmpOutputPath}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-c", "copy",
        "-movflags", "+faststart"
      ])
      .on("start", cmd => {
        console.log("  ▶ ffmpeg command:", cmd);
      })
      .on("progress", progress => {
        if (progress.percent) {
          process.stdout.write(`\r  ⏳ Progress: ${Math.round(progress.percent)}%`);
        }
      })
      .on("error", (err, stdout, stderr) => {
        console.error(`\n  ❌ Error normalizing ${file}:`);
        console.error("     Error:", err.message);
        if (stderr) console.error("     stderr:", stderr);

        // Clean up temp file if it exists
        if (fsSync.existsSync(tmpOutputPath)) {
          fsSync.unlinkSync(tmpOutputPath);
        }

        reject(err);
      })
      .on("end", async () => {
        try {
          console.log(`\n  ✅ ffmpeg finished for ${file}`);

          // Check if temp file was actually created
          if (!fsSync.existsSync(tmpOutputPath)) {
            throw new Error(`Temp output file not created: ${tmpOutputPath}`);
          }

          const stats = await fs.stat(tmpOutputPath);
          console.log(`  📦 Temp file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

          // Replace original file with normalized version
          await fs.rename(tmpOutputPath, inputPath);
          console.log(`  ✅ Replaced original: ${file}`);
          resolve();
        } catch (err) {
          console.error(`  ❌ Failed to replace original for ${file}:`, err.message);
          reject(err);
        }
      })
      .save(tmpOutputPath);
  });
}

async function main() {
  try {
    console.log(`📂 Scanning directory: ${VIDEOS_DIR}\n`);

    // Check if directory exists
    if (!fsSync.existsSync(VIDEOS_DIR)) {
      console.error(`❌ Directory does not exist: ${VIDEOS_DIR}`);
      process.exit(1);
    }

    const files = await fs.readdir(VIDEOS_DIR);
    const mp4s = files.filter(f => f.toLowerCase().endsWith(".mp4") && !f.startsWith(".tmp-"));

    if (!mp4s.length) {
      console.log("ℹ️  No .mp4 files found in public/videos.");
      return;
    }

    console.log(`Found ${mp4s.length} .mp4 file(s) to normalize.\n`);
    console.log("⚠️  This will modify your original files in place.");
    console.log("⚠️  Press Ctrl+C now if you want to make backups first.\n");

    // Wait 3 seconds before starting
    await new Promise(resolve => setTimeout(resolve, 3000));

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < mp4s.length; i++) {
      const file = mp4s[i];
      const fullPath = path.join(VIDEOS_DIR, file);

      console.log(`\n[${ i + 1}/${mp4s.length}] Processing: ${file}`);

      // Check file exists and get size
      try {
        const stats = await fs.stat(fullPath);
        console.log(`📹 Original size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      } catch (err) {
        console.log(`  ⏭️  Skipping missing file: ${file}`);
        errorCount++;
        continue;
      }

      try {
        await normalizeVideo(file);
        successCount++;
      } catch (err) {
        console.error(`  ⚠️  Failed to process ${file}, continuing...\n`);
        errorCount++;
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ Processing complete!");
    console.log(`   Success: ${successCount}`);
    console.log(`   Errors:  ${errorCount}`);
    console.log(`   Total:   ${mp4s.length}`);
    console.log("=".repeat(60) + "\n");

  } catch (err) {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  }
}

main();