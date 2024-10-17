require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
// const { refreshYouTubeCookies } = require("./updateCookies");

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

// Check cache before downloading
const isCached = (videoId) => {
  const cacheFilePath = path.join(__dirname, "cache", `${videoId}.cache`);

  if (fs.existsSync(cacheFilePath)) {
    const cachedData = fs.readFileSync(cacheFilePath, "utf-8");
    return cachedData ? cachedData : null;
  }

  return null;
};

// Function to cache only the videoId with the S3 key
const cacheFile = (videoId, s3Key) => {
  const cacheDir = path.join(__dirname, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }

  const cacheFilePath = path.join(cacheDir, `${videoId}.cache`);
  fs.writeFileSync(cacheFilePath, s3Key); // Store only the s3Key
  console.log(`Cached videoId: ${videoId} with S3 key: ${s3Key}`);
};

// Function to delete temporary files
const deleteTempFiles = (filePaths) => {
  return Promise.all(
    filePaths.map((filePath) => {
      return new Promise((resolve) => {
        if (fs.existsSync(filePath)) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(
                `Failed to delete file ${filePath}: ${err.message}`
              );
            } else {
              console.log(`Temporary file deleted: ${filePath}`);
            }
            resolve(); // Resolve the promise after attempting to delete
          });
        } else {
          resolve(); // Resolve immediately if file doesn't exist
        }
      });
    })
  );
};

const execPromise = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, { shell: true }, (error, stdout, stderr) => {
      if (error) {
        // Log the error and exit code
        console.error(
          `Command failed with exit code ${error.code}: ${
            stderr || error.message
          }`
        );
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

// Updated function for downloading and uploading
const downloadAndUpload = async (url, retries = 3) => {
  const videoId = getVideoId(url);

  const cached = isCached(videoId);
  if (cached) {
    console.log(`Video with S3 key: ${cached} already exists.`);
    return { s3Key: cached };
  }

  return retry(async () => {
    const videoFilePath = path.join(os.tmpdir(), `${videoId}_video.mp4`);
    const audioFilePath = path.join(os.tmpdir(), `${videoId}_audio.mp3`);
    const mergedFilePath = path.join(os.tmpdir(), `${videoId}_merged.mp4`);
    
    // Temporary directory for thumbnails
    const thumbnailFilePath = path.join(os.tmpdir(), `${videoId}.jpg`);

    try {
      console.log(`========== Start downloading video ${videoId}... ==========`);

      const ytDlpPath = "/usr/local/bin/yt-dlp";
      const cookiesPath = path.join(__dirname, "youtube_cookies.txt");

      if (!fs.existsSync(cookiesPath)) {
        throw new Error(`Cookies file not found at: ${cookiesPath}`);
      }

      // Step to get video title
      const getTitleCommand = `"${ytDlpPath}" --get-title --cookies "${cookiesPath}" ${url}`;
      const videoTitle = (await execPromise(getTitleCommand)).trim();

      // Download best video and best audio separately using yt-dlp
      const videoCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo -o "${videoFilePath}" --add-metadata --write-description --embed-thumbnail --write-thumbnail --convert-thumbnails jpg ${url}`;
      const audioCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestaudio -o "${audioFilePath}" ${url}`;

      await execPromise(videoCommand);
      await execPromise(audioCommand);

      if (!fs.existsSync(videoFilePath) || !fs.existsSync(audioFilePath)) {
        throw new Error("Downloaded video or audio file not found");
      }

      // Merge video and audio files using ffmpeg
      const mergeCommand = `ffmpeg -i "${videoFilePath}" -i "${audioFilePath}" -c:v copy -c:a aac "${mergedFilePath}"`;
      await execPromise(mergeCommand);

      // Upload the merged video to S3
      const s3Key = await uploadToS3(
        mergedFilePath,
        `youtubevideos/${videoId}_${Date.now()}.mp4`
      );
      cacheFile(videoId, s3Key);

      let thumbnailS3Key = null;

      // Check if the thumbnail was downloaded and exists
      if (fs.existsSync(thumbnailFilePath)) {
        console.log(`Uploading thumbnail from ${thumbnailFilePath}`);
        thumbnailS3Key = await uploadToS3(
          thumbnailFilePath,
          `youtubevideos/${videoId}_thumbnail.${Date.now()}.jpg`
        );
        console.log(`Thumbnail uploaded: ${thumbnailS3Key}`);
      } else {
        console.log("No thumbnail found in supported formats for this video.");
      }

      // Clean up temporary files
      await deleteTempFiles([
        videoFilePath,
        audioFilePath,
        mergedFilePath,
        thumbnailFilePath,
      ]);

      console.log(`========== Finished all processing for video ${videoId} ==========`);

      return { s3Key, thumbnailS3Key, videoTitle };
    } catch (error) {
      await deleteTempFiles([
        videoFilePath,
        audioFilePath,
        mergedFilePath,
        thumbnailFilePath,
      ]);
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
    const { s3Key, thumbnailS3Key, videoTitle } = await downloadAndUpload(
      youtubeVideoUrl
    );
    res.status(200).json({
      message: "Video and thumbnail successfully uploaded to S3",
      video_url: `https://${bucketName}.s3.amazonaws.com/${s3Key}`,
      video_title: videoTitle,
      thumbnail_url: thumbnailS3Key
        ? `https://${bucketName}.s3.amazonaws.com/${thumbnailS3Key}`
        : null,
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
