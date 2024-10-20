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

const sanitizeTitle = (title) => {
  return title.replace(/[<>:"\/\\|?*]+/g, "").trim();
};

const isCached = (videoId) => {
  const cacheFilePath = path.join(__dirname, "cache", `${videoId}.cache`);

  if (fs.existsSync(cacheFilePath)) {
    const cachedData = JSON.parse(fs.readFileSync(cacheFilePath, "utf-8"));
    return cachedData ? cachedData : null;
  }

  return null;
};

const cacheFile = (videoId, s3Key, videoTitle) => {
  const cacheDir = path.join(__dirname, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }

  const cacheData = {
    s3Key,
    videoTitle,
  };

  fs.writeFileSync(
    path.join(cacheDir, `${videoId}.cache`),
    JSON.stringify(cacheData)
  );
};

const execPromise = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, { shell: true }, (error, stdout, stderr) => {
      if (error) {
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

// Upload to S3 function
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

// Trim video function
const trimVideo = async (inputFilePath, outputFilePath, timeFrom, timeEnd) => {
  const trimCommand = `ffmpeg -i "${inputFilePath}" -ss ${
    timeFrom / 1000
  } -to ${timeEnd / 1000} -c copy "${outputFilePath}"`;
  console.log(`Trimming video from ${timeFrom}ms to ${timeEnd}ms`);
  await execPromise(trimCommand);

  if (!fs.existsSync(outputFilePath)) {
    throw new Error("Trimmed file not found");
  }
  console.log("Trimmed video successfully.");
  return outputFilePath;
};

// Updated function for downloading, trimming, and uploading
const downloadTrimAndUpload = async (url, timeFrom, timeEnd, retries = 3) => {
  const videoId = getVideoId(url);

  const cached = isCached(videoId);
  if (cached) {
    console.log(`Video with S3 key: ${cached.s3Key} already exists.`);
    console.log(`============ Skipping download and upload... ============`);
    return { s3Key: cached.s3Key, videoTitle: cached.videoTitle };
  }

  return retry(async () => {
    const videoFilePath = path.join(os.tmpdir(), `${videoId}_video.mp4`);
    const audioFilePath = path.join(os.tmpdir(), `${videoId}_audio.mp3`);
    const mergedFilePath = path.join(os.tmpdir(), `${videoId}_merged.mp4`);
    const trimmedFilePath = path.join(os.tmpdir(), `${videoId}_trimmed.mp4`);

    try {
      console.log(
        `========== Start downloading video ${videoId}... ==========`
      );

      const ytDlpPath = "/usr/local/bin/yt-dlp";
      const cookiesPath = path.join(__dirname, "youtube_cookies.txt");

      if (!fs.existsSync(cookiesPath)) {
        throw new Error(`Cookies file not found at: ${cookiesPath}`);
      }

      // Get video title
      const getTitleCommand = `"${ytDlpPath}" --get-title --cookies "${cookiesPath}" ${url}`;
      let videoTitle = (await execPromise(getTitleCommand)).trim();
      videoTitle = sanitizeTitle(videoTitle); // Sanitize the video title

      const videoCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo -o "${videoFilePath}" ${url}`;
      const audioCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestaudio -o "${audioFilePath}" ${url}`;

      await execPromise(videoCommand);
      await execPromise(audioCommand);

      if (!fs.existsSync(videoFilePath) || !fs.existsSync(audioFilePath)) {
        throw new Error("Downloaded video or audio file not found");
      }

      // Merge video and audio
      const mergeCommand = `ffmpeg -i "${videoFilePath}" -i "${audioFilePath}" -c:v copy -c:a aac -strict experimental "${mergedFilePath}"`;
      await execPromise(mergeCommand);

      if (!fs.existsSync(mergedFilePath)) {
        throw new Error("Merged file not found");
      }

      // Trim the merged video
      await trimVideo(mergedFilePath, trimmedFilePath, timeFrom, timeEnd);

      // Upload the trimmed video to S3
      const s3Key = await uploadToS3(trimmedFilePath, videoId);

      cacheFile(videoId, s3Key, videoTitle);

      // Clean up temporary files
      await deleteTempFiles([
        videoFilePath,
        audioFilePath,
        mergedFilePath,
        trimmedFilePath,
      ]);

      console.log(
        `========== Finished downloading, trimming, and uploading video ${videoId} ==========`
      );

      return { s3Key, videoTitle };
    } catch (error) {
      await deleteTempFiles([
        videoFilePath,
        audioFilePath,
        mergedFilePath,
        trimmedFilePath,
      ]);

      console.error(`Error in downloadTrimAndUpload: ${error.message}`);
      throw error; // Rethrow to trigger retry
    }
  }, retries);
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
            resolve();
          });
        } else {
          resolve();
        }
      });
    })
  );
};

// Function to delete files in the /tmp/ folder
const cleanTmpFolder = () => {
  return new Promise((resolve, reject) => {
    const command = "sudo rm -f /tmp/*";

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(
          `Error deleting files in /tmp/: ${stderr || error.message}`
        );
        return reject(new Error(stderr || error.message));
      }
      console.log(`All files in /tmp/ have been successfully deleted`);
      resolve(stdout);
    });
  });
};

// API endpoint to download, trim, and upload the video
app.post("/download-trim-video", async (req, res) => {
  const { youtubeVideoUrl, timeFrom, timeEnd } = req.body;

  if (!youtubeVideoUrl || timeFrom == null || timeEnd == null) {
    return res
      .status(400)
      .json({ error: "YouTube video URL, timeFrom, and timeEnd are required" });
  }

  try {
    const { s3Key } = await downloadTrimAndUpload(
      youtubeVideoUrl,
      timeFrom,
      timeEnd
    );
    res.status(200).json({
      message: "Trimmed video successfully uploaded to S3",
      video_url: `https://${bucketName}.s3.amazonaws.com/${s3Key}`,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to download, trim, and upload video",
      details: error.message,
    });
  }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
