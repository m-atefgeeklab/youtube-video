require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Express app
const app = express();
app.use(bodyParser.json());

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
    return match ? match[1] : 'unknown';
};

// Function to download a YouTube video using Python's yt-dlp and upload to S3
const downloadAndUpload = async (url) => {
    return new Promise((resolve, reject) => {
        try {
            const videoId = getVideoId(url);
            const tempFilePath = path.join(os.tmpdir(), `${videoId}.mp4`); // Temporary file path
            const s3Key = `youtubevideos/${videoId}.mp4`;

            // Start the download process using exec
            const child = exec(`python3 -m yt_dlp -o "${tempFilePath}" ${url}`, { shell: true });
            // const child = exec(`python -m yt_dlp -f best -o "${tempFilePath}" ${url}`, { shell: true });

            // Handle standard error
            child.stderr.on('data', (error) => {
                console.error(`Error: ${error}`);
            });

            // Handle process exit
            child.on('exit', async (code) => {
                if (code !== 0) {
                    console.error('Failed to download video');
                    reject(new Error('Download failed'));
                    return;
                }

                // Upload to S3
                try {
                    const uploadParams = {
                        Bucket: bucketName,
                        Key: s3Key,
                        Body: fs.createReadStream(tempFilePath), // Read the temp file
                        ACL: 'public-read-write',
                    };

                    await s3Client.send(new PutObjectCommand(uploadParams));
                    console.log(`Video uploaded to S3: ${s3Key}`);
                    resolve(s3Key);
                } catch (err) {
                    console.error('Failed to upload video to S3', err);
                    reject(err);
                } finally {
                    // Cleanup temporary file
                    fs.unlink(tempFilePath, (err) => {
                        if (err) {
                            console.error('Failed to delete temp file', err);
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
app.post('/download-video', async (req, res) => {
    const { youtubeVideoUrl } = req.body;

    if (!youtubeVideoUrl) {
        return res.status(400).json({ error: 'YouTube video URL is required' });
    }

    try {
        const s3Key = await downloadAndUpload(youtubeVideoUrl);
        res.status(200).json({ message: 'Video successfully uploaded to S3', s3Key });
    } catch (error) {
        res.status(500).json({ error: 'Failed to download and upload video', details: error.message });
    }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
