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

// Define the S3 bucket name
const bucketName = process.env.AWS_BUCKET_NAME;

// Function to extract video ID from URL
const getVideoId = (url) => {
  const match = url.match(/v=([^&]+)/);
  return match ? match[1] : "unknown";
};

// Function to retry a process 
const retryUntilSuccess = async (fn) => {
  while (true) {
    try {
      return await fn();
    } catch (error) {
      console.error("Error occurred, retrying...", error.message);
    }
  }
};

// Function to download video and audio separately and merge using ffmpeg
const downloadAndUpload = async (url) => {
  return retryUntilSuccess(async () => {
    const videoId = getVideoId(url);
    const videoFilePath = path.join(
      os.tmpdir(),
      `${videoId}_video_${new Date().getTime()}.mp4`
    );
    const audioFilePath = path.join(
      os.tmpdir(),
      `${videoId}_audio_${new Date().getTime()}.mp3`
    );
    const mergedFilePath = path.join(
      os.tmpdir(),
      `${videoId}_merged_${new Date().getTime()}.mp4`
    );
    const s3Key = `youtubevideos/${videoId}_${new Date().getTime()}.mp4`;
    const ytDlpPath = "/usr/local/bin/yt-dlp";
    const cookiesPath = path.join(__dirname, "youtube_cookies.txt");

    // Ensure cookies file exists
    if (!fs.existsSync(cookiesPath)) {
      throw new Error(`Cookies file not found at: ${cookiesPath}`);
    }

    // yt-dlp commands to download best video and best audio separately
    const videoCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo -o "${videoFilePath}" ${url}`;
    const audioCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestaudio -o "${audioFilePath}" ${url}`;

    // Execute video download
    await new Promise((resolve, reject) => {
      const downloadVideo = exec(videoCommand, { shell: true });
      downloadVideo.on("exit", (code) => {
        if (code !== 0) {
          return reject(new Error("Video download failed"));
        }
        resolve();
      });
    });

    // Execute audio download
    await new Promise((resolve, reject) => {
      const downloadAudio = exec(audioCommand, { shell: true });
      downloadAudio.on("exit", (code) => {
        if (code !== 0) {
          return reject(new Error("Audio download failed"));
        }
        resolve();
      });
    });

    // Check if both video and audio files exist
    if (!fs.existsSync(videoFilePath) || !fs.existsSync(audioFilePath)) {
      throw new Error("Downloaded video or audio file not found");
    }

    // Merge video and audio using ffmpeg
    const mergeCommand = `ffmpeg -i "${videoFilePath}" -i "${audioFilePath}" -c:v copy -c:a aac -strict experimental "${mergedFilePath}"`;

    await new Promise((resolve, reject) => {
      const mergeProcess = exec(mergeCommand, { shell: true });
      mergeProcess.on("exit", (code) => {
        if (code !== 0) {
          return reject(new Error("Merging video and audio failed"));
        }
        resolve();
      });
    });

    // Check if the merged file exists before upload
    if (!fs.existsSync(mergedFilePath)) {
      throw new Error("Merged file not found");
    }

    // Upload the merged file to S3
    const uploadParams = {
      Bucket: bucketName,
      Key: s3Key,
      Body: fs.createReadStream(mergedFilePath),
      ACL: "public-read-write",
    };

    await s3Client.send(new PutObjectCommand(uploadParams));

    console.log(`Video uploaded to S3: ${s3Key}`);
    return s3Key;
  });
};

// Define the API endpoint
app.post("/download-video", async (req, res) => {
  const { youtubeVideoUrl } = req.body;

  if (!youtubeVideoUrl) {
    return res.status(400).json({ error: "YouTube video URL is required" });
  }

  try {
    const s3Key = await downloadAndUpload(youtubeVideoUrl);
    res
      .status(200)
      .json({ message: "Video successfully uploaded to S3", video_url: `https://${bucketName}.s3.amazonaws.com/${s3Key}` });
  } catch (error) {
    res.status(500).json({
      error: "Failed to download and upload video",
      details: error.message,
    });
  }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
