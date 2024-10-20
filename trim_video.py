import sys
from moviepy.video.io.VideoFileClip import VideoFileClip

def trim_video(video_path, start_time, end_time, output_path):
    # Convert milliseconds to seconds
    start_time_sec = int(start_time) / 1000
    end_time_sec = int(end_time) / 1000
    
    # Load the video and trim it
    with VideoFileClip(video_path) as video:
        trimmed_video = video.subclip(start_time_sec, end_time_sec)
        trimmed_video.write_videofile(output_path, codec="libx264")
        print(f"Trimmed video saved to {output_path}")

if __name__ == "__main__":
    video_path = sys.argv[1]
    start_time = sys.argv[2]
    end_time = sys.argv[3]
    output_path = sys.argv[4]
    
    trim_video(video_path, start_time, end_time, output_path)
