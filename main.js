require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { console } = require("inspector");

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Define the root route
app.get("/", (req, res) => {
  res.send("Hello World!");
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.AWS_BUCKET_NAME;

const getVideoId = (url) => {
  const match = url.match(/v=([^&]+)/);
  return match ? match[1] : "unknown";
};

// Retry function with timeout and retries
const retry = async (fn, retries = 3, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`Error attempt ${i + 1} failed: ${error.message}`);
      if (i === retries - 1) throw error;
      // Wait for a delay before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Check cache before downloading
const isCached = (videoId) => {
  const cacheFilePath = path.join(__dirname, "cache", `${videoId}.mp4`);
  const s3KeyFilePath = path.join(__dirname, "cache", `${videoId}.json`);

  if (fs.existsSync(cacheFilePath) && fs.existsSync(s3KeyFilePath)) {
    const { s3Key } = JSON.parse(fs.readFileSync(s3KeyFilePath));
    return { cacheFilePath, s3Key };
  }

  return null;
};

// Function to delete temporary files
const deleteTempFiles = (filePaths) => {
  filePaths.forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`Failed to delete file ${filePath}: ${err.message}`);
        } else {
          console.log(`Temporary file deleted: ${filePath}`);
        }
      });
    }
  });
};

// Update the downloadAndUpload function to use the returned s3Key
const downloadAndUpload = async (url, retries = 3) => {
  const videoId = getVideoId(url);

  const cached = isCached(videoId);
  if (cached) {
    console.log(`Video ${videoId} found in cache. Skipping download.`);
    return cached.s3Key; // Return the existing S3 key
  }

  return retry(async () => {
    const videoFilePath = path.join(os.tmpdir(), `${videoId}_video.mp4`);
    const audioFilePath = path.join(os.tmpdir(), `${videoId}_audio.mp3`);
    const mergedFilePath = path.join(os.tmpdir(), `${videoId}_merged.mp4`);

    try {
      console.log(
        `========== Start processing of downloading video ${videoId}... ==========`
      );

      const ytDlpPath = "/usr/local/bin/yt-dlp";
      const cookiesPath = path.join(__dirname, "youtube_cookies.txt");

      if (!fs.existsSync(cookiesPath)) {
        throw new Error(`Cookies file not found at: ${cookiesPath}`);
      }

      const videoCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo -o "${videoFilePath}" ${url}`;
      const audioCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestaudio -o "${audioFilePath}" ${url}`;

      await execPromise(videoCommand);
      await execPromise(audioCommand);

      if (!fs.existsSync(videoFilePath) || !fs.existsSync(audioFilePath)) {
        throw new Error("Downloaded video or audio file not found");
      }

      const mergeCommand = `ffmpeg -i "${videoFilePath}" -i "${audioFilePath}" -c:v copy -c:a aac -strict experimental "${mergedFilePath}"`;
      await execPromise(mergeCommand);

      if (!fs.existsSync(mergedFilePath)) {
        throw new Error("Merged file not found");
      }

      const s3Key = await uploadToS3(mergedFilePath, videoId);
      cacheFile(mergedFilePath, videoId, s3Key);

      // console.log(`Video successfully uploaded to S3: ${videoId}`);

      // Clean up temporary files after upload
      deleteTempFiles([videoFilePath, audioFilePath, mergedFilePath]);

      console.log(
        `========== Finished processing of downloading video ${videoId} ==========`
      );

      return s3Key; // Return the s3Key
    } catch (error) {
      // Clean up temporary files in case of an error
      deleteTempFiles([videoFilePath, audioFilePath, mergedFilePath]);

      console.error(`Error in downloadAndUpload: ${error.message}`);
      throw error; // Rethrow to trigger retry
    }
  }, retries);
};

// Function to run shell commands with a promise
const execPromise = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, { shell: true }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve(stdout);
    });
  });
};

// Function to upload to S3
const uploadToS3 = async (filePath, videoId) => {
  const s3Key = `youtubevideos/${videoId}_${Date.now()}.mp4`;
  const uploadParams = {
    Bucket: bucketName,
    Key: s3Key,
    Body: fs.createReadStream(filePath),
    ACL: "public-read-write",
  };

  await s3Client.send(new PutObjectCommand(uploadParams));
  console.log(`Video uploaded to S3: ${s3Key}`);
  return s3Key; // Return the s3Key
};

// Function to cache a file along with its S3 key
const cacheFile = (filePath, videoId, s3Key) => {
  const cacheDir = path.join(__dirname, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }

  const cacheFilePath = path.join(cacheDir, `${videoId}.mp4`);
  const s3KeyFilePath = path.join(cacheDir, `${videoId}.json`); // Store S3 key

  fs.copyFileSync(filePath, cacheFilePath);
  fs.writeFileSync(s3KeyFilePath, JSON.stringify({ s3Key })); // Save S3 key
  console.log(`Cached video at ${cacheFilePath} with S3 key ${s3Key}`);
};

// Define the API endpoint
app.post("/download-video", async (req, res) => {
  const { youtubeVideoUrl } = req.body;

  if (!youtubeVideoUrl) {
    return res.status(400).json({ error: "YouTube video URL is required" });
  }

  try {
    const s3Key = await downloadAndUpload(youtubeVideoUrl);
    res.status(200).json({
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
