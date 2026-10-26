// merge.js
import express from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { exec } from "child_process";
import { promisify } from "util";
import multer from "multer";

const execAsync = promisify(exec);
const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIDEOS_DIR = path.join(__dirname, "public", "videos");
const THUMB_DIR = path.join(__dirname, "public", "thumbnails");

// Set FFmpeg path explicitly
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, VIDEOS_DIR);
  },
  fileFilter: (req, file, cb) => {
  const allowedExt = ['.mp4', '.mov'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (file.mimetype.startsWith('video/') && allowedExt.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only MP4 or MOV video files are allowed'), false);
  }
}
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Only accept video files
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 3 *1024 * 1024 * 1024 // 500MB limit
  }
});

/**
 * Generate thumbnail for a video file
 */
async function generateThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['10%'],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: '1280x720'
      })
      .on('end', () => {
        console.log(`✅ Thumbnail generated: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`❌ Thumbnail generation failed: ${err.message}`);
        reject(err);
      });
  });
}

async function convertMovToMp4(inputPath) {
  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir, `${parsed.name}.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-movflags', '+faststart',
        '-map_metadata', '0',
        '-c:v', 'copy',
        '-c:a', 'aac'
      ])
      .on('start', cmd => {
        console.log('🎞️ MOV→MP4 FFmpeg:', cmd);
      })
      .on('error', err => {
        reject(err);
      })
      .on('end', () => {
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

// Ensure directories exist (moved outside route handler)
try {
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  await fs.mkdir(THUMB_DIR, { recursive: true });
  console.log('📁 Directories initialized:', { VIDEOS_DIR, THUMB_DIR });
} catch (err) {
  console.error('⚠️ Failed to create directories:', err);
}

/**
 * POST /upload
 * Upload single or multiple video files
 * 
 * Form data:
 *  - videos: file(s) to upload
 *  - customName: optional custom name (only for single file)
 *  - generateThumb: boolean (default: true)
 * 
 * Returns: { success: true, files: [...uploaded files info] }
 */
router.post("/upload", upload.array("videos", 10), async (req, res) => {
  try {
    console.log("📤 Upload request received");

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No files uploaded"
      });
    }

    const generateThumb = req.body.generateThumb !== "false";
    const uploadedFiles = [];

    for (const file of req.files) {
      let finalFilename = file.filename;
      let finalPath = file.path;

      // 🔁 Convert MOV → MP4
      if (path.extname(file.filename).toLowerCase() === ".mov") {
        console.log(`🔄 Converting MOV → MP4: ${file.filename}`);

        const mp4Path = await convertMovToMp4(file.path);

        // Remove original MOV
        await fs.unlink(file.path);

        finalFilename = path.basename(mp4Path);
        finalPath = mp4Path;
      }

      const fileInfo = {
        filename: finalFilename,
        path: `/videos/${finalFilename}`,
        size: file.size,
        uploadedAt: new Date().toISOString(),
        thumbnailGenerated: false
      };

      // Generate thumbnail if requested
      if (generateThumb) {
        try {
          const thumbBasename = path.parse(finalFilename).name;
          const thumbPath = path.join(
            THUMB_DIR,
            `${thumbBasename}.jpg`
          );

          await generateThumbnail(finalPath, thumbPath);

          fileInfo.thumbnailGenerated = true;
          fileInfo.thumbnailPath = `/thumbnails/${thumbBasename}.jpg`;
        } catch (thumbErr) {
          console.error(
            `⚠️ Thumbnail generation failed for ${finalFilename}:`,
            thumbErr
          );
        }
      }

      uploadedFiles.push(fileInfo);
      console.log(`✅ Uploaded: ${finalFilename}`);
    }

    res.json({
      success: true,
      files: uploadedFiles,
      count: uploadedFiles.length
    });
  } catch (err) {
    console.error("❌ /upload failed:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Upload failed"
    });
  }
});


/**
 * POST /merge
 * Body: { 
 *   files: string[], 
 *   outputName?: string,
 *   deleteOriginals?: boolean,
 *   generateThumb?: boolean
 * }
 *
 * Example:
 *  { 
 *    "files": ["2025-01-01T10-00-00.mp4", "2025-01-01T10-15-00.mp4"], 
 *    "outputName": "2025-01-01-merged",
 *    "deleteOriginals": true,
 *    "generateThumb": true
 *  }
 *
 * Returns: { success: true, mergedFilename, mergedPath, url, thumbnailGenerated, deletedFiles }
 */
