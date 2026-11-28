"""Music library management, interactive music-first prompt, and royalty-free beat generator."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from gscc_highlights.config import ClubConfig

SUPPORTED_AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}


def ensure_default_hype_beat(config: ClubConfig, duration_sec: float = 250.0) -> Path:
    """Synthesize a clean royalty-free 124 BPM sports-reel beat (250s so it never loops mid-reel)."""
    music_dir = config.resolve(config.music_dir)
    music_dir.mkdir(parents=True, exist_ok=True)
    out_path = music_dir / config.default_music
    if out_path.exists() and out_path.stat().st_size > 100_000:
        try:
            with wave.open(str(out_path), "rb") as wf:
                existing_dur = wf.getnframes() / float(max(1, wf.getframerate()))
            if existing_dur >= duration_sec - 5.0:
                return out_path
        except Exception:
            pass

    sr = 44100
    bpm = 124.0
    beat_sec = 60.0 / bpm
    total_samples = int(sr * duration_sec)
    mix = np.zeros(total_samples, dtype=np.float32)

    # 1. Punchy 4-on-the-floor kick drum
    kick_len = int(sr * 0.16)
    kt = np.linspace(0.0, 0.16, kick_len, endpoint=False)
    kick_freq = 125.0 * np.exp(-kt * 26.0) + 46.0
    kick_phase = 2.0 * np.pi * np.cumsum(kick_freq) / sr
    kick = np.sin(kick_phase) * np.exp(-kt * 19.0) * 0.62

    # 2. Crisp snare/clap on beats 2 & 4
    rng = np.random.default_rng(42)
    snare_len = int(sr * 0.12)
    st = np.linspace(0.0, 0.12, snare_len, endpoint=False)
    noise = rng.standard_normal(snare_len).astype(np.float32)
    snare = (noise * 0.35 + np.sin(2.0 * np.pi * 190.0 * st) * 0.25) * np.exp(-st * 28.0) * 0.42

    # 3. Subtle off-beat hi-hat
    hat_len = int(sr * 0.04)
    ht = np.linspace(0.0, 0.04, hat_len, endpoint=False)
    hat = rng.standard_normal(hat_len).astype(np.float32) * np.exp(-ht * 85.0) * 0.12

    # 4. Warm driving minor sports bassline (D2 - F2 - G2 - A2 progression)
    bass_notes = [73.42, 73.42, 87.31, 98.00, 110.00, 98.00, 87.31, 65.41]
    step_samples = int(sr * beat_sec / 2.0)

    n_beats = int(duration_sec / beat_sec)
    for b in range(n_beats):
        pos = int(b * beat_sec * sr)
        if pos + kick_len < total_samples:
            mix[pos : pos + kick_len] += kick
        if b % 2 == 1 and pos + snare_len < total_samples:
            mix[pos : pos + snare_len] += snare
        half_pos = pos + int(0.5 * beat_sec * sr)
        if half_pos + hat_len < total_samples:
            mix[half_pos : half_pos + hat_len] += hat

        # 2 eighth-note bass pulses per beat
        freq = bass_notes[(b // 4) % len(bass_notes)]
        for sub in range(2):
            bp = pos + sub * step_samples
            blen = min(step_samples, total_samples - bp)
            if blen > 100:
                bt = np.arange(blen, dtype=np.float32) / sr
                env = np.exp(-bt * 6.5) * (1.0 - np.exp(-bt * 120.0))
                tone = (np.sin(2.0 * np.pi * freq * bt) + 0.35 * np.sin(4.0 * np.pi * freq * bt)) * env * 0.22
                mix[bp : bp + blen] += tone

    # Soft limiter & stereo WAV write
    peak = float(np.max(np.abs(mix))) + 1e-6
    mix = np.tanh(mix / peak * 1.15) * 0.85
    pcm = (mix * 32767.0).astype(np.int16)
    stereo = np.column_stack([pcm, pcm]).ravel()

    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(stereo.tobytes())

    return out_path


def synthesize_transition_sfx(kind: str, out_wav: Path) -> Path:
    """Synthesize subtle, broadcast-clean transition SFX locally (zero external licenses/downloads).

    Kinds:
      - 'card_whoosh': 0.36s airy broadcast swoosh with subtle low body (Innings Break & Full-Time)
    """
    if out_wav.exists() and out_wav.stat().st_size > 4_000:
        return out_wav

    sr = 48000
    rng = np.random.default_rng(202)
    dur = 0.36
    n = int(sr * dur)
    t = np.linspace(0.0, dur, n, endpoint=False, dtype=np.float32)
    noise = rng.standard_normal(n).astype(np.float32)
    kernel = np.array([0.08, 0.18, 0.48, 0.18, 0.08], dtype=np.float32)
    air = np.convolve(noise, kernel, mode="same")
    env = np.sin(np.pi * np.clip(t / dur, 0.0, 1.0)) ** 1.7
    # Gentle pitch-gliding warm harmonic body underneath the swoosh
    body_freq = 160.0 + 110.0 * np.sin(np.pi * t / dur)
    body_phase = 2.0 * np.pi * np.cumsum(body_freq) / sr
    mix = (air * 0.24 + np.sin(body_phase) * 0.18) * env

    peak = float(np.max(np.abs(mix))) + 1e-6
    mix = np.tanh(mix / peak * 1.05) * 0.65
    pcm = (mix * 32767.0).astype(np.int16)
    stereo = np.column_stack([pcm, pcm]).ravel()

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(stereo.tobytes())
    return out_wav


def list_music_tracks(config: ClubConfig) -> list[Path]:
    """Ensure default beat exists and return all available tracks in assets/music/."""
    ensure_default_hype_beat(config)
    music_dir = config.resolve(config.music_dir)
    if not music_dir.exists():
        return []
    return sorted(
        p for p in music_dir.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_AUDIO_EXTS
    )


def resolve_music_path(choice: str | None, config: ClubConfig) -> Path | None:
    """Resolve user's music selection ('none', track name, numeric index, or custom file path)."""
    if not choice:
        return ensure_default_hype_beat(config)
    val = choice.strip()
    if val.lower() in {"none", "off", "mute", "no"}:
        return None

    # Direct file path (custom music track anywhere on disk)
    direct = Path(val).expanduser()
    if direct.exists() and direct.is_file():
        return direct.resolve()

    tracks = list_music_tracks(config)
    if val.isdigit():
        idx = int(val) - 1
        if 0 <= idx < len(tracks):
            return tracks[idx]

    for t in tracks:
        if t.name.lower() == val.lower() or t.stem.lower() == val.lower():
            return t

    raise FileNotFoundError(
        f"Music track '{choice}' not found. Pass 'none', an existing audio file path, "
        f"or one of: {[t.name for t in tracks]}"
    )


def prompt_music_choice(config: ClubConfig) -> str:
    """Interactive music-first prompt shown at the start of prepare/run."""
    tracks = list_music_tracks(config)
    print("\n=== Step 1: Choose Background Music for Your Reel ===")
    for i, t in enumerate(tracks, start=1):
        default_tag = " (default)" if t.name == config.default_music else ""
        print(f"  [{i}] {t.name}{default_tag}")
    print("  [0] none  (Ground audio only — great if adding trending Instagram audio)")
    print("  Or paste the full path to any custom .mp3/.wav/.m4a song.")

    try:
        ans = input("Select music [1]: ").strip()
    except EOFError:
        return config.default_music

    if not ans:
        return config.default_music
    if ans == "0" or ans.lower() == "none":
        return "none"
    if ans.isdigit():
        idx = int(ans) - 1
        if 0 <= idx < len(tracks):
            return tracks[idx].name
    resolved = resolve_music_path(ans, config)
    return str(resolved) if resolved else "none"
