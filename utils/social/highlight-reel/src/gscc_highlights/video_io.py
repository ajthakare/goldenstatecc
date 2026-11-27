"""Video download (yt-dlp + Deno JS runtime), ffprobe, and ffmpeg path resolution."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from gscc_highlights.models import VideoPart


def get_ffmpeg_paths() -> tuple[str, str]:
    """Ensure ffmpeg and ffprobe are available (preferring static-ffmpeg if not in PATH)."""
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        import static_ffmpeg

        static_ffmpeg.add_paths()
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("ffmpeg/ffprobe could not be located even via static-ffmpeg.")
    return ffmpeg, ffprobe


def find_deno_bin() -> str | None:
    """Locate standalone deno binary needed by yt-dlp for YouTube JS challenges."""
    found = shutil.which("deno")
    if found:
        return found
    home_deno = Path.home() / ".deno" / "bin" / "deno"
    if home_deno.exists():
        return str(home_deno)
    return None


def parse_youtube_start_offset(url: str) -> float:
    """Parse ?t=900 or ?t=15m30s or ?t=1h2m3s from a YouTube URL into seconds."""
    qs = parse_qs(urlparse(url).query)
    t_vals = qs.get("t") or qs.get("start")
    if not t_vals:
        return 0.0
    raw = t_vals[0].strip().lower()
    if raw.isdigit():
        return float(raw)
    total = 0.0
    for amount, unit in re.findall(r"(\d+)([hms])", raw):
        val = float(amount)
        if unit == "h":
            total += val * 3600
        elif unit == "m":
            total += val * 60
        elif unit == "s":
            total += val
    return total


def probe_video(path: Path, index: int = 0, source_url: str | None = None, start_offset_sec: float = 0.0) -> VideoPart:
    """Probe duration, resolution, and fps of a local video file."""
    _, ffprobe = get_ffmpeg_paths()
    cmd = [
        ffprobe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    info = json.loads(proc.stdout)
    duration = float(info.get("format", {}).get("duration", 0.0))
    width, height, fps = 1280, 720, 30.0
    for st in info.get("streams", []):
        if st.get("codec_type") == "video":
            width = int(st.get("width", 1280))
            height = int(st.get("height", 720))
            rate = st.get("avg_frame_rate") or st.get("r_frame_rate") or "30/1"
            if "/" in rate:
                num, den = rate.split("/", 1)
                if float(den) > 0:
                    fps = float(num) / float(den)
            else:
                fps = float(rate)
            break
    return VideoPart(
        index=index,
        local_path=str(path.resolve()),
        source_url=source_url,
        duration_sec=duration,
        width=width,
        height=height,
        fps=round(fps, 3),
        start_offset_sec=start_offset_sec,
    )


def download_youtube_video(
    url: str,
    dest_path: Path,
    cookies_from_browser: str | None = None,
) -> Path:
    """Download a YouTube stream at up to 1080p MP4 using yt-dlp + Deno runtime."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if dest_path.exists() and dest_path.stat().st_size > 1_000_000:
        try:
            probe_video(dest_path)
            return dest_path
        except Exception:
            dest_path.unlink(missing_ok=True)

    ffmpeg, _ = get_ffmpeg_paths()
    deno_bin = find_deno_bin()
    env = os.environ.copy()
    if deno_bin:
        deno_dir = str(Path(deno_bin).parent)
        env["PATH"] = f"{deno_dir}:{env.get('PATH', '')}"

    yt_dlp_bin = shutil.which("yt-dlp") or str(Path(os.sys.executable).parent / "yt-dlp")
    cmd = [
        yt_dlp_bin,
        "--no-playlist",
        "--ffmpeg-location",
        str(Path(ffmpeg).parent),
        "-f",
        "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=1080][ext=mp4]/best",
        "--merge-output-format",
        "mp4",
        "-o",
        str(dest_path),
    ]
    if deno_bin:
        cmd.extend(["--js-runtimes", f"deno:{deno_bin}", "--remote-components", "ejs:github"])
    if cookies_from_browser:
        cmd.extend(["--cookies-from-browser", cookies_from_browser])
    cmd.append(url)

    subprocess.run(cmd, check=True, env=env)
    if not dest_path.exists():
        # yt-dlp sometimes appends extension if remuxed
        candidates = sorted(dest_path.parent.glob(f"{dest_path.stem}.*"))
        if candidates:
            return candidates[0]
        raise FileNotFoundError(f"yt-dlp finished but expected output not found: {dest_path}")
    return dest_path


