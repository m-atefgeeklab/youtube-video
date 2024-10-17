require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(bodyParser.json());
app.use(cors());

// AWS S3 Client Setup
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.AWS_BUCKET_NAME;

// Utility function for executing shell commands
const execPromise = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, { shell: true }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Command failed with error: ${stderr || error.message}`);
        return reject(new Error(stderr || error.message));
      }
      resolve(stdout);
    });
  });
};

// Get video ID from YouTube URL
const getVideoId = (url) => {
  const match = url.match(/v=([^&]+)/);
  return match ? match[1] : "unknown";
};

// Check if the video is already cached
const isCached = (videoId) => {
  const cacheFilePath = path.join(__dirname, "cache", `${videoId}.cache`);
  if (fs.existsSync(cacheFilePath)) {
    const cachedData = fs.readFileSync(cacheFilePath, "utf-8");
    return cachedData ? cachedData : null;
  }
  return null;
};

// Cache the S3 key of the uploaded video
const cacheFile = (videoId, s3Key) => {
  const cacheDir = path.join(__dirname, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }
  const cacheFilePath = path.join(cacheDir, `${videoId}.cache`);
  fs.writeFileSync(cacheFilePath, s3Key);
  console.log(`Cached videoId: ${videoId} with S3 key: ${s3Key}`);
};

// Delete temporary files
const deleteTempFiles = (filePaths) => {
  return Promise.all(
    filePaths.map((filePath) => {
      return new Promise((resolve) => {
        if (fs.existsSync(filePath)) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Failed to delete file ${filePath}: ${err.message}`);
            } else {
              console.log(`Temporary file deleted: ${filePath}`);
            }
            resolve();
          });
        } else {
          resolve();
        }
      });
    })
  );
};

// Upload file to S3
const uploadToS3 = async (filePath, videoId, type) => {
  const extension = type === "video" ? ".mp4" : ".jpg";
  const s3Key = `youtubevideos/${videoId}_${Date.now()}${extension}`;
  const uploadParams = {
    Bucket: bucketName,
    Key: s3Key,
    Body: fs.createReadStream(filePath),
    ACL: "public-read",
  };
  await s3Client.send(new PutObjectCommand(uploadParams));
  console.log(`${type.charAt(0).toUpperCase() + type.slice(1)} uploaded to S3: ${s3Key}`);
  return s3Key;
};

// Download video, audio, and thumbnail, then upload to S3
const downloadAndUpload = async (url) => {
  const videoId = getVideoId(url);
  
  // Check if video is cached
  const cached = isCached(videoId);
  if (cached) {
    console.log(`Video already exists in S3 with key: ${cached}`);
    return cached;
  }

  const ytDlpPath = "/usr/local/bin/yt-dlp";
  const cookiesPath = path.join(__dirname, "youtube_cookies.txt");

  if (!fs.existsSync(cookiesPath)) {
    throw new Error(`Cookies file not found at: ${cookiesPath}`);
  }

  const videoFilePath = path.join(os.tmpdir(), `${videoId}_video.mp4`);
  const mergedFilePath = path.join(os.tmpdir(), `${videoId}_merged.mp4`);
  const thumbnailFilePath = path.join(os.tmpdir(), `${videoId}_thumbnail.jpg`);

  try {
    // Download video, audio, and thumbnail with yt-dlp
    const downloadCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f best --merge-output-format mp4 -o "${mergedFilePath}" --write-thumbnail --embed-thumbnail ${url}`;
    await execPromise(downloadCommand);

    // Upload video and thumbnail to S3
    const videoS3Key = await uploadToS3(mergedFilePath, videoId, "video");
    const thumbnailS3Key = fs.existsSync(thumbnailFilePath)
      ? await uploadToS3(thumbnailFilePath, videoId, "thumbnail")
      : null;

    // Cache the S3 video key
    cacheFile(videoId, videoS3Key);

    // Cleanup temporary files
    await deleteTempFiles([videoFilePath, mergedFilePath, thumbnailFilePath]);

    return { videoS3Key, thumbnailS3Key };

  } catch (error) {
    await deleteTempFiles([videoFilePath, mergedFilePath, thumbnailFilePath]);
    throw new Error(`Failed to download and upload: ${error.message}`);
  }
};

// API route to download and upload a YouTube video
app.post("/download-video", async (req, res) => {
  const { youtubeVideoUrl } = req.body;

  if (!youtubeVideoUrl) {
    return res.status(400).json({ error: "YouTube video URL is required" });
  }

  try {
    const { videoS3Key, thumbnailS3Key } = await downloadAndUpload(youtubeVideoUrl);
    res.status(200).json({
      message: "Video and thumbnail successfully uploaded to S3",
      video_url: `https://${bucketName}.s3.amazonaws.com/${videoS3Key}`,
      thumbnail_url: thumbnailS3Key
        ? `https://${bucketName}.s3.amazonaws.com/${thumbnailS3Key}`
        : null,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to process video", details: error.message });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
