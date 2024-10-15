require("dotenv").config();
const { exec } = require("child_process");
const { PassThrough } = require("stream");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

// Initialize Express app
const app = express();
app.use(bodyParser.json());
app.use(cors());

// AWS S3 Client configuration
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Define the S3 bucket name
const bucketName = process.env.AWS_BUCKET_NAME;

// Function to extract video ID from YouTube URL
const getVideoId = (url) => {
  const match = url.match(/v=([^&]+)/);
  return match ? match[1] : "unknown";
};

// Function to download video from YouTube and stream it directly to S3
const downloadAndStreamToS3 = async (url) => {
  return new Promise((resolve, reject) => {
    const videoId = getVideoId(url);
    const s3Key = `youtubevideos/${videoId}_${new Date().getTime()}.mp4`;
    const ytDlpPath = "/usr/local/bin/yt-dlp";
    const cookiesPath = path.join(__dirname, "new_cookies.txt");

    // Ensure cookies file exists
    if (!require("fs").existsSync(cookiesPath)) {
      return reject(new Error(`Cookies file not found at: ${cookiesPath}`));
    }

    // Create a PassThrough stream to handle piping data to S3
    const passThrough = new PassThrough();

    // Command to download video using yt-dlp and stream the output
    const command = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo*+bestaudio/best -o - ${url}`; // `-o -` streams to stdout

    const child = exec(command, { shell: true });

    // Pipe the yt-dlp output (video stream) to the PassThrough stream
    child.stdout.pipe(passThrough);

    // Handle yt-dlp errors
    child.stderr.on("data", (error) => {
      console.error(`Error: ${error}`);
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        return reject(new Error("Failed to download video"));
      }
    });

    // Upload the video stream to S3
    const uploadParams = {
      Bucket: bucketName,
      Key: s3Key,
      Body: passThrough,
      ACL: "public-read-write",
    };

    s3Client
      .send(new PutObjectCommand(uploadParams))
      .then(() => {
        console.log(`Video uploaded to S3: ${s3Key}`);
        resolve(s3Key);
      })
      .catch((err) => {
        console.error("Failed to upload video to S3", err);
        reject(err);
      });
  });
};

// Define the API endpoint
app.post("/download-video", async (req, res) => {
  const { youtubeVideoUrl } = req.body;

  if (!youtubeVideoUrl) {
    return res.status(400).json({ error: "YouTube video URL is required" });
  }

  try {
    const s3Key = await downloadAndStreamToS3(youtubeVideoUrl);
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
