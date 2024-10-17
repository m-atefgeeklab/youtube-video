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

const retry = async (fn, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
    }
  }
};

const isCached = (videoId) => {
  const cacheFilePath = path.join(__dirname, "cache", `${videoId}.cache`);
  if (fs.existsSync(cacheFilePath)) {
    return fs.readFileSync(cacheFilePath, "utf-8");
  }
  return null;
};

const cacheFile = (videoId, s3Key) => {
  const cacheDir = path.join(__dirname, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }
  fs.writeFileSync(path.join(cacheDir, `${videoId}.cache`), s3Key);
};

// Delete temporary files
const deleteTempFiles = (filePaths) => {
  return Promise.all(
    filePaths.map((filePath) => {
      return new Promise((resolve) => {
        if (fs.existsSync(filePath)) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Failed to delete file ${filePath}: ${err.message}`);
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

const execPromise = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, { shell: true }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Command failed: ${stderr || error.message}`);
        return reject(new Error(stderr || error.message));
      }
      resolve(stdout);
    });
  });
};

const uploadToS3 = async (filePath, key) => {
  const uploadParams = {
    Bucket: bucketName,
    Key: key,
    Body: fs.createReadStream(filePath),
    ACL: "public-read-write",
  };
  await s3Client.send(new PutObjectCommand(uploadParams));
  console.log(`File uploaded to S3: ${key}`);
  return key;
};

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
    const thumbnailDirPath = path.join(os.tmpdir(), `${videoId}_thumbnail`);

    let thumbnailFilePath = null;

    try {
      const ytDlpPath = "/usr/local/bin/yt-dlp";
      const cookiesPath = path.join(__dirname, "youtube_cookies.txt");

      if (!fs.existsSync(cookiesPath)) {
        throw new Error(`Cookies file not found at: ${cookiesPath}`);
      }

       // Step to get video title
       const getTitleCommand = `"${ytDlpPath}" --get-title --cookies "${cookiesPath}" ${url}`;
       const videoTitle = (await execPromise(getTitleCommand)).trim();

      const videoCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestvideo -o "${videoFilePath}" --write-thumbnail ${url}`;
      const audioCommand = `"${ytDlpPath}" --cookies "${cookiesPath}" -f bestaudio -o "${audioFilePath}" ${url}`;

      await execPromise(videoCommand);
      await execPromise(audioCommand);

      if (!fs.existsSync(videoFilePath) || !fs.existsSync(audioFilePath)) {
        throw new Error("Downloaded video or audio file not found");
      }

      const mergeCommand = `ffmpeg -i "${videoFilePath}" -i "${audioFilePath}" -c:v copy -c:a aac "${mergedFilePath}"`;
      await execPromise(mergeCommand);

      const s3Key = await uploadToS3(mergedFilePath, `youtubevideos/${videoId}_${Date.now()}.mp4`);
      cacheFile(videoId, s3Key);

      let thumbnailS3Key = null;
      const thumbnailFormats = ["jpg", "png", "webp"];

      for (let format of thumbnailFormats) {
        const testFilePath = path.join(thumbnailDirPath, `${videoId}.${format}`);
        if (fs.existsSync(testFilePath)) {
          thumbnailFilePath = testFilePath;
          break;
        }
      }

      if (thumbnailFilePath) {
        console.log(`Uploading thumbnail from ${thumbnailFilePath}`);
        thumbnailS3Key = await uploadToS3(thumbnailFilePath, `youtubevideos/${videoId}_thumbnail.${Date.now()}`);
        console.log(`Thumbnail uploaded: ${thumbnailS3Key}`);
      } else {
        console.log("No thumbnail found in supported formats (jpg, png, webp).");
      }

      await deleteTempFiles([videoFilePath, audioFilePath, mergedFilePath, thumbnailFilePath]);

      return { s3Key, thumbnailS3Key, videoTitle };
    } catch (error) {
      await deleteTempFiles([videoFilePath, audioFilePath, mergedFilePath, thumbnailFilePath]);
      throw error;
    }
  }, retries);
};

app.post("/download-video", async (req, res) => {
  const { youtubeVideoUrl } = req.body;
  if (!youtubeVideoUrl) {
    return res.status(400).json({ error: "YouTube video URL is required" });
  }

  try {
    const { s3Key, thumbnailS3Key, videoTitle } = await downloadAndUpload(youtubeVideoUrl);
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
