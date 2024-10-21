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
app.use(cors());
app.use(bodyParser.json());

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

// Cookie data
const cookieData = `
# Netscape HTTP Cookie File
# http://curl.haxx.se/rfc/cookie_spec.html
# This is a generated file!  Do not edit.

.youtube.com	TRUE	/	FALSE	1763712632	HSID	AusFbWd1K1gYTsLBE
.youtube.com	TRUE	/	FALSE	1763712632	APISID	PzNtcLJwo6wLvWM-/ALFx2kRzZxhgA2sI6
.youtube.com	TRUE	/	TRUE	1763712632	SSID	AqRTsahW-xceQ55b_
.youtube.com	TRUE	/	TRUE	1763712632	SAPISID	wsaVH1788dmvMayM/AcvUXpp2NQI811PMl
.youtube.com	TRUE	/	TRUE	1763712632	__Secure-1PAPISID	wsaVH1788dmvMayM/AcvUXpp2NQI811PMl
.youtube.com	TRUE	/	TRUE	1763712632	__Secure-3PAPISID	wsaVH1788dmvMayM/AcvUXpp2NQI811PMl
.youtube.com	TRUE	/	TRUE	1763712631	LOGIN_INFO	AFmmF2swRQIgKaCPu918KikNzmV4b4CKcNc2vp6WUWY75XOLpd3jQqoCIQCgrZMkVzvwu3NiuqmdQhby15yUz5-Sf7QiuX-kDUKthQ:QUQ3MjNmeTFQMk5QNzJtZldyanA4b0tJS0dKdzh6S18wRmxoWW9uZ21qQkluczFQa0Y4UFdrYV9IUU0tSWtNVXZZajNUTDhUSDBWb2ZzVDBieUlYUWVJY1NzNmczQmVYMDF5UzJXMGNSRlRZQ0g2UWFoSFI3d0hNNjFfX2JlRFVLNzRWUFNJLU1oQ2c0bzJTZE5DNC16czJCb2owQmJqTXNR
.youtube.com	TRUE	/	FALSE	1763712632	SID	g.a000pAiTHiDwKgEq76qWc6RplbwdUCfSgdmFLRqH0LNCcFC5yqZ5LqKxD58I4KokpWK1rX0dcQACgYKAbsSARcSFQHGX2Mi17pel8cQrkuuBQOFxNaOjRoVAUF8yKqv3FGUDK4alr_21TT2OP6Y0076
.youtube.com	TRUE	/	TRUE	1763712632	__Secure-1PSID	g.a000pAiTHiDwKgEq76qWc6RplbwdUCfSgdmFLRqH0LNCcFC5yqZ5SpZN8uJDdlSAzOGO42zhMQACgYKAYESARcSFQHGX2Mi3ygdX_HlNCs4V31h15fauBoVAUF8yKrfQ-jqyTfnItnvNvKcAQ4C0076
.youtube.com	TRUE	/	TRUE	1763712632	__Secure-3PSID	g.a000pAiTHiDwKgEq76qWc6RplbwdUCfSgdmFLRqH0LNCcFC5yqZ5IkWRbMs-TLd8xu46pp0NbwACgYKAckSARcSFQHGX2MilitYHSwik-hCgvKj2vxDVhoVAUF8yKovCTVAI_BBKU6ibNmqnW-j0076
.youtube.com	TRUE	/	TRUE	1763719575	PREF	f6=40000000&tz=Africa.Cairo
.youtube.com	TRUE	/	TRUE	1760695467	__Secure-1PSIDTS	sidts-CjIBQlrA-EgXJMyHqBzVkzfjGQFOSDJ3NFh0Bjbcv8Ekq6He7pPPJhttQqBtc39wjTOmDxAA
.youtube.com	TRUE	/	TRUE	1760695467	__Secure-3PSIDTS	sidts-CjIBQlrA-EgXJMyHqBzVkzfjGQFOSDJ3NFh0Bjbcv8Ekq6He7pPPJhttQqBtc39wjTOmDxAA
.youtube.com	TRUE	/	TRUE	1729160163	CONSISTENCY	AKreu9vnFNPkiPC8OudQ1dsQTZUd8gSFL6NfDz2Vl3US3l9_okFP8FCjQBqXKqLhK7CbGzElIdDw3XL8PloSQEA74wc60jpCZ-Ysuu6BlmhPpg149eAl0m4VO8-Ylxa9yljwPIDXMOkoOds552slPNQw
.youtube.com	TRUE	/	FALSE	1729159601	ST-3opvp5	session_logininfo=AFmmF2swRQIgKaCPu918KikNzmV4b4CKcNc2vp6WUWY75XOLpd3jQqoCIQCgrZMkVzvwu3NiuqmdQhby15yUz5-Sf7QiuX-kDUKthQ%3AQUQ3MjNmeTFQMk5QNzJtZldyanA4b0tJS0dKdzh6S18wRmxoWW9uZ21qQkluczFQa0Y4UFdrYV9IUU0tSWtNVXZZajNUTDhUSDBWb2ZzVDBieUlYUWVJY1NzNmczQmVYMDF5UzJXMGNSRlRZQ0g2UWFoSFI3d0hNNjFfX2JlRFVLNzRWUFNJLU1oQ2c0bzJTZE5DNC16czJCb2owQmJqTXNR
.youtube.com	TRUE	/	FALSE	1760695597	SIDCC	AKEyXzV8758IQwApP4X-EA8yyd1gr6RFUXSbNmbG1fdfP26K39kJLAC-zmur4aaLYyFyI7iy
.youtube.com	TRUE	/	TRUE	1760695597	__Secure-1PSIDCC	AKEyXzUqK3qA5F7fcRtfm7EEsYW0ykhygY_Rh6HtIeOpETOc5eIgJXoms_7NzYuAVw47TSKiaQ
.youtube.com	TRUE	/	TRUE	1760695597	__Secure-3PSIDCC	AKEyXzUUyQ_RyzfeoDwhIY_kBbvWb44kUUDtGMlbtwoMnGv82uprmUZx4Gk80DCZtr0SQqq4GQ
`;

