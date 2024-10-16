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

// Function to retry a process a few times
const retry = async (fn, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
    }
  }
};

const executeCommand = (command) => {
  return new Promise((resolve, reject) => {
    const child = exec(command, { shell: true });
    child.on("error", (err) => reject(new Error(`Error running command: ${err.message}`)));
    child.on("exit", (code) => {
      if (code !== 0) {
        return reject(new Error("Command execution failed"));
      }
      resolve();
    });
  });
};

// Function to download video and audio separately and merge using ffmpeg
const downloadAndUpload = async (url, retries = 3) => {
  return retry(async () => {
    try {
      const videoId = getVideoId(url);
      const videoFilePath = path.join(os.tmpdir(), `${videoId}_video_${new Date().getTime()}.mp4`);
      const audioFilePath = path.join(os.tmpdir(), `${videoId}_audio_${new Date().getTime()}.mp3`);
      const mergedFilePath = path.join(os.tmpdir(), `${videoId}_merged_${new Date().getTime()}.mp4`);
      const s3Key = `youtubevideos/${videoId}_${new Date().getTime()}.mp4`;
      const ytDlpPath = "/usr/local/bin/yt-dlp";
      const cookiesPath = path.join(__dirname, "youtube_cookies.txt");

      if (!fs.existsSync(cookiesPath)) {
        throw new Error(`Cookies file not found at: ${cookiesPath}`);
      }

      const videoCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo -o "${videoFilePath}" ${url}`;
      const audioCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestaudio -o "${audioFilePath}" ${url}`;

      await executeCommand(videoCommand);
      await executeCommand(audioCommand);

      if (!fs.existsSync(videoFilePath) || !fs.existsSync(audioFilePath)) {
        throw new Error("Downloaded video or audio file not found");
      }

      const mergeCommand = `ffmpeg -i "${videoFilePath}" -i "${audioFilePath}" -c:v copy -c:a aac -strict experimental "${mergedFilePath}"`;
      await executeCommand(mergeCommand);

      if (!fs.existsSync(mergedFilePath)) {
        throw new Error("Merged file not found");
      }

      const uploadParams = {
        Bucket: bucketName,
        Key: s3Key,
        Body: fs.createReadStream(mergedFilePath),
        ACL: "public-read-write",
      };

      await s3Client.send(new PutObjectCommand(uploadParams));
      console.log(`Video uploaded to S3: ${s3Key}`);

      // Cleanup: delete temporary files
      const deleteTempFiles = (filePaths) => {
        filePaths.forEach((filePath) => {
          if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
              if (err) console.error(`Failed to delete temp file: ${filePath}`, err);
            });
          }
        });
      };

      deleteTempFiles([videoFilePath, audioFilePath, mergedFilePath]);
      return s3Key;

    } catch (error) {
      console.error(`Error in downloadAndUpload: ${error.message}`);
      throw error;
    }
  }, retries);
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
      .json({
        message: "Video successfully uploaded to S3",
        video_url: `https://${bucketName}.s3.amazonaws.com/${s3Key}`,
      });
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
