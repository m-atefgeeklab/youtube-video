const { exec } = require("child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config();

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

// Function to download a YouTube video using yt-dlp and upload to S3
const downloadAndUpload = async (url) => {
  return new Promise((resolve, reject) => {
    try {
      const videoId = getVideoId(url);
      const tempFilePath = path.join(
        os.tmpdir(),
        `${videoId}_${new Date().getTime()}.mp4`
      );
      const s3Key = `youtubevideos/${videoId}_${new Date().getTime()}.mp4`;

      // Path to yt-dlp on EC2
      const ytDlpPath = "/usr/local/bin/yt-dlp";

      // Path to cookies.txt in the project root directory
      const cookiesPath = "/cookies.txt";

      // Ensure cookies file exists
      if (!fs.existsSync(cookiesPath)) {
        return reject(new Error(`Cookies file not found at: ${cookiesPath}`));
      }

      // Command to download video using yt-dlp with cookies
      const command = `"${ytDlpPath}" --cookies "${cookiesPath}" -f b -o "${tempFilePath}" ${url}`;

      // Execute the yt-dlp command
      const child = exec(command, { shell: true });

      // Handle standard error
      child.stderr.on("data", (error) => {
        console.error(`Error: ${error}`);
      });

      // Handle process exit
      child.on("exit", async (code) => {
        if (code !== 0) {
          console.error("Failed to download video");
          return reject(new Error("Download failed"));
        }

        // Video downloaded successfully
        console.log(`Video downloaded to: ${tempFilePath}`);

        // Upload to S3
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
          // Cleanup temporary file
          fs.unlink(tempFilePath, (err) => {
            if (err) {
              console.error("Failed to delete temp file", err);
            }
          });
        }
      });
    } catch (error) {
      reject(error);
    }
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
      .json({ message: "Video successfully uploaded to S3", s3Key });
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