// Ensure the cookie file exists and is not empty
const ensureCookiesFile = async (cookiesPath, defaultCookies) => {
  try {
    const data = await fs.promises.readFile(cookiesPath, 'utf8');
    if (data.trim().length === 0) {
      console.log('File is empty. Writing default cookie data...');
      await fs.promises.writeFile(cookiesPath, defaultCookies, 'utf8');
      console.log('Default cookie data written successfully.');
    } else {
      console.log('Cookie file is not empty. No changes made.');
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('Cookie file does not exist. Creating and writing default cookie data...');
      await fs.promises.writeFile(cookiesPath, defaultCookies, 'utf8');
      console.log('Default cookie data written successfully.');
    } else {
      console.error(`Error reading or writing cookie file: ${err}`);
      throw err;
    }
  }
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

    const ytDlpPath = '/usr/local/bin/yt-dlp';
    const cookiesPath = path.join(__dirname, 'youtube_cookies.txt');

    let s3Key = null;
    let coverPictureKey = null;

    try {
      console.log(
        `========== Start downloading video ${videoId}... ==========`
      );

      await ensureCookiesFile(cookiesPath, cookieData);

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
// const cleanTmpFolder = () => {
//   return new Promise((resolve, reject) => {
//     const command = "sudo rm -f /tmp/*";

//     exec(command, (error, stdout, stderr) => {
//       if (error) {
//         console.error(
//           `Error deleting files in /tmp/: ${stderr || error.message}`
//         );
//         return reject(new Error(stderr || error.message));
//       }
//       console.log(`All files in /tmp/ have been successfully deleted`);
//       resolve(stdout);
//     });
//   });
// };

// Function to delete files in the /tmp/ folder
const cleanTmpFolder = () => {
  const tmpDir = os.tmpdir();

  return new Promise((resolve, reject) => {
    fs.readdir(tmpDir, (err, files) => {
      if (err) {
        console.error(`Error reading /tmp/ folder: ${err.message}`);
        return reject(err);
      }

      if (files.length === 0) {
        console.log("No files found in /tmp/ folder to delete.");
        return resolve();
      }

      // Iterate over each file and remove it
      files.forEach((file) => {
        const filePath = path.join(tmpDir, file);

        fs.lstat(filePath, (err, stats) => {
          if (err) {
            console.error(`Error reading file stats for ${filePath}: ${err.message}`);
            return;
          }

          // If the file is a directory, remove it recursively, else remove the file
          if (stats.isDirectory()) {
            fs.rm(filePath, { recursive: true, force: true }, (err) => {
              if (err) {
                console.error(`Failed to delete directory ${filePath}: ${err.message}`);
              } else {
                console.log(`Deleted directory: ${filePath}`);
              }
            });
          } else {
            fs.unlink(filePath, (err) => {
              if (err) {
                console.error(`Failed to delete file ${filePath}: ${err.message}`);
              } else {
                console.log(`Deleted file: ${filePath}`);
              }
            });
          }
        });
      });

      resolve();
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