router.post("/merge", async (req, res) => {
  let tempListFile = null;

  try {
    console.log('🎬 Merge request received:', req.body);
    
    const { files, outputName, deleteOriginals = false, generateThumb = true } = req.body || {};

    // Emit progress via Socket.IO if available
    const io = global.__io;
    const emitProgress = (stage, message, progress = 0) => {
      if (io) {
        io.emit('merge:progress', { stage, message, progress });
      }
      console.log(`[MERGE] ${stage}: ${message} (${progress}%)`);
    };

    if (!Array.isArray(files) || files.length < 2) {
      console.log('❌ Invalid files array:', files);
      return res.status(400).json({
        success: false,
        error: "Provide at least two files to merge (array of filenames)."
      });
    }

    emitProgress('validation', 'Validating files...', 5);

    // Basic validation – only allow .mp4 in VIDEOS_DIR
    const safeFiles = files.map(f => path.basename(f)); // strip any path
    if (!safeFiles.every(f => f.endsWith(".mp4"))) {
      return res.status(400).json({
        success: false,
        error: "All files must be .mp4"
      });
    }

    // Ensure all files exist
    for (const f of safeFiles) {
      const fullPath = path.join(VIDEOS_DIR, f);
      if (!fsSync.existsSync(fullPath)) {
        console.log(`❌ File not found: ${fullPath}`);
        return res.status(404).json({
          success: false,
          error: `File not found: ${f}`
        });
      }
    }

    emitProgress('preparation', 'Preparing merge...', 15);

    // Output name – defaults to timestamp if not provided
    const baseName =
      (outputName || `merged-${Date.now()}`).replace(/[^a-zA-Z0-9-_]/g, "_") +
      ".mp4";
    const outputPath = path.join(VIDEOS_DIR, baseName);

    // Create a temporary "list file" for ffmpeg concat demuxer
    tempListFile = path.join(
      VIDEOS_DIR,
      `.merge-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );

    const listFileContent = safeFiles
      .map(f => `file '${path.join(VIDEOS_DIR, f).replace(/'/g, "'\\''")}'`)
      .join("\n");

    await fs.writeFile(tempListFile, listFileContent, "utf8");
    console.log('📝 List file created:', tempListFile);

    emitProgress('merging', 'Merging video files...', 30);

    // Run ffmpeg concat with progress tracking
    await new Promise((resolve, reject) => {
      const command = ffmpeg()
        .input(tempListFile)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions([
          "-c copy",
          "-movflags", "+faststart"
        ])
        .on("start", (commandLine) => {
          console.log("🎬 FFmpeg command:", commandLine);
        })
        .on("stderr", (stderrLine) => {
          console.log("FFmpeg stderr:", stderrLine);
        })
        .on("error", (err, stdout, stderr) => {
          console.error("❌ ffmpeg merge error:", err.message);
          console.error("stdout:", stdout);
          console.error("stderr:", stderr);
          reject(err);
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            const mergeProgress = Math.min(30 + (progress.percent * 0.5), 80);
            emitProgress('merging', `Merging: ${Math.round(progress.percent)}%`, mergeProgress);
          }
        })
        .on("end", () => {
          console.log("✅ Merge completed:", outputPath);
          emitProgress('merging', 'Merge complete!', 80);
          resolve();
        })
        .save(outputPath);
    });

    // Clean up list file
    await fs.unlink(tempListFile).catch(() => {});
    tempListFile = null;

    let thumbnailGenerated = false;
    let deletedFiles = [];

    // Generate thumbnail if requested
    if (generateThumb) {
      try {
        emitProgress('thumbnail', 'Generating thumbnail...', 85);
        const thumbBasename = path.parse(baseName).name;
        const thumbPath = path.join(THUMB_DIR, `${thumbBasename}.jpg`);
        
        await generateThumbnail(outputPath, thumbPath);
        thumbnailGenerated = true;
        emitProgress('thumbnail', 'Thumbnail generated!', 90);
      } catch (thumbErr) {
        console.error("⚠️ Thumbnail generation failed (non-fatal):", thumbErr);
        // Don't fail the whole operation if thumbnail fails
      }
    }

    // Delete original files if requested
    if (deleteOriginals) {
      emitProgress('cleanup', 'Deleting original files...', 92);
      
      for (const f of safeFiles) {
        try {
          const videoPath = path.join(VIDEOS_DIR, f);
          const basename = path.parse(f).name;
          const thumbPath = path.join(THUMB_DIR, `${basename}.jpg`);

          // Delete video
          await fs.unlink(videoPath);
          deletedFiles.push(f);

          // Delete thumbnail if exists
          if (fsSync.existsSync(thumbPath)) {
            await fs.unlink(thumbPath);
            deletedFiles.push(`${basename}.jpg`);
          }

          console.log(`🗑️ Deleted: ${f}`);
        } catch (delErr) {
          console.error(`⚠️ Failed to delete ${f}:`, delErr);
        }
      }
      
      emitProgress('cleanup', `Deleted ${deletedFiles.length} files`, 95);
    }

    emitProgress('complete', 'Merge operation complete!', 100);

    res.json({
      success: true,
      mergedFilename: baseName,
      mergedPath: `/videos/${baseName}`,
      url: `/videos/${baseName}`,
      thumbnailGenerated,
      deletedFiles: deleteOriginals ? deletedFiles : []
    });
  } catch (err) {
    console.error("❌ /merge failed:", err);
    
    // Clean up temp file on error
    if (tempListFile) {
      await fs.unlink(tempListFile).catch(() => {});
    }

    const io = global.__io;
    if (io) {
      io.emit('merge:error', { error: err.message });
    }

    res.status(500).json({
      success: false,
      error: err.message || "Merge failed"
    });
  }
});

