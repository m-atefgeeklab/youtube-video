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

// Function to download a YouTube video using yt-dlp and upload to S3
const downloadAndUpload = async (url, retries = 3) => {
  return retry(async () => {
    const videoId = getVideoId(url);
    const tempFilePath = path.join(
      os.tmpdir(),
      `${videoId}_${new Date().getTime()}.mp4`
    );
    const s3Key = `youtubevideos/${videoId}_${new Date().getTime()}.mp4`;
    const ytDlpPath = "/usr/local/bin/yt-dlp";
    const cookiesPath = path.join(__dirname, "new_cookies.txt");

    // Ensure cookies file exists
    if (!fs.existsSync(cookiesPath)) {
      throw new Error(`Cookies file not found at: ${cookiesPath}`);
    }

    // Command to download video using yt-dlp with cookies
    const command = `"${ytDlpPath}" --cookies "${cookiesPath}" -f b* -o "${tempFilePath}" ${url}`;

    return new Promise((resolve, reject) => {
      const child = exec(command, { shell: true });

      child.stderr.on("data", (error) => {
        console.error(`Error: ${error}`);
      });

      child.on("exit", async (code) => {
        if (code !== 0) {
          console.error("Failed to download video");
          return reject(new Error("Download failed"));
        }

        try {
          const uploadParams = {
            Bucket: bucketName,
            Key: s3Key,
            Body: fs.createReadStream(tempFilePath),
            ACL: "public-read-write",
          };

          await s3Client.send(new PutObjectCommand(uploadParams));
          console.log(`Video uploaded to S3: ${s3Key}`);
          resolve(s3Key);
        } catch (err) {
          console.error("Failed to upload video to S3", err);
          reject(err);
        } finally {
          fs.unlink(tempFilePath, (err) => {
            if (err) console.error("Failed to delete temp file", err);
          });
        }
      });
    });
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
      .json({ message: "Video successfully uploaded to S3", videoUrl: `https://juice-box-my-uploads.s3.amazonaws.com/${s3Key}` });
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