def resolve_hq_stream_url(
    url: str,
    max_height: int = 1440,
    cookies_from_browser: str | None = None,
) -> tuple[str, int] | None:
    """Resolve a direct HTTPS high-resolution video-only stream URL (up to 1440p) ONCE per render.

    Used by two-tier HQ clip fetching so full-match OCR scans stay fast/lightweight at 720p
    while only the selected ~100s of highlight clips are fetched at 1080p/1440p for supersampled clarity.
    """
    deno_bin = find_deno_bin()
    env = os.environ.copy()
    if deno_bin:
        env["PATH"] = f"{Path(deno_bin).parent}:{env.get('PATH', '')}"
    yt_dlp_bin = shutil.which("yt-dlp") or str(Path(os.sys.executable).parent / "yt-dlp")
    fmt = (
        f"bestvideo[height<={max_height}][protocol^=http][protocol!=m3u8_native][vcodec^=vp9]/"
        f"bestvideo[height<={max_height}][protocol^=http][protocol!=m3u8_native][vcodec^=avc1]/"
        f"bestvideo[height<={max_height}][protocol^=http][protocol!=m3u8_native]/"
        f"bestvideo[height<={max_height}]"
    )
    cmd = [
        yt_dlp_bin,
        "--no-playlist",
        "--skip-download",
        "-f",
        fmt,
        "--print",
        "%(height)s\t%(url)s",
    ]
    if deno_bin:
        cmd.extend(["--js-runtimes", f"deno:{deno_bin}", "--remote-components", "ejs:github"])
    if cookies_from_browser:
        cmd.extend(["--cookies-from-browser", cookies_from_browser])
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30)
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    for line in (proc.stdout or "").splitlines():
        if "\t" in line:
            h_str, stream_url = line.split("\t", 1)
            stream_url = stream_url.strip()
            if stream_url.startswith("http"):
                try:
                    return stream_url, int(float(h_str.strip()))
                except ValueError:
                    return stream_url, 0
    return None


def fetch_youtube_title(url: str, cookies_from_browser: str | None = None) -> str:
    """Fetch video title cleanly via yt-dlp --print title without downloading."""
    deno_bin = find_deno_bin()
    env = os.environ.copy()
    if deno_bin:
        env["PATH"] = f"{Path(deno_bin).parent}:{env.get('PATH', '')}"
    yt_dlp_bin = shutil.which("yt-dlp") or str(Path(os.sys.executable).parent / "yt-dlp")
    cmd = [yt_dlp_bin, "--no-playlist", "--skip-download", "--print", "%(title)s"]
    if deno_bin:
        cmd.extend(["--js-runtimes", f"deno:{deno_bin}", "--remote-components", "ejs:github"])
    if cookies_from_browser:
        cmd.extend(["--cookies-from-browser", cookies_from_browser])
    cmd.append(url)
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip().splitlines()[0]
    return "GSCC Match Highlights"


def ingest_videos(
    youtube_urls: list[str],
    local_videos: list[Path],
    workspace_dir: Path,
    cookies_from_browser: str | None = None,
    explicit_start_offset: float | None = None,
) -> list[VideoPart]:
    """Download/probe all input video parts (supporting multi-part streams & local MP4s)."""
    parts: list[VideoPart] = []
    idx = 0

    for url in youtube_urls:
        offset = explicit_start_offset if (idx == 0 and explicit_start_offset is not None) else parse_youtube_start_offset(url)
        dest = workspace_dir / f"source_part_{idx + 1}.mp4"
        local_file = download_youtube_video(url, dest, cookies_from_browser=cookies_from_browser)
        parts.append(probe_video(local_file, index=idx, source_url=url, start_offset_sec=offset))
        idx += 1

    for vpath in local_videos:
        offset = explicit_start_offset if (idx == 0 and explicit_start_offset is not None) else 0.0
        parts.append(probe_video(Path(vpath), index=idx, source_url=None, start_offset_sec=offset))
        idx += 1

    return parts