/**
 * POST /move
 * Move videos to a subfolder
 * Body: { files: string[], targetFolder: string }
 */
router.post("/move", async (req, res) => {
  try {
    const { files, targetFolder } = req.body;
    if (!files || !targetFolder) return res.status(400).json({ success: false, error: "Missing files or targetFolder" });

    // Format folder name safely
    const safeFolder = targetFolder.replace(/[^a-zA-Z0-9-_ ]/g, "").trim();
    const targetVideoPath = path.join(VIDEOS_DIR, safeFolder);
    
    // Create folder if it doesn't exist
    if (!fsSync.existsSync(targetVideoPath)) {
      await fs.mkdir(targetVideoPath, { recursive: true });
    }

    const moved = [];
    for (const filename of files) {
      const safeFilename = path.basename(filename);
      const oldVidPath = path.join(VIDEOS_DIR, safeFilename);
      const newVidPath = path.join(targetVideoPath, safeFilename);
      
      if (fsSync.existsSync(oldVidPath)) {
        await fs.rename(oldVidPath, newVidPath);
        moved.push(safeFilename);
      }
    }
    
    res.json({ success: true, moved, folder: safeFolder });
  } catch (err) {
    console.error("❌ /move failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /delete
 * Mass delete multiple video files and their thumbnails
 * 
 * Body: { files: string[] }
 * 
 * Example:
 *  { "files": ["video1.mp4", "video2.mp4", "video3.mp4"] }
 * 
 * Returns: { success: true, deleted: [...], failed: [...] }
 */
router.delete("/delete", async (req, res) => {
  try {
    console.log('🗑️ Delete request received:', req.body);
    
    const { files } = req.body || {};

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Provide an array of filenames to delete"
      });
    }

    const safeFiles = files.map(f => path.basename(f)); // strip any path
    const deleted = [];
    const failed = [];

    for (const filename of safeFiles) {
      try {
        const videoPath = path.join(VIDEOS_DIR, filename);
        const basename = path.parse(filename).name;
        const thumbPath = path.join(THUMB_DIR, `${basename}.jpg`);

        // Check if video exists
        if (!fsSync.existsSync(videoPath)) {
          failed.push({
            filename,
            reason: 'File not found'
          });
          continue;
        }

        // Delete video file
        await fs.unlink(videoPath);
        
        // Delete thumbnail if exists
        if (fsSync.existsSync(thumbPath)) {
          await fs.unlink(thumbPath);
        }

        deleted.push(filename);
        console.log(`✅ Deleted: ${filename}`);
      } catch (err) {
        console.error(`❌ Failed to delete ${filename}:`, err);
        failed.push({
          filename,
          reason: err.message
        });
      }
    }

    res.json({
      success: true,
      deleted,
      failed,
      deletedCount: deleted.length,
      failedCount: failed.length
    });
  } catch (err) {
    console.error("❌ /delete failed:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Delete operation failed"
    });
  }
});

export default router;
