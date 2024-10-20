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

const cacheFile = (videoId, s3Key, videoTitle, coverPictureKey) => {
  const cacheDir = path.join(__dirname, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }

  const cacheData = {
    s3Key,
    videoTitle,
    coverPictureKey,
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

// Function to upload to S3
const uploadToS3 = async (filePath, videoId, type = "video") => {
  const ext = type === "screenshot" ? "png" : "mp4";
  const s3Key = `youtubevideos/${videoId}_${Date.now()}.${ext}`;
  const uploadParams = {
    Bucket: bucketName,
    Key: s3Key,
    Body: fs.createReadStream(filePath),
    ACL: "public-read-write",
  };

  await s3Client.send(new PutObjectCommand(uploadParams));
  console.log(`${type} uploaded to S3: ${s3Key}`);
  return s3Key; // Return the s3Key
};

// Trim video function
const trimVideo = async (inputFilePath, outputFilePath, timeFrom, timeEnd) => {
  const trimCommand = `ffmpeg -i "${inputFilePath}" -ss ${timeFrom} -to ${timeEnd} -c copy "${outputFilePath}"`;
  console.log(`Trimming video from ${timeFrom}s to ${timeEnd}s`);
  await execPromise(trimCommand);

  if (!fs.existsSync(outputFilePath)) {
    throw new Error("Trimmed file not found");
  }
  console.log("Trimmed video successfully.");
  return outputFilePath;
};

// Function to get video duration in milliseconds
const getVideoDuration = async (filePath) => {
  const command = `ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${filePath}"`;
  const output = await execPromise(command);
  return Math.floor(parseFloat(output.trim())); // Duration in seconds
};

const retry = async (fn, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
    }
  }
};

// Take screenshot function
const takeScreenshot = async (inputFilePath, outputFilePath, timestamp) => {
  const screenshotCommand = `ffmpeg -i "${inputFilePath}" -ss ${timestamp} -vframes 1 "${outputFilePath}"`;
  console.log(`Taking screenshot at ${timestamp}s`);
  await execPromise(screenshotCommand);

  if (!fs.existsSync(outputFilePath)) {
    throw new Error("Screenshot file not found");
  }
  console.log("Screenshot taken successfully.");
  return outputFilePath;
};

// Updated function for downloading, trimming, and uploading
const downloadTrimAndUpload = async (url, timeFrom, timeEnd, retries = 3) => {
  const videoId = getVideoId(url);
  const cached = isCached(videoId);

  if (cached) {
    console.log(`Video with S3 key: ${cached.s3Key} already exists.`);
    console.log(`============ Skipping download and upload... ============`);
    return {
      s3Key: cached.s3Key,
      videoTitle: cached.videoTitle,
      coverPictureKey: cached.coverPictureKey,
    };
  }

  return retry(async () => {
    const videoFilePath = path.join(os.tmpdir(), `${videoId}_video.mp4`);
    const audioFilePath = path.join(os.tmpdir(), `${videoId}_audio.mp3`);
    const mergedFilePath = path.join(os.tmpdir(), `${videoId}_merged.mp4`);
    const trimmedFilePath = path.join(os.tmpdir(), `${videoId}_trimmed.mp4`);
    const screenshotFilePath = path.join(
      os.tmpdir(),
      `${videoId}_screenshot.png`
    );

    let s3Key = null;
    let coverPictureKey = null;

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

      // If timeFrom and timeEnd are provided, trim the video
      if (timeFrom !== null && timeEnd !== null) {
        const duration = await getVideoDuration(mergedFilePath);
        if (timeFrom >= duration || timeEnd > duration || timeFrom >= timeEnd) {
          throw new Error(
            `Invalid trim times. The video is ${duration} seconds long.`
          );
        }

        // Take screenshot of the trimmed video
        const screenshotTimestamp = timeFrom + (timeEnd - timeFrom) / 2;
        await takeScreenshot(mergedFilePath, screenshotFilePath, screenshotTimestamp);
        coverPictureKey = await uploadToS3(screenshotFilePath, videoId, "screenshot");

        // Trim the merged video
        await trimVideo(mergedFilePath, trimmedFilePath, timeFrom, timeEnd);
        // Use the trimmed file for uploading
        s3Key = await uploadToS3(trimmedFilePath, videoId);
      } else {
        // Take screenshot of the merged video in the middle
        const duration = await getVideoDuration(mergedFilePath);
        const screenshotTimestamp = duration / 2;
        await takeScreenshot(mergedFilePath, screenshotFilePath, screenshotTimestamp);
        coverPictureKey = await uploadToS3(screenshotFilePath, videoId, "screenshot");

        // Upload the merged video if no trimming is done
        s3Key = await uploadToS3(mergedFilePath, videoId);
      }

      cacheFile(videoId, s3Key, videoTitle, coverPictureKey);

      // Clean up temporary files
      await deleteTempFiles([
        videoFilePath,
        audioFilePath,
        mergedFilePath,
        trimmedFilePath,
        screenshotFilePath,
      ]);

      await cleanTmpFolder();

      console.log(
        `========== Finished downloading and uploading video ${videoId} ==========`
      );

      return { s3Key, videoTitle, coverPictureKey };
    } catch (error) {
      await deleteTempFiles([
        videoFilePath,
        audioFilePath,
        mergedFilePath,
        trimmedFilePath,
        screenshotFilePath,
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
  const { url, start_time, end_time } = req.body;

  if (!url) {
    return res.status(400).json({ error: "YouTube video URL is required" });
  }

  try {
    const { s3Key, videoTitle, coverPictureKey } = await downloadTrimAndUpload(
      url,
      start_time !== undefined ? start_time : null,
      end_time !== undefined ? end_time : null
    );
    res.status(200).json({
      success: true,
      message: "Video successfully uploaded to S3",
      trimmed_video: `https://${bucketName}.s3.amazonaws.com/${s3Key}`,
      title: videoTitle,
      cover_picture: `https://${bucketName}.s3.amazonaws.com/${coverPictureKey}`,
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
