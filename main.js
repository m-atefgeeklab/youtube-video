require("dotenv").config();
const path = require("path");
const { exec } = require("child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { PassThrough } = require("stream");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

// Initialize Express app
const app = express();
app.use(bodyParser.json());
app.use(cors());

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

// Function to download a YouTube video and stream it directly to S3
const downloadAndStreamToS3 = async (url) => {
  return retry(async () => {
    const videoId = getVideoId(url);
    const s3Key = `youtubevideos/${videoId}_${new Date().getTime()}.mp4`;
    const ytDlpPath = "/usr/local/bin/yt-dlp";
    const cookiesPath = path.join(__dirname, "new_cookies.txt");

    // Ensure cookies file exists
    if (!fs.existsSync(cookiesPath)) {
      throw new Error(`Cookies file not found at: ${cookiesPath}`);
    }

    // Create a PassThrough stream to handle piping data to S3
    const passThrough = new PassThrough();

    // Set up S3 upload parameters
    const uploadParams = {
      Bucket: bucketName,
      Key: s3Key,
      Body: passThrough, // Pipe directly into this stream
      ACL: "public-read-write",
    };

    // Command to download video using yt-dlp with cookies and best quality
    const command = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo*+bestaudio/best -o - ${url}`; // `-o -` streams to stdout

    // Execute the command and pipe the output to S3
    const child = exec(command, { shell: true });

    // Pipe the output from yt-dlp directly into the S3 stream
    child.stdout.pipe(passThrough);

    // Monitor the process for completion
    return new Promise((resolve, reject) => {
      child.stderr.on("data", (error) => {
        console.error(`Error: ${error}`);
      });

      child.on("exit", (code) => {
        if (code !== 0) {
          console.error("Failed to download video");
          return reject(new Error("Download failed"));
        }
      });

      // Start S3 upload stream
      s3Client
        .send(new PutObjectCommand(uploadParams))
        .then(() => {
          console.log(`Video successfully uploaded to S3: ${s3Key}`);
          resolve(s3Key);
        })
        .catch((err) => {
          console.error("Failed to upload video to S3", err);
          reject(err);
        });
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
