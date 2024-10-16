require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

// Initialize Express app
const app = express();
app.use(bodyParser.json());
app.use(cors());

// Define the root route
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// Configure AWS SDK
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Define constants
const bucketName = process.env.AWS_BUCKET_NAME;
const ytDlpPath = "/usr/local/bin/yt-dlp";
const cookiesFilePath = path.join(__dirname, "youtube_cookies.txt");

// Utility: Log message with timestamp
const logMessage = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

// Utility: Function to extract video ID from URL
const getVideoId = (url) => {
  const match = url.match(/v=([^&]+)/);
  return match ? match[1] : "unknown";
};

// Utility: Retry logic for async functions
const retry = async (fn, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
    }
  }
};

// Utility: Run shell command and handle errors
const runCommand = (command) => {
  return new Promise((resolve, reject) => {
    const process = exec(command, { shell: true });
    process.on("error", (err) => reject(new Error(`Error running command: ${err.message}`)));
    process.on("exit", (code) => {
      if (code !== 0) {
        return reject(new Error("Command failed"));
      }
      resolve();
    });
  });
};

// Utility: Check if file exists
const fileExists = (filePath) => fs.existsSync(filePath);

// Main: Download and merge video/audio, upload to S3
const downloadAndUpload = async (url) => {
  return retry(async () => {
    const videoId = getVideoId(url);
    const timestamp = new Date().getTime();
    const videoFilePath = path.join(os.tmpdir(), `${videoId}_video_${timestamp}.mp4`);
    const audioFilePath = path.join(os.tmpdir(), `${videoId}_audio_${timestamp}.mp3`);
    const mergedFilePath = path.join(os.tmpdir(), `${videoId}_merged_${timestamp}.mp4`);
    const s3Key = `youtubevideos/${videoId}_${timestamp}.mp4`;

    // Ensure cookies file exists
    if (!fileExists(cookiesFilePath)) {
      throw new Error(`Cookies file not found at: ${cookiesFilePath}`);
    }

    // Download best video and best audio separately using yt-dlp
    await runCommand(`"${ytDlpPath}" --cookies "${cookiesFilePath}" -f bestvideo -o "${videoFilePath}" ${url}`);
    await runCommand(`"${ytDlpPath}" --cookies "${cookiesFilePath}" -f bestaudio -o "${audioFilePath}" ${url}`);

    // Check if both video and audio files exist
    if (!fileExists(videoFilePath) || !fileExists(audioFilePath)) {
      throw new Error("Downloaded video or audio file not found");
    }

    // Merge video and audio using ffmpeg
    await runCommand(`ffmpeg -i "${videoFilePath}" -i "${audioFilePath}" -c:v copy -c:a aac -strict experimental "${mergedFilePath}"`);

    // Check if the merged file exists
    if (!fileExists(mergedFilePath)) {
      throw new Error("Merged file not found");
    }

    // Upload the merged file to S3
    const uploadParams = {
      Bucket: bucketName,
      Key: s3Key,
      Body: fs.createReadStream(mergedFilePath),
      ACL: "public-read",
    };

    await s3Client.send(new PutObjectCommand(uploadParams));
    logMessage(`Video uploaded to S3: ${s3Key}`);
    return s3Key;
  });
};

// Utility: Clean up temporary files
const cleanUpTempFiles = (files) => {
  files.forEach((file) => {
    if (fileExists(file)) {
      fs.unlinkSync(file);
      logMessage(`Temporary file deleted: ${file}`);
    }
  });
};

// Utility: Update cookies expiration date
const updateCookiesExpiration = (filePath, extensionTimeInSeconds = 31536000) => {
  const currentTime = Math.floor(Date.now() / 1000); // current time in seconds since epoch
  const fileData = fs.readFileSync(filePath, "utf-8");

  const updatedData = fileData.split("\n").map((line) => {
    const parts = line.split("\t");
    if (parts.length > 4 && !isNaN(parts[4])) {
      const expirationTime = parseInt(parts[4], 10);
      if (expirationTime < currentTime + 2592000) { // Extend by 30 days
        parts[4] = (currentTime + extensionTimeInSeconds).toString();
        logMessage(`Updated expiration for: ${parts[5]}`);
      }
    }
    return parts.join("\t");
  }).join("\n");

  fs.writeFileSync(filePath, updatedData, "utf-8");
  logMessage("Cookies expiration updated successfully.");
};

// Update cookies before any request
updateCookiesExpiration(cookiesFilePath);

// API: Download and upload YouTube video
app.post("/download-video", async (req, res) => {
  const { youtubeVideoUrl } = req.body;
  if (!youtubeVideoUrl) {
    return res.status(400).json({ error: "YouTube video URL is required" });
  }

  try {
    const s3Key = await downloadAndUpload(youtubeVideoUrl);
    res.status(200).json({ message: "Video successfully uploaded to S3", video_url: `https://${bucketName}.s3.amazonaws.com/${s3Key}` });
  } catch (error) {
    res.status(500).json({ error: "Failed to download and upload video", details: error.message });
  }
});

// Graceful shutdown and cleanup
const gracefulShutdown = () => {
  logMessage("Shutting down gracefully...");
  cleanUpTempFiles([/* Add file paths here */]);
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  logMessage(`Server running on port ${port}`);
});
