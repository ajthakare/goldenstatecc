"""v2 Stadium Floodlight & Heritage Hybrid broadcast graphics generator (9:16 Safe Zones)."""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, InningsSummary, MatchInfo

# Cache loaded fonts & resized crests within process for sub-second rendering
_FONT_CACHE: dict[tuple[str, int, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}
_WEIGHT_MAP = {
    "regular": 400,
    "medium": 500,
    "semibold": 600,
    "bold": 700,
    "extrabold": 800,
    "black": 900,
}

LOWER_CARD_X = 44
LOWER_CARD_Y_OFFSET = 28  # below video_y + video_height (= 1156)
LOWER_CARD_W = 862  # ends at x = 906 <= safe_right_x (910)
LOWER_CARD_H = 262  # ends at y = 1418 <= safe_bottom_y (1480)


def _hex_rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def _load_font(
    config: ClubConfig,
    size: int,
    weight: str | int = "bold",
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    wght = weight if isinstance(weight, int) else _WEIGHT_MAP.get(weight, 700)
    var_font = config.resolve(config.font_variable_path)
    cache_key = (str(var_font), size, wght)
    if cache_key in _FONT_CACHE:
        return _FONT_CACHE[cache_key]

    if var_font.exists():
        try:
            f = ImageFont.truetype(str(var_font), size=size)
            try:
                f.set_variation_by_axes([wght])
            except Exception:
                pass
            _FONT_CACHE[cache_key] = f
            return f
        except Exception:
            pass

    # Fallback chain if bundled Inter Variable is unavailable
    candidates: list[Path] = []
    if wght >= 800:
        candidates.extend(
            [
                config.resolve(config.font_extrabold_path),
                config.resolve(config.font_bold_path),
                Path("/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf"),
                Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
                Path("/System/Library/Fonts/Avenir Next.ttc"),
                Path("/System/Library/Fonts/SFNS.ttf"),
            ]
        )
    elif wght >= 600:
        candidates.extend(
            [
                config.resolve(config.font_bold_path),
                Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
                Path("/System/Library/Fonts/Avenir Next.ttc"),
                Path("/System/Library/Fonts/SFNS.ttf"),
            ]
        )
    else:
        candidates.extend(
            [
                config.resolve(config.font_regular_path),
                Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
                Path("/System/Library/Fonts/HelveticaNeue.ttc"),
                Path("/System/Library/Fonts/SFNS.ttf"),
            ]
        )

    for fp in candidates:
        if fp.exists():
            try:
                f = ImageFont.truetype(str(fp), size=size)
                _FONT_CACHE[cache_key] = f
                return f
            except Exception:
                continue
    return ImageFont.load_default()


def _text_bbox(draw: ImageDraw.ImageDraw, text: str, font) -> tuple[int, int, int, int]:
    if not text:
        return (0, 0, 0, 0)
    return draw.textbbox((0, 0), text, font=font)


def _measure_tracked(draw: ImageDraw.ImageDraw, text: str, font, tracking: int = 0) -> tuple[int, int, int]:
    """Return (width, height, min_y_bearing) for tracked single-line text."""
    if not text:
        return (0, 0, 0)
    if tracking == 0:
        bb = _text_bbox(draw, text, font)
        return (bb[2] - bb[0], bb[3] - bb[1], bb[1])
    total_w = 0.0
    y0s: list[int] = []
    y1s: list[int] = []
    for i, ch in enumerate(text):
        adv = draw.textlength(ch, font=font)
        total_w += adv + (tracking if i < len(text) - 1 else 0)
        bb = _text_bbox(draw, ch, font)
        if bb[3] > bb[1]:
            y0s.append(bb[1])
            y1s.append(bb[3])
    y0 = min(y0s) if y0s else 0
    y1 = max(y1s) if y1s else 0
    return (int(round(total_w)), max(0, y1 - y0), y0)


def _draw_text_top(
    draw: ImageDraw.ImageDraw,
    x: float,
    y_top: float,
    text: str,
    font,
    fill: tuple[int, int, int, int],
    tracking: int = 0,
) -> tuple[int, int]:
    """Draw text whose exact optical top sits at y_top (fixes Pillow bb[1] shift)."""
    if not text:
        return (0, 0)
    if tracking == 0:
        bb = _text_bbox(draw, text, font)
        draw.text((x - bb[0], y_top - bb[1]), text, fill=fill, font=font)
        return (bb[2] - bb[0], bb[3] - bb[1])

    tw, th, y0 = _measure_tracked(draw, text, font, tracking=tracking)
    cur_x = float(x)
    for i, ch in enumerate(text):
        draw.text((cur_x, y_top - y0), ch, fill=fill, font=font)
        cur_x += draw.textlength(ch, font=font) + (tracking if i < len(text) - 1 else 0)
    return (tw, th)


def _draw_centered_top(
    draw: ImageDraw.ImageDraw,
    center_x: float,
    y_top: float,
    text: str,
    font,
    fill: tuple[int, int, int, int],
    tracking: int = 0,
) -> int:
    """Draw horizontally centered text with optical top at y_top; return optical bottom y."""
    tw, th, _ = _measure_tracked(draw, text, font, tracking=tracking)
    _draw_text_top(draw, center_x - tw / 2.0, y_top, text, font, fill, tracking=tracking)
    return int(round(y_top + th))


def _fit_font(
    draw: ImageDraw.ImageDraw,
    config: ClubConfig,
    text: str,
    max_width: int,
    start_size: int,
    min_size: int,
    weight: str | int = "extrabold",
    tracking: int = 0,
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for sz in range(start_size, min_size - 1, -2):
        f = _load_font(config, sz, weight)
        tw, _, _ = _measure_tracked(draw, text, f, tracking=tracking)
        if tw <= max_width:
            return f
    return _load_font(config, min_size, weight)


def _wrap_pixel_lines(
    draw: ImageDraw.ImageDraw,
    text: str,
    font,
    max_width: int,
    max_lines: int = 2,
) -> list[str]:
    """Wrap text strictly by rendered pixel width (never arbitrary character cliffs)."""
    words = (text or "").split()
    if not words:
        return []
    lines: list[str] = []
    cur = words[0]
    for word in words[1:]:
        cand = f"{cur} {word}"
        bb = _text_bbox(draw, cand, font)
        if (bb[2] - bb[0]) <= max_width:
            cur = cand
        else:
            lines.append(cur)
            cur = word
    lines.append(cur)

    if len(lines) <= max_lines:
        return lines

    kept = lines[: max_lines - 1]
    tail = " ".join(lines[max_lines - 1 :])
    while tail:
        cand = tail + "…"
        bb = _text_bbox(draw, cand, font)
        if (bb[2] - bb[0]) <= max_width:
            kept.append(cand)
            return kept
        tail = tail[:-1].rstrip()
    kept.append("…")
    return kept


def _load_image_crest(path: Path, max_w: int, max_h: int) -> Image.Image | None:
    if not path or not path.exists():
        return None
    try:
        im = Image.open(path).convert("RGBA")
        bbox = im.getbbox()
        if bbox:
            im = im.crop(bbox)
        im.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
        return im
    except Exception:
        return None


def _load_club_logo(config: ClubConfig, max_px: int) -> Image.Image:
    im = _load_image_crest(config.resolve(config.logo_path), max_px, max_px)
    if im is not None:
        return im
    # Fallback crisp circular GSCC crest badge
    badge = Image.new("RGBA", (max_px, max_px), (0, 0, 0, 0))
    d = ImageDraw.Draw(badge)
    c = config.colors
    d.ellipse(
        [(2, 2), (max_px - 3, max_px - 3)],
        fill=_hex_rgba(c.maroon_primary),
        outline=_hex_rgba(c.gold_bright),
        width=max(3, max_px // 24),
    )
    font = _load_font(config, max(16, int(max_px * 0.28)), "extrabold")
    bb = d.textbbox((0, 0), config.short_name, font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    d.text(
        ((max_px - tw) / 2 - bb[0], (max_px - th) / 2 - bb[1]),
        config.short_name,
        fill=_hex_rgba(c.gold_bright),
        font=font,
    )
    return badge


def _load_squad_logo(config: ClubConfig, team_name: str, max_px: int) -> Image.Image | None:
    p = config.squad_logo_path(team_name)
    if p is None:
        return None
    return _load_image_crest(p, max_px, max_px)


def _rounded_mask(w: int, h: int, radius: int) -> Image.Image:
    """2x supersampled anti-aliased rounded rectangle mask."""
    s = 2
    mask = Image.new("L", (w * s, h * s), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([(0, 0), (w * s - 1, h * s - 1)], radius=radius * s, fill=255)
    return mask.resize((w, h), Image.Resampling.LANCZOS)


def _make_clipped_panel(
    w: int,
    h: int,
    radius: int,
    fill_top: tuple[int, int, int, int],
    fill_bot: tuple[int, int, int, int] | None = None,
    outline: tuple[int, int, int, int] | None = None,
    outline_width: int = 2,
    left_bar: tuple[int, tuple[int, int, int, int]] | None = None,
    top_bar: tuple[int, tuple[int, int, int, int]] | None = None,
) -> Image.Image:
    """Create an anti-aliased rounded panel with inner accents strictly clipped to corners."""
    panel = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if fill_bot is None:
        fill_bot = fill_top

    # Fast vertical gradient fill via numpy
    t = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None]
    arr = np.empty((h, w, 4), dtype=np.uint8)
    for ch in range(4):
        col = fill_top[ch] + (fill_bot[ch] - fill_top[ch]) * t
        arr[:, :, ch] = np.clip(col, 0, 255).astype(np.uint8)
    grad = Image.fromarray(arr, mode="RGBA")

    gd = ImageDraw.Draw(grad)
    if top_bar:
        th, tcol = top_bar
        gd.rectangle([(0, 0), (w, th)], fill=tcol)
    if left_bar:
        lw, lcol = left_bar
        gd.rectangle([(0, 0), (lw, h)], fill=lcol)

    mask = _rounded_mask(w, h, radius)
    # Combine fill alpha with rounded corner mask
    r, g, b, a = grad.split()
    clipped_a = Image.fromarray(
        ((np.asarray(a, dtype=np.uint16) * np.asarray(mask, dtype=np.uint16)) // 255).astype(np.uint8),
        mode="L",
    )
    panel = Image.merge("RGBA", (r, g, b, clipped_a))

    if outline and outline_width > 0:
        od = ImageDraw.Draw(panel)
        od.rounded_rectangle(
            [(1, 1), (w - 2, h - 2)],
            radius=max(1, radius - 1),
            outline=outline,
            width=outline_width,
        )
    return panel


def _make_stadium_canvas(
    config: ClubConfig,
    *,
    transparent_scrim: bool = False,
    mood: str = "intro",
) -> Image.Image:
    """Build Stadium Floodlight & Heritage Hybrid backdrop (or dark translucent scrim over live video)."""
    w, h = config.width, config.height
    c = config.colors
    sw, sh = w // 4, h // 4  # 270x480 fast compute grid -> bicubic upscale (~12ms)

    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
    xn = xx / float(sw - 1)
    yn = yy / float(sh - 1)

    if transparent_scrim:
        # Translucent dark obsidian scrim for live-action teaser intro:
        # darker around typography zones, slightly clearer around pitch action band
        base_r, base_g, base_b = _hex_rgba(c.obsidian_deep)[:3]
        alpha = 188.0 + 48.0 * np.abs(yn - 0.50) * 2.0
        # Warm crimson stadium floodlight glow upper-left
        g1 = np.exp(-(((xn - 0.16) / 0.45) ** 2 + ((yn - 0.24) / 0.28) ** 2))
        # Subtle warm gold rim glow lower-right
        g2 = np.exp(-(((xn - 0.88) / 0.42) ** 2 + ((yn - 0.72) / 0.28) ** 2))

        cr, cg, cb = _hex_rgba(c.crimson_glow)[:3]
        gr, gg, gb = _hex_rgba(c.gold_bright)[:3]

        r = np.clip(base_r + g1 * (cr - base_r) * 0.65 + g2 * (gr - base_r) * 0.26, 0, 255)
        g = np.clip(base_g + g1 * (cg - base_g) * 0.65 + g2 * (gg - base_g) * 0.26, 0, 255)
        b = np.clip(base_b + g1 * (cb - base_b) * 0.65 + g2 * (gb - base_b) * 0.26, 0, 255)
        a = np.clip(alpha, 155, 236)
    else:
        br0, bg0, bb0 = _hex_rgba(c.obsidian_deep)[:3]
        br1, bg1, bb1 = _hex_rgba("#1A0D0C")[:3]
        cr, cg, cb = _hex_rgba(c.crimson_glow)[:3]
        gr, gg, gb = _hex_rgba(c.gold_bright)[:3]

        # Vertical base tone
        v = yn if mood != "outro" else (1.0 - yn)
        r = br0 + (br1 - br0) * v
        g = bg0 + (bg1 - bg0) * v
        b = bb0 + (bb1 - bb0) * v

        if mood == "outro":
            g1 = np.exp(-(((xn - 0.84) / 0.50) ** 2 + ((yn - 0.20) / 0.28) ** 2))
            g2 = np.exp(-(((xn - 0.14) / 0.48) ** 2 + ((yn - 0.74) / 0.26) ** 2))
        elif mood == "break":
            g1 = np.exp(-(((xn - 0.50) / 0.58) ** 2 + ((yn - 0.46) / 0.28) ** 2))
            g2 = np.exp(-(((xn - 0.50) / 0.40) ** 2 + ((yn - 0.66) / 0.22) ** 2))
        else:
            g1 = np.exp(-(((xn - 0.18) / 0.48) ** 2 + ((yn - 0.24) / 0.28) ** 2))
            g2 = np.exp(-(((xn - 0.86) / 0.45) ** 2 + ((yn - 0.72) / 0.28) ** 2))

        r = np.clip(r + g1 * (cr - r) * 0.68 + g2 * (gr - r) * 0.26, 0, 255)
        g = np.clip(g + g1 * (cg - g) * 0.68 + g2 * (gg - g) * 0.26, 0, 255)
        b = np.clip(b + g1 * (cb - b) * 0.68 + g2 * (gb - b) * 0.26, 0, 255)
        # Subtle edge vignette
        vig = 1.0 - 0.28 * (((xn - 0.5) * 1.4) ** 2 + ((yn - 0.5) * 1.2) ** 2)
        vig = np.clip(vig, 0.58, 1.0)
        r = r * vig
        g = g * vig
        b = b * vig
        a = np.full_like(r, 255.0)

    rgba = np.stack([r, g, b, a], axis=-1).astype(np.uint8)
    img = Image.fromarray(rgba, mode="RGBA").resize((w, h), Image.Resampling.BICUBIC)

    # Subtle architectural stadium accents (inspired by GSCC's insta_story_template.png)
    draw = ImageDraw.Draw(img)
    gold_line = _hex_rgba(c.gold_soft, 34)
    for i in range(12):
        ly = 236 + i * 16
        length = int(210 - i * 11)
        if length > 24:
            draw.line([(w - length, ly), (w, ly)], fill=gold_line, width=2)
    for i in range(10):
        ly = 1320 + i * 16
        length = int(90 + i * 12)
        draw.line([(0, ly), (length, ly)], fill=_hex_rgba(c.gold_accent, 28), width=2)

    # Minimalist geometric chevrons at top-left inside safe zone
    chev_col = _hex_rgba(c.gold_soft, 70)
    cx = 76
    for i in range(3):
        cy = 262 + i * 24
        draw.line([(cx - 14, cy), (cx, cy + 12), (cx + 14, cy)], fill=chev_col, width=2)

    return img


def _draw_soft_halo(canvas: Image.Image, cx: int, cy: int, radius: int, color_hex: str, max_alpha: int = 85) -> None:
    """Composite a subtle radial glow behind hero crests."""
    d = radius * 2
    yy, xx = np.mgrid[0:d, 0:d].astype(np.float32)
    dist2 = ((xx - radius) / radius) ** 2 + ((yy - radius) / radius) ** 2
    falloff = np.exp(-dist2 * 2.4) * (dist2 <= 1.0)
    r, g, b, _ = _hex_rgba(color_hex)
    arr = np.zeros((d, d, 4), dtype=np.uint8)
    arr[:, :, 0] = r
    arr[:, :, 1] = g
    arr[:, :, 2] = b
    arr[:, :, 3] = np.clip(falloff * max_alpha, 0, 255).astype(np.uint8)
    halo = Image.fromarray(arr, mode="RGBA")
    canvas.alpha_composite(halo, (cx - radius, cy - radius))


def _composite_crest_lockup(
    canvas: Image.Image,
    match_info: MatchInfo,
    config: ClubConfig,
    center_x: int,
    top_y: int,
    max_h: int,
) -> int:
    """Draw club + squad dual-crest lockup (or derby dual-squad) and return bottom y."""
    c = config.colors
    draw = ImageDraw.Draw(canvas)
    team_a, team_b = _split_match_teams(match_info)

    if match_info.is_derby:
        la = _load_squad_logo(config, team_a, max_h)
        lb = _load_squad_logo(config, team_b, max_h)
        if la and lb:
            gap = 46
            total_w = la.width + gap + lb.width
            x0 = center_x - total_w // 2
            _draw_soft_halo(canvas, center_x, top_y + max_h // 2, int(max_h * 0.95), c.gold_bright, 62)
            canvas.alpha_composite(la, (x0, top_y + (max_h - la.height) // 2))
            div_x = x0 + la.width + gap // 2
            draw.line([(div_x, top_y + 18), (div_x, top_y + max_h - 18)], fill=_hex_rgba(c.gold_accent, 145), width=2)
            canvas.alpha_composite(lb, (x0 + la.width + gap, top_y + (max_h - lb.height) // 2))
            return top_y + max_h

    squad_name = match_info.gscc_team
    if not config.squad_logo_path(squad_name):
        for candidate in (team_a, team_b):
            if config.squad_logo_path(candidate):
                squad_name = candidate
                break

    club_logo = _load_club_logo(config, max_h)
    squad_logo = _load_squad_logo(config, squad_name, max_h)

    if squad_logo is not None:
        gap = 44
        total_w = club_logo.width + gap + squad_logo.width
        x0 = center_x - total_w // 2
        _draw_soft_halo(canvas, center_x, top_y + max_h // 2, int(max_h * 0.95), c.gold_bright, 60)
        canvas.alpha_composite(club_logo, (x0, top_y + (max_h - club_logo.height) // 2))
        div_x = x0 + club_logo.width + gap // 2
        draw.line([(div_x, top_y + 20), (div_x, top_y + max_h - 20)], fill=_hex_rgba(c.gold_accent, 155), width=2)
        canvas.alpha_composite(squad_logo, (x0 + club_logo.width + gap, top_y + (max_h - squad_logo.height) // 2))
        return top_y + max_h

    _draw_soft_halo(canvas, center_x, top_y + club_logo.height // 2, int(max_h * 0.85), c.gold_bright, 65)
    canvas.alpha_composite(club_logo, (center_x - club_logo.width // 2, top_y))
    return top_y + club_logo.height


def _split_match_teams(match_info: MatchInfo) -> tuple[str, str]:
    """Split match_info.title into clean (team_a, team_b) without orphan wrapping."""
    title = " ".join((match_info.title or "").split())
    m = re.split(r"\s+vs\.?\s+|\s+v\.?\s+", title, maxsplit=1, flags=re.IGNORECASE)
    if len(m) == 2 and m[0].strip() and m[1].strip():
        return m[0].strip(), m[1].strip()
    if match_info.gscc_team and match_info.opponent_team:
        return match_info.gscc_team.strip(), match_info.opponent_team.strip()
    return title or match_info.gscc_team or "GSCC", ""


def _summarize_teaser_counts(clips: Sequence[ClipSpec] | None) -> str:
    """Build punchy auto-computed teaser strip (e.g. '8 WICKETS • 10 FOURS')."""
    if not clips:
        return ""
    enabled = [c for c in clips if c.enabled]
    if not enabled:
        return ""
    counts: dict[str, int] = defaultdict(int)
    for c in enabled:
        counts[c.event_type] += 1

    parts: list[str] = []
    if counts["hundred"]:
        n = counts["hundred"]
        parts.append(f"{n} CENTUR{'Y' if n == 1 else 'IES'}")
    if counts["fifty"]:
        n = counts["fifty"]
        parts.append(f"{n} FIFT{'Y' if n == 1 else 'IES'}")
    if counts["wicket"]:
        n = counts["wicket"]
        parts.append(f"{n} WICKET{'' if n == 1 else 'S'}")
    if counts["six"]:
        n = counts["six"]
        parts.append(f"{n} SIX{'' if n == 1 else 'ES'}")
    if counts["four"]:
        n = counts["four"]
        parts.append(f"{n} FOUR{'' if n == 1 else 'S'}")
    if counts["winning_shot"]:
        parts.append("WINNING SHOT")
    return "   •   ".join(parts[:3])


def _is_run_out_clip(clip: ClipSpec) -> bool:
    if clip.event_type != "wicket":
        return False
    blob = f"{clip.badge} {clip.headline} {clip.subtext}".lower()
    return "run out" in blob or "run-out" in blob or "runout" in blob


def _event_palette(clip: ClipSpec, config: ClubConfig) -> tuple[str, str, str, str]:
    """Return (pill_bg, pill_fg, accent_hex, display_badge) with unmistakable color separation."""
    c = config.colors
    if clip.event_type in {"hundred", "fifty", "winning_shot"}:
        return c.gold_bright, c.obsidian_deep, c.gold_bright, clip.badge
    if clip.event_type == "six":
        return c.gold_soft, c.obsidian_deep, c.gold_soft, clip.badge
    if clip.event_type == "wicket":
        badge = clip.badge
        if _is_run_out_clip(clip) and badge.strip().upper() in {"WICKET!", "WICKET"}:
            badge = "RUN OUT!"
        return c.crimson_signal, c.pure_white, c.crimson_signal, badge
    # FOUR! -> Crisp Warm White pill + metallic gold accent (unmistakably distinct from wickets!)
    return c.warm_white, c.obsidian_deep, c.gold_soft, clip.badge


def _sanitize_stat_text(text: str) -> str:
    """Clean up Ticker-Only OCR '0* (0)' / '(0 off 0)' artifacts gracefully."""
    s = " ".join((text or "").split())
    s = re.sub(r"^0\*\s*\(0(?:\s+balls?)?\)\s*", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*\(0\s+off\s+0\)", "", s, flags=re.IGNORECASE)
    if s.lower().startswith("off "):
        s = "O" + s[1:]
    return s.strip()


def _parse_score_from_text(score_text: str) -> tuple[int | None, int | None, str]:
    """Extract (runs, wickets, compact_score_str) from e.g. 'GSCC Tigers 14/0 (0.6 ov)'."""
    m = re.search(r"(\d+)\s*/\s*(\d+)", score_text or "")
    if not m:
        return None, None, ""
    return int(m.group(1)), int(m.group(2)), f"{m.group(1)}/{m.group(2)}"


def _overs_to_balls(overs_text: str) -> int:
    s = (overs_text or "").strip()
    m = re.match(r"^(\d+)(?:\.(\d+))?", s)
    if not m:
        return 0
    ov = int(m.group(1))
    b = min(5, int(m.group(2) or 0))
    return ov * 6 + b


def _format_overs_display(overs_text: str) -> str:
    s = (overs_text or "").strip()
    if not s:
        return "0.0 ov"
    if "." not in s and s.isdigit():
        return f"{s}.0 ov"
    return f"{s} ov"


def _compute_run_rate(runs: int, overs_text: str) -> str:
    balls = _overs_to_balls(overs_text)
    if balls <= 0:
        return ""
    rr = runs / (balls / 6.0)
    return f"RR {rr:.2f}"


def _compute_live_phase_label(match_info: MatchInfo, clip: ClipSpec) -> tuple[str, bool]:
    """Build cache-safe live match phase badge for Top Bar (returns text, is_clutch)."""
    balls_now = _overs_to_balls(clip.over_ball)
    ov_now = balls_now // 6

    if clip.innings_number == 2 and match_info.innings:
        inn1 = next((i for i in match_info.innings if i.innings_number == 1), match_info.innings[0])
        runs_now, _, _ = _parse_score_from_text(clip.score_text)
        if inn1 and inn1.runs > 0 and runs_now is not None:
            target = inn1.runs + 1
            inn1_ov = _overs_to_balls(inn1.overs_text) / 6.0
            # Infer format max overs cleanly (T20 vs 40-over vs 50-over)
            if inn1_ov <= 20.5 and ov_now < 20:
                max_balls = 120
            elif inn1_ov <= 40.5 and ov_now < 40:
                max_balls = 240
            else:
                max_balls = 300
            need = target - runs_now
            rem = max(0, max_balls - balls_now)
            if need <= 0:
                return ("TARGET CHASED", True)
            if need == 1 and rem > 0:
                return (f"NEED 1 OFF {rem}", True)
            if rem > 0:
                return (f"NEED {need} OFF {rem}", rem <= 30 or need <= 20)
        return ("2ND INN • CHASE", ov_now >= 15)

    # 1st Innings phase
    if ov_now < 6:
        return ("1ST INN • POWERPLAY", False)
    if ov_now < 15:
        return ("1ST INN • MIDDLE", False)
    return ("1ST INN • DEATH", True)


def _decompose_clip_copy(clip: ClipSpec) -> tuple[str, str, str]:
    """Split clip headline/subtext into (hero_line, hero_stat_badge, detail_line) without repetition."""
    raw_head = " ".join((clip.headline or "").split())
    raw_sub = _sanitize_stat_text(clip.subtext)

    # 1. Extract leading batter score like "43* (31)" from subtext if present
    stat_badge = ""
    detail = raw_sub
    m_stat = re.match(r"^(\d+\*?\s*\(\d+(?:\s+balls?)?\))\s*(.*)$", raw_sub, flags=re.IGNORECASE)
    if m_stat and clip.event_type in {"four", "six", "fifty", "hundred"}:
        stat_badge = re.sub(r"\s+balls?", "", m_stat.group(1), flags=re.IGNORECASE)
        rest = m_stat.group(2).strip()
        if rest.lower().startswith("off "):
            rest = "O" + rest[1:]
        detail = rest

    # 2. De-boilerplate repetitive headlines into bold Hero-Player typography
    m_four = re.match(r"^(.+?)\s+finds the boundary!?$", raw_head, flags=re.IGNORECASE)
    m_six = re.match(r"^(.+?)\s+launches it for 6!?$", raw_head, flags=re.IGNORECASE)
    m_strike = re.match(r"^(.+?)\s+strikes!?(?:\s*\(Run Out\))?$", raw_head, flags=re.IGNORECASE)

    if m_four:
        hero = m_four.group(1).strip()
        return hero, stat_badge, detail
    if m_six:
        hero = m_six.group(1).strip()
        return hero, stat_badge, detail
    if m_strike:
        if _is_run_out_clip(clip):
            # Never falsely credit the bowler on a run-out!
            m_ro = re.search(r"run\s*out\s*\(([^)]+)\)", raw_sub, flags=re.IGNORECASE)
            hero = f"Run Out ({m_ro.group(1).strip()})" if m_ro else "Clutch Run Out!"
            return hero, "", raw_sub
        hero = m_strike.group(1).strip()
        return hero, "", raw_sub

    # Preserve custom/special headlines verbatim (e.g., "Clutch Run Out! Scores Tied!", milestones, winning shot)
    return raw_head, stat_badge, detail


def derive_standout_performers(
    match_info: MatchInfo,
    clips: Sequence[ClipSpec] | None,
    config: ClubConfig,
) -> list[str]:
    """Return top performers from NCCA, or auto-derive GSCC standouts in Ticker-Only mode."""
    if match_info.top_performers:
        return list(match_info.top_performers[:3])
    if not clips:
        return []

    bat_fours: dict[str, int] = defaultdict(int)
    bat_sixes: dict[str, int] = defaultdict(int)
    bat_best_stat: dict[str, tuple[int, str]] = {}
    bowl_wkts: dict[str, int] = defaultdict(int)

    for c in clips:
        if not c.enabled:
            continue
        hero, stat_badge, _ = _decompose_clip_copy(c)
        if c.event_type in {"four", "six", "fifty", "hundred", "winning_shot"} and hero:
            # Avoid generic custom headlines being counted as player names
            if len(hero.split()) <= 4 and "!" not in hero:
                if c.event_type == "four":
                    bat_fours[hero] += 1
                elif c.event_type == "six":
                    bat_sixes[hero] += 1
                m = re.match(r"^(\d+)", stat_badge or "")
                if m:
                    r_val = int(m.group(1))
                    if r_val > bat_best_stat.get(hero, (0, ""))[0]:
                        bat_best_stat[hero] = (r_val, stat_badge)
        elif c.event_type == "wicket" and not _is_run_out_clip(c) and hero:
            if len(hero.split()) <= 4 and "!" not in hero:
                bowl_wkts[hero] += 1

    scored: list[tuple[int, str]] = []
    for batter in set(bat_fours) | set(bat_sixes):
        f4, s6 = bat_fours[batter], bat_sixes[batter]
        score = f4 * 4 + s6 * 6
        parts = []
        if s6:
            parts.append(f"{s6}x6")
        if f4:
            parts.append(f"{f4}x4")
        best_r, best_s = bat_best_stat.get(batter, (0, ""))
        if best_r >= 25 and best_s:
            label = f"{batter} {best_s}"
        else:
            label = f"{batter} {' • '.join(parts)}"
        scored.append((score + best_r, label))

    for bowler, wkts in bowl_wkts.items():
        scored.append((wkts * 18, f"{bowler} {wkts} wkt{'' if wkts == 1 else 's'}"))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [label for _, label in scored[:3]]


def _parse_performer_row(perf: str) -> tuple[str, str, str]:
    """Parse performer text like 'Surendra TS 3/25 (4 ov)' into (role_tag, name, stat)."""
    s = " ".join((perf or "").split())
    # Bowling figure: 'Name 3/25 (4 ov)' or 'Name 3 wkts'
    m_bowl_fig = re.match(r"^(.+?)\s+(\d+/\d+(?:\s*\([^)]+\))?)$", s)
    if m_bowl_fig:
        return ("BOWL", m_bowl_fig.group(1).strip(), m_bowl_fig.group(2).strip())
    m_bowl_wkt = re.match(r"^(.+?)\s+(\d+\s*wkts?.*)$", s, flags=re.IGNORECASE)
    if m_bowl_wkt:
        return ("BOWL", m_bowl_wkt.group(1).strip(), m_bowl_wkt.group(2).strip())
    # Batting figure: 'Name 44 (33)' or 'Name 77* (47)' or 'Name 2x6 • 3x4'
    m_bat_fig = re.match(r"^(.+?)\s+(\d+\*?\s*\(\d+[^)]*\))$", s)
    if m_bat_fig:
        return ("BAT", m_bat_fig.group(1).strip(), m_bat_fig.group(2).strip())
    m_bat_bnd = re.match(r"^(.+?)\s+(\d+x[46].*)$", s, flags=re.IGNORECASE)
    if m_bat_bnd:
        return ("BAT", m_bat_bnd.group(1).strip(), m_bat_bnd.group(2).strip())
    return ("STAR", s, "")


def _team_initials(team_name: str) -> str:
    words = [w for w in re.split(r"\s+", (team_name or "").strip()) if w]
    if not words:
        return "CC"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()


def _is_winning_team(team_name: str, result_text: str) -> bool:
    rt = " ".join((result_text or "").lower().split())
    tn = " ".join((team_name or "").lower().split())
    if not rt or not tn:
        return False
    return rt.startswith(tn + " won") or f"{tn} won" in rt


# ---------------------------------------------------------------------------
# 1. INTRO GRAPHICS (Full Card + Transparent Teaser Overlay + 4:5 Cover Export)
# ---------------------------------------------------------------------------


def _draw_intro_content(
    img: Image.Image,
    match_info: MatchInfo,
    config: ClubConfig,
    clips: Sequence[ClipSpec] | None = None,
) -> None:
    """Draw borderless Stadium Floodlight intro layout inside Instagram Safe Zones & 4:5 Cover."""
    w = config.width
    cx = w // 2
    c = config.colors
    draw = ImageDraw.Draw(img)

    # 1. Top club identity (y = 256)
    f_club = _load_font(config, 23, "bold")
    y = _draw_centered_top(draw, cx, 256, config.name.upper(), f_club, _hex_rgba(c.gold_soft), tracking=5)
    # Subtle tapered gold accent rule
    rule_y = y + 16
    draw.line([(cx - 110, rule_y), (cx + 110, rule_y)], fill=_hex_rgba(c.gold_accent, 145), width=2)

    # 2. Hero Dual-Crest Lockup (y = 304 .. 494)
    crest_bot = _composite_crest_lockup(img, match_info, config, cx, 304, 190)

    # 3. MATCH HIGHLIGHTS crimson-gold pill (y = 532)
    f_pill = _load_font(config, 23, "extrabold")
    pill_txt = "MATCH HIGHLIGHTS"
    ptw, pth, _ = _measure_tracked(draw, pill_txt, f_pill, tracking=4)
    pw, ph = ptw + 68, pth + 26
    px, py = cx - pw // 2, crest_bot + 36
    pill_panel = _make_clipped_panel(
        pw,
        ph,
        radius=ph // 2,
        fill_top=_hex_rgba(c.maroon_hover, 245),
        fill_bot=_hex_rgba(c.maroon_dark, 245),
        outline=_hex_rgba(c.gold_soft, 165),
        outline_width=2,
    )
    img.alpha_composite(pill_panel, (px, py))
    _draw_centered_top(draw, cx, py + (ph - pth) // 2, pill_txt, f_pill, _hex_rgba(c.pure_white), tracking=4)

    # 4. Structured 3-Tier Matchup Stack (NEVER orphan wraps!)
    team_a, team_b = _split_match_teams(match_info)
    y_match = py + ph + 54
    max_team_w = 880

    if team_b:
        ta_up, tb_up = team_a.upper(), team_b.upper()
        f_ta = _fit_font(draw, config, ta_up, max_team_w, 72, 42, "black")
        f_tb = _fit_font(draw, config, tb_up, max_team_w, 72, 42, "black")
        col_a = _hex_rgba(c.pure_white)
        col_b = _hex_rgba(c.warm_white)

        y_after_a = _draw_centered_top(draw, cx, y_match, ta_up, f_ta, col_a)

        # Gold VS divider
        f_vs = _load_font(config, 26, "extrabold")
        vs_y = y_after_a + 24
        vs_tw, vs_th, _ = _measure_tracked(draw, "VS", f_vs, tracking=4)
        mid_y = vs_y + vs_th // 2
        draw.line([(cx - 190, mid_y), (cx - vs_tw // 2 - 26, mid_y)], fill=_hex_rgba(c.gold_accent, 180), width=2)
        draw.line([(cx + vs_tw // 2 + 26, mid_y), (cx + 190, mid_y)], fill=_hex_rgba(c.gold_accent, 180), width=2)
        y_after_vs = _draw_centered_top(draw, cx, vs_y, "VS", f_vs, _hex_rgba(c.gold_soft), tracking=4)

        y_after_teams = _draw_centered_top(draw, cx, y_after_vs + 22, tb_up, f_tb, col_b)
    else:
        t_up = team_a.upper()
        f_t = _fit_font(draw, config, t_up, max_team_w, 68, 40, "black")
        y_after_teams = _draw_centered_top(draw, cx, y_match + 28, t_up, f_t, _hex_rgba(c.pure_white))

    # 5. Match Metadata (Series • Date / Venue)
    y_meta = y_after_teams + 44
    meta_parts = [p for p in [match_info.series, match_info.date] if p]
    if meta_parts:
        meta_str = "   •   ".join(meta_parts)
        f_meta = _fit_font(draw, config, meta_str, 860, 29, 21, "semibold")
        y_meta = _draw_centered_top(draw, cx, y_meta, meta_str, f_meta, _hex_rgba(c.gold_soft)) + 16
    if match_info.venue:
        f_ven = _fit_font(draw, config, match_info.venue, 840, 25, 19, "medium")
        y_meta = _draw_centered_top(draw, cx, y_meta, match_info.venue, f_ven, _hex_rgba(c.muted_text)) + 16

    # 6. Auto-Computed Highlight Teaser Strip (keeps lower area rich & purposeful, safe from IG right rail)
    teaser_txt = _summarize_teaser_counts(clips) or f"OFFICIAL MATCH RECAP   •   {config.tagline}"
    f_tease = _fit_font(draw, config, teaser_txt, 680, 23, 18, "extrabold", tracking=2)
    ttw, tth, _ = _measure_tracked(draw, teaser_txt, f_tease, tracking=2)
    tw_box = min(770, ttw + 68)
    th_box = tth + 30
    tx_box = cx - tw_box // 2
    ty_box = max(y_meta + 42, 1140)
    ty_box = min(ty_box, 1240)
    tease_panel = _make_clipped_panel(
        tw_box,
        th_box,
        radius=16,
        fill_top=_hex_rgba(c.surface_glass, 218),
        fill_bot=_hex_rgba(c.obsidian_deep, 228),
        outline=_hex_rgba(c.gold_accent, 145),
        outline_width=2,
    )
    img.alpha_composite(tease_panel, (tx_box, ty_box))
    _draw_centered_top(draw, cx, ty_box + (th_box - tth) // 2, teaser_txt, f_tease, _hex_rgba(c.warm_white), tracking=2)

    # 7. Clean Brand Footer (strictly inside IG safe zone & 4:5 grid)
    f_foot = _load_font(config, 23, "bold")
    _draw_centered_top(
        draw,
        cx,
        1382,
        f"{config.instagram_handle}   •   {config.website}",
        f_foot,
        _hex_rgba(c.gold_bright),
        tracking=1,
    )


def render_intro_overlay(
    match_info: MatchInfo,
    config: ClubConfig,
    out_path: Path,
    clips: Sequence[ClipSpec] | None = None,
) -> Path:
    """Render translucent RGBA Stadium Floodlight Intro overlay to composite over live teaser clip."""
    img = _make_stadium_canvas(config, transparent_scrim=True, mood="intro")
    _draw_intro_content(img, match_info, config, clips=clips)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    return out_path


def render_intro_card(
    match_info: MatchInfo,
    config: ClubConfig,
    out_path: Path,
    clips: Sequence[ClipSpec] | None = None,
    bg_frame_path: Path | None = None,
) -> Path:
    """Render full-bleed 1080x1920 Intro slate or Instagram 4:5 Cover image."""
    w, h = config.width, config.height
    if bg_frame_path and bg_frame_path.exists():
        try:
            bg = Image.open(bg_frame_path).convert("RGBA")
            # Cover-crop 16:9 frame into 1080x1920 + moody soft blur
            scale = max(w / bg.width, h / bg.height)
            nw, nh = int(round(bg.width * scale)), int(round(bg.height * scale))
            bg = bg.resize((nw, nh), Image.Resampling.LANCZOS)
            lx, ty = (nw - w) // 2, (nh - h) // 2
            bg = bg.crop((lx, ty, lx + w, ty + h))
            # Downscale-blur-upscale + desaturate to match FFmpeg teaser intro look
            small = bg.resize((270, 480), Image.Resampling.BILINEAR).filter(ImageFilter.GaussianBlur(radius=4))
            arr = np.asarray(small, dtype=np.float32)
            lum = arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114
            for ch in range(3):
                arr[:, :, ch] = np.clip((lum * 0.65 + arr[:, :, ch] * 0.35) * 0.68, 0, 255)
            bg = Image.fromarray(arr.astype(np.uint8), mode="RGBA").resize((w, h), Image.Resampling.BICUBIC)
            scrim = _make_stadium_canvas(config, transparent_scrim=True, mood="intro")
            img = Image.alpha_composite(bg, scrim)
        except Exception:
            img = _make_stadium_canvas(config, transparent_scrim=False, mood="intro")
    else:
        img = _make_stadium_canvas(config, transparent_scrim=False, mood="intro")

    _draw_intro_content(img, match_info, config, clips=clips)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() in {".jpg", ".jpeg"}:
        img.convert("RGB").save(out_path, quality=92, optimize=True)
    else:
        img.convert("RGB").save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# 2. AUTO-INSERTED INNINGS BREAK DIVIDER CARD (1.4s)
# ---------------------------------------------------------------------------


def render_innings_break_card(
    match_info: MatchInfo,
    config: ClubConfig,
    out_path: Path,
) -> Path:
    """Render crisp 1080x1920 Innings Break divider card showing 1st-innings score & target."""
    w = config.width
    cx = w // 2
    c = config.colors
    img = _make_stadium_canvas(config, transparent_scrim=False, mood="break")
    draw = ImageDraw.Draw(img)

    inn1 = next((i for i in match_info.innings if i.innings_number == 1), None)
    inn2 = next((i for i in match_info.innings if i.innings_number == 2), None)

    bat1_team = inn1.batting_team if inn1 else match_info.gscc_team
    chase_team = (inn2.batting_team if inn2 else (inn1.bowling_team if inn1 else match_info.opponent_team)) or "CHASING SIDE"

    # Top pill: INNINGS BREAK
    f_pill = _load_font(config, 24, "extrabold")
    pill_txt = "INNINGS BREAK"
    ptw, pth, _ = _measure_tracked(draw, pill_txt, f_pill, tracking=5)
    pw, ph = ptw + 64, pth + 26
    px, py = cx - pw // 2, 360
    pill = _make_clipped_panel(
        pw,
        ph,
        radius=ph // 2,
        fill_top=_hex_rgba(c.surface_glass, 235),
        outline=_hex_rgba(c.gold_soft, 210),
        outline_width=2,
    )
    img.alpha_composite(pill, (px, py))
    _draw_centered_top(draw, cx, py + (ph - pth) // 2, pill_txt, f_pill, _hex_rgba(c.gold_soft), tracking=5)

    # Crest (1st-innings squad crest if GSCC, else main GSCC crest)
    crest = _load_squad_logo(config, bat1_team, 148) or _load_club_logo(config, 148)
    crest_y = py + ph + 44
    _draw_soft_halo(img, cx, crest_y + crest.height // 2, 130, c.gold_bright, 58)
    img.alpha_composite(crest, (cx - crest.width // 2, crest_y))

    # 1st innings team name
    y = crest_y + crest.height + 36
    f_team = _fit_font(draw, config, bat1_team.upper(), 860, 44, 28, "extrabold")
    y = _draw_centered_top(draw, cx, y, bat1_team.upper(), f_team, _hex_rgba(c.pure_white))

    # Hero Score
    if inn1 and (inn1.runs > 0 or inn1.wickets > 0):
        score_str = f"{inn1.runs}/{inn1.wickets}"
        f_big = _load_font(config, 118, "black")
        y = _draw_centered_top(draw, cx, y + 22, score_str, f_big, _hex_rgba(c.gold_soft))

        rr = _compute_run_rate(inn1.runs, inn1.overs_text)
        ov_disp = _format_overs_display(inn1.overs_text).upper()
        meta_str = f"{ov_disp}   •   {rr}" if rr else ov_disp
        f_ov = _load_font(config, 28, "semibold")
        y = _draw_centered_top(draw, cx, y + 20, meta_str, f_ov, _hex_rgba(c.muted_text), tracking=2)

        # Horizontal gold divider
        div_y = y + 48
        draw.line([(cx - 210, div_y), (cx + 210, div_y)], fill=_hex_rgba(c.gold_accent, 140), width=2)

        # Target callout badge
        target = inn1.runs + 1
        tgt_txt = f"TARGET  {target}"
        f_tgt = _load_font(config, 44, "black")
        ttw, tth, _ = _measure_tracked(draw, tgt_txt, f_tgt, tracking=3)
        tpw, tph = ttw + 76, tth + 34
        tpx, tpy = cx - tpw // 2, div_y + 42
        tgt_pill = _make_clipped_panel(
            tpw,
            tph,
            radius=18,
            fill_top=_hex_rgba(c.crimson_signal, 245),
            fill_bot=_hex_rgba(c.maroon_dark, 245),
            outline=_hex_rgba(c.gold_soft, 175),
            outline_width=2,
        )
        img.alpha_composite(tgt_pill, (tpx, tpy))
        _draw_centered_top(draw, cx, tpy + (tph - tth) // 2, tgt_txt, f_tgt, _hex_rgba(c.pure_white), tracking=3)

        chase_line = f"{chase_team.upper()} NEED {target} TO WIN"
        f_ch = _fit_font(draw, config, chase_line, 860, 26, 18, "bold", tracking=2)
        _draw_centered_top(draw, cx, tpy + tph + 26, chase_line, f_ch, _hex_rgba(c.warm_white), tracking=2)
    else:
        f_big = _load_font(config, 54, "black")
        _draw_centered_top(draw, cx, y + 48, "2ND INNINGS COMING UP", f_big, _hex_rgba(c.gold_soft))

    f_foot = _load_font(config, 22, "bold")
    _draw_centered_top(draw, cx, 1384, f"{config.instagram_handle}   •   {config.website}", f_foot, _hex_rgba(c.gold_accent))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# 3. LIVE BROADCAST CARDS (Split Top Overlay + Slide-In Lower Callout Card)
# ---------------------------------------------------------------------------


def render_clip_top_overlay(
    match_info: MatchInfo,
    clip: ClipSpec,
    config: ClubConfig,
    out_path: Path,
) -> Path:
    """Render static transparent 1080x1920 RGBA overlay: slim Top Bar + 16:9 gold edge hairlines."""
    w, h = config.width, config.height
    c = config.colors
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- 1. SLIM LIVE-CONTEXT TOP BAR (y = 248 .. 376, height = 128px, strictly >= safe_top_y=220) ---
    hdr_x1 = 44
    hdr_y1 = config.safe_top_y + 28  # 248
    hdr_w = w - 88  # 992
    hdr_h = 128

    top_panel = _make_clipped_panel(
        hdr_w,
        hdr_h,
        radius=20,
        fill_top=_hex_rgba(c.surface_glass, 232),
        fill_bot=_hex_rgba(c.obsidian_deep, 240),
        outline=_hex_rgba(c.gold_accent, 145),
        outline_width=2,
        top_bar=(4, _hex_rgba(c.gold_soft, 230)),
    )
    img.alpha_composite(top_panel, (hdr_x1, hdr_y1))

    # Left: Squad Crest (or GSCC Club Crest on derbies / fallback)
    crest = (
        None if match_info.is_derby else _load_squad_logo(config, match_info.gscc_team, 86)
    ) or _load_club_logo(config, 86)
    img.alpha_composite(crest, (hdr_x1 + 20, hdr_y1 + (hdr_h - crest.height) // 2 + 2))

    # Right: Cache-Safe Live Match Phase Pill
    phase_txt, is_clutch = _compute_live_phase_label(match_info, clip)
    f_phase = _load_font(config, 20, "extrabold")
    ptw, pth, _ = _measure_tracked(draw, phase_txt, f_phase, tracking=1)
    ph_w = ptw + 32
    ph_h = pth + 20
    ph_x = hdr_x1 + hdr_w - ph_w - 20
    ph_y = hdr_y1 + (hdr_h - ph_h) // 2 + 2

    if is_clutch:
        p_fill_t, p_fill_b = _hex_rgba(c.crimson_signal, 235), _hex_rgba(c.maroon_dark, 235)
        p_outline, p_fg = _hex_rgba(c.gold_soft, 165), _hex_rgba(c.pure_white)
    else:
        p_fill_t, p_fill_b = _hex_rgba("#27211E", 235), _hex_rgba("#1C1715", 235)
        p_outline, p_fg = _hex_rgba(c.gold_accent, 140), _hex_rgba(c.gold_soft)

    phase_pill = _make_clipped_panel(
        ph_w,
        ph_h,
        radius=12,
        fill_top=p_fill_t,
        fill_bot=p_fill_b,
        outline=p_outline,
        outline_width=1,
    )
    img.alpha_composite(phase_pill, (ph_x, ph_y))
    _draw_text_top(draw, ph_x + 16, ph_y + (ph_h - pth) // 2, phase_txt, f_phase, p_fg, tracking=1)

    # Middle: Matchup Title + Meta (fitted cleanly between crest and phase pill)
    tx = hdr_x1 + 20 + crest.width + 20
    avail_w = max(180, ph_x - tx - 18)

    match_str = match_info.title or config.name
    f_match = _fit_font(draw, config, match_str, avail_w, 30, 21, "extrabold")
    # Truncate cleanly only if still wider than min font
    if _measure_tracked(draw, match_str, f_match)[0] > avail_w:
        while len(match_str) > 8 and _measure_tracked(draw, match_str + "…", f_match)[0] > avail_w:
            match_str = match_str[:-1].rstrip()
        match_str += "…"
    y_t1 = hdr_y1 + 30
    y_after_t1 = _draw_text_top(draw, tx, y_t1, match_str, f_match, _hex_rgba(c.pure_white))[1] + y_t1

    meta_str = " • ".join([p for p in [match_info.series, match_info.date] if p]) or config.name.upper()
    f_meta = _fit_font(draw, config, meta_str, avail_w, 20, 16, "medium")
    if _measure_tracked(draw, meta_str, f_meta)[0] > avail_w:
        while len(meta_str) > 8 and _measure_tracked(draw, meta_str + "…", f_meta)[0] > avail_w:
            meta_str = meta_str[:-1].rstrip()
        meta_str += "…"
    _draw_text_top(draw, tx, y_after_t1 + 12, meta_str, f_meta, _hex_rgba(c.muted_text))

    # --- 2. SLEEK 16:9 VIDEO FRAME TRIM HAIRLINES (y = 518..520 & y = 1128..1130) ---
    vy1 = config.video_y
    vy2 = config.video_y + config.video_height
    # Subtle soft outer drop shadow above & below action window (strictly < vy2 + 10)
    for offset in range(1, 8):
        a = int(90 * (1.0 - offset / 8.0))
        draw.line([(0, vy1 - 2 - offset), (w, vy1 - 2 - offset)], fill=(0, 0, 0, a), width=1)
        draw.line([(0, vy2 + 2 + offset), (w, vy2 + 2 + offset)], fill=(0, 0, 0, a), width=1)
    draw.rectangle([(0, vy1 - 2), (w, vy1)], fill=_hex_rgba(c.gold_accent, 235))
    draw.rectangle([(0, vy2), (w, vy2 + 2)], fill=_hex_rgba(c.gold_accent, 235))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    return out_path


def render_clip_lower_card(
    match_info: MatchInfo,
    clip: ClipSpec,
    config: ClubConfig,
    out_path: Path,
) -> Path:
    """Render standalone 862x294 RGBA Lower Callout Card (animated with delayed slide-in in FFmpeg)."""
    c = config.colors
    cw, ch = LOWER_CARD_W, LOWER_CARD_H
    pill_bg, pill_fg, accent_hex, display_badge = _event_palette(clip, config)

    # Strictly clipped rounded panel with clean 10px left accent bar
    card = _make_clipped_panel(
        cw,
        ch,
        radius=22,
        fill_top=_hex_rgba(c.surface_glass, 240),
        fill_bot=_hex_rgba(c.obsidian_deep, 246),
        outline=_hex_rgba(accent_hex, 155),
        outline_width=2,
        left_bar=(10, _hex_rgba(accent_hex, 255)),
    )
    draw = ImageDraw.Draw(card)

    pad_l = 32
    pad_r = 26
    content_w = cw - pad_l - pad_r

    # --- ROW 1: Event Badge Pill + OVER tag + Right-Aligned Score Delta Pill ---
    f_badge = _load_font(config, 23, "black")
    btw, bth, _ = _measure_tracked(draw, display_badge.upper(), f_badge, tracking=2)
    bw, bh = btw + 34, bth + 18
    by = 22
    badge_pill = _make_clipped_panel(
        bw,
        bh,
        radius=10,
        fill_top=_hex_rgba(pill_bg, 255),
    )
    card.alpha_composite(badge_pill, (pad_l, by))
    _draw_text_top(draw, pad_l + 17, by + (bh - bth) // 2, display_badge.upper(), f_badge, _hex_rgba(pill_fg), tracking=2)

    # Over tag
    f_ov = _load_font(config, 22, "bold")
    ov_txt = f"OV {clip.over_ball}"
    _, ov_h, _ = _measure_tracked(draw, ov_txt, f_ov, tracking=1)
    _draw_text_top(draw, pad_l + bw + 18, by + (bh - ov_h) // 2, ov_txt, f_ov, _hex_rgba(c.gold_soft), tracking=1)

    # Right-aligned Delta + Live Score Pill (resolves pre-ball ticker vs post-ball callout)
    _, _, compact_score = _parse_score_from_text(clip.score_text)
    delta_sym = {
        "four": "+4",
        "six": "+6",
        "wicket": "W",
        "fifty": "50*",
        "hundred": "100*",
        "winning_shot": "WIN",
    }.get(clip.event_type, "")
    delta_txt = f"{delta_sym}  •  {compact_score}" if (delta_sym and compact_score) else (compact_score or delta_sym)
    if delta_txt:
        f_delta = _load_font(config, 21, "extrabold")
        dtw, dth, _ = _measure_tracked(draw, delta_txt, f_delta, tracking=1)
        dw, dh = dtw + 28, bh
        dx = cw - pad_r - dw
        delta_pill = _make_clipped_panel(
            dw,
            dh,
            radius=10,
            fill_top=_hex_rgba("#27211E", 235),
            outline=_hex_rgba(accent_hex, 135),
            outline_width=1,
        )
        card.alpha_composite(delta_pill, (dx, by))
        _draw_text_top(draw, dx + 14, by + (dh - dth) // 2, delta_txt, f_delta, _hex_rgba(c.warm_white), tracking=1)

    # --- ROW 2: Bold Hero Player Name (+ Optional Stat Badge on Right) ---
    hero_line, stat_badge, detail_line = _decompose_clip_copy(clip)
    row2_y = by + bh + 22

    stat_w_used = 0
    if stat_badge:
        f_st = _load_font(config, 26, "extrabold")
        stw, sth, _ = _measure_tracked(draw, stat_badge, f_st)
        sw_p, sh_p = stw + 26, sth + 16
        sx = cw - pad_r - sw_p
        st_pill = _make_clipped_panel(
            sw_p,
            sh_p,
            radius=10,
            fill_top=_hex_rgba("#29221D", 235),
            outline=_hex_rgba(c.gold_accent, 145),
            outline_width=1,
        )
        card.alpha_composite(st_pill, (sx, row2_y + 2))
        _draw_text_top(draw, sx + 13, row2_y + 2 + (sh_p - sth) // 2, stat_badge, f_st, _hex_rgba(c.gold_soft))
        stat_w_used = sw_p + 18

    hero_max_w = max(240, content_w - stat_w_used)
    f_hero = _fit_font(draw, config, hero_line, hero_max_w, 42, 28, "extrabold")
    if _measure_tracked(draw, hero_line, f_hero)[0] > hero_max_w:
        # Wrap to 2 compact lines only if genuinely very long custom headline
        hero_lines = _wrap_pixel_lines(draw, hero_line, _load_font(config, 31, "extrabold"), hero_max_w, max_lines=2)
        f_hero = _load_font(config, 31, "extrabold")
    else:
        hero_lines = [hero_line]

    cur_y = row2_y
    for hl in hero_lines:
        _, hh = _draw_text_top(draw, pad_l, cur_y, hl, f_hero, _hex_rgba(c.pure_white))
        cur_y += hh + 8

    # --- ROW 3: Clean Pixel-Wrapped Detail (ZERO 46-char truncation cliff!) ---
    if detail_line:
        f_sub = _load_font(config, 24, "medium")
        sub_y = max(cur_y + 6, row2_y + 52)
        avail_h = (ch - 64) - sub_y
        max_sub_lines = 2 if avail_h >= 46 else 1
        sub_lines = _wrap_pixel_lines(draw, detail_line, f_sub, content_w, max_lines=max_sub_lines)
        for sl in sub_lines:
            _, sh_t = _draw_text_top(draw, pad_l, sub_y, sl, f_sub, _hex_rgba(c.warm_white, 224))
            sub_y += sh_t + 8

    # --- ROW 4: Subtle Divider + Full Match Score + @goldenstate_cc ---
    div_y = ch - 52
    draw.line([(pad_l, div_y), (cw - pad_r, div_y)], fill=_hex_rgba(c.gold_accent, 52), width=1)

    f_foot = _load_font(config, 20, "bold")
    handle = config.instagram_handle
    htw, hth, _ = _measure_tracked(draw, handle, f_foot)
    foot_y = div_y + (52 - hth) // 2 - 2
    _draw_text_top(draw, cw - pad_r - htw, foot_y, handle, f_foot, _hex_rgba(c.gold_accent))

    score_disp = clip.score_text or ""
    max_sc_w = content_w - htw - 24
    if score_disp:
        f_sc = _fit_font(draw, config, score_disp, max_sc_w, 20, 16, "semibold")
        _draw_text_top(draw, pad_l, foot_y, score_disp, f_sc, _hex_rgba(c.muted_text))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    card.save(out_path)
    return out_path


def render_clip_overlay(
    match_info: MatchInfo,
    clip: ClipSpec,
    config: ClubConfig,
    out_path: Path,
) -> Path:
    """Render full-frame 1080x1920 composite RGBA overlay (Top Bar + Lower Card at rest)."""
    top_tmp = out_path.with_name(out_path.stem + "_top_tmp.png")
    low_tmp = out_path.with_name(out_path.stem + "_low_tmp.png")
    render_clip_top_overlay(match_info, clip, config, top_tmp)
    render_clip_lower_card(match_info, clip, config, low_tmp)

    full = Image.open(top_tmp).convert("RGBA")
    low = Image.open(low_tmp).convert("RGBA")
    card_y = min(config.safe_bottom_y - low.height - 8, config.video_y + config.video_height + LOWER_CARD_Y_OFFSET)
    full.alpha_composite(low, (LOWER_CARD_X, card_y))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    full.save(out_path)

    top_tmp.unlink(missing_ok=True)
    low_tmp.unlink(missing_ok=True)
    return out_path


# ---------------------------------------------------------------------------
# 4. FULL-TIME SCORECARD / OUTRO CARD (4.2s)
# ---------------------------------------------------------------------------


def _outro_status_pill(match_info: MatchInfo) -> str:
    if (match_info.result_text or "").strip():
        return "FULL TIME"
    if len(match_info.innings) >= 2:
        inn2_balls = _overs_to_balls(match_info.innings[1].overs_text)
        if inn2_balls < 30:  # < 5 overs recorded -> partial Part 1 stream!
            return "PART 1 RECAP"
    return "MATCH RECAP"


def render_outro_card(
    match_info: MatchInfo,
    config: ClubConfig,
    out_path: Path,
    clips: Sequence[ClipSpec] | None = None,
) -> Path:
    """Render 1080x1920 broadcast Full-Time Scorecard strictly inside Instagram Safe Zones."""
    w = config.width
    cx = w // 2
    c = config.colors
    img = _make_stadium_canvas(config, transparent_scrim=False, mood="outro")
    draw = ImageDraw.Draw(img)

    # 1. Dual-crest header (y = 250 .. 384)
    crest_bot = _composite_crest_lockup(img, match_info, config, cx, 250, 134)

    # 2. Smart status pill: FULL TIME vs PART 1 RECAP vs MATCH RECAP (y = 414)
    status_txt = _outro_status_pill(match_info)
    f_pill = _load_font(config, 22, "black")
    ptw, pth, _ = _measure_tracked(draw, status_txt, f_pill, tracking=4)
    pw, ph = ptw + 56, pth + 22
    px, py = cx - pw // 2, crest_bot + 28
    pill = _make_clipped_panel(
        pw,
        ph,
        radius=ph // 2,
        fill_top=_hex_rgba(c.gold_soft, 255),
        fill_bot=_hex_rgba(c.gold_accent, 255),
    )
    img.alpha_composite(pill, (px, py))
    _draw_centered_top(draw, cx, py + (ph - pth) // 2, status_txt, f_pill, _hex_rgba(c.obsidian_deep), tracking=4)

    # 3. Result headline (or Matchup title)
    y = py + ph + 26
    result_display = (match_info.result_text or match_info.title).upper()
    f_res = _fit_font(draw, config, result_display, 880, 44, 30, "black")
    res_lines = _wrap_pixel_lines(draw, result_display, f_res, 880, max_lines=2)
    for line in res_lines:
        y = _draw_centered_top(draw, cx, y, line, f_res, _hex_rgba(c.pure_white)) + 8

    meta_parts = [p for p in [match_info.series, match_info.date] if p]
    if meta_parts:
        meta_s = "  •  ".join(meta_parts)
        f_m = _fit_font(draw, config, meta_s, 840, 22, 17, "medium")
        y = _draw_centered_top(draw, cx, y + 6, meta_s, f_m, _hex_rgba(c.muted_text)) + 6

    # 4. Broadcast 2-Row Scoreboard Panel (above IG right-rail buttons!)
    innings = match_info.innings[:2]
    row_h = 104
    sb_w = 900
    sb_h = max(124, len(innings) * row_h)
    sb_x = cx - sb_w // 2
    sb_y = y + 26

    sb_panel = _make_clipped_panel(
        sb_w,
        sb_h,
        radius=22,
        fill_top=_hex_rgba(c.surface_glass, 240),
        fill_bot=_hex_rgba(c.obsidian_deep, 245),
        outline=_hex_rgba(c.gold_accent, 155),
        outline_width=2,
    )
    sb_draw = ImageDraw.Draw(sb_panel)

    for idx, inn in enumerate(innings):
        ry = idx * row_h
        if idx > 0:
            sb_draw.line([(24, ry), (sb_w - 24, ry)], fill=_hex_rgba(c.gold_accent, 55), width=1)

        is_gscc = config.is_gscc_team(inn.batting_team)
        is_win = _is_winning_team(inn.batting_team, match_info.result_text)

        # Winner left edge indicator
        if is_win:
            win_col = _hex_rgba(c.gold_soft if is_gscc else c.crimson_signal, 255)
            sb_draw.rectangle([(0, ry + 14), (8, ry + row_h - 14)], fill=win_col)

        # Team Crest / Monogram badge (54x54)
        bx = 28
        by = ry + (row_h - 54) // 2
        sq_crest = _load_squad_logo(config, inn.batting_team, 54)
        if sq_crest is not None:
            sb_panel.alpha_composite(sq_crest, (bx + (54 - sq_crest.width) // 2, by + (54 - sq_crest.height) // 2))
        else:
            sb_draw.ellipse(
                [(bx, by), (bx + 54, by + 54)],
                fill=_hex_rgba(c.maroon_dark if is_gscc else "#2C2623", 240),
                outline=_hex_rgba(c.gold_accent if is_gscc else "#5B514B", 180),
                width=2,
            )
            init = _team_initials(inn.batting_team)
            f_init = _load_font(config, 20, "extrabold")
            itw, ith, _ = _measure_tracked(sb_draw, init, f_init)
            _draw_text_top(
                sb_draw,
                bx + (54 - itw) / 2,
                by + (54 - ith) / 2,
                init,
                f_init,
                _hex_rgba(c.gold_soft if is_gscc else c.warm_white),
            )

        # Right side: Hero Score + Overs & Run Rate
        score_str = f"{inn.runs}/{inn.wickets}"
        f_sc = _load_font(config, 44, "black")
        sc_w, sc_h, _ = _measure_tracked(sb_draw, score_str, f_sc)
        sc_col = _hex_rgba(c.gold_soft if is_gscc else c.pure_white)
        _draw_text_top(sb_draw, sb_w - 30 - sc_w, ry + 18, score_str, f_sc, sc_col)

        rr = _compute_run_rate(inn.runs, inn.overs_text)
        ov_str = _format_overs_display(inn.overs_text)
        sub_sc = f"{ov_str}  •  {rr}" if rr else ov_str
        f_sub = _load_font(config, 20, "semibold")
        ss_w, _, _ = _measure_tracked(sb_draw, sub_sc, f_sub)
        _draw_text_top(sb_draw, sb_w - 30 - ss_w, ry + 18 + sc_h + 8, sub_sc, f_sub, _hex_rgba(c.muted_text))

        # Left side: Team name (+ subtle WIN pill if winner)
        tx = bx + 72
        max_name_w = sb_w - 30 - max(sc_w, ss_w) - tx - 28
        f_tn = _fit_font(sb_draw, config, inn.batting_team, max(160, max_name_w), 33, 22, "extrabold")
        tn_col = _hex_rgba(c.gold_soft if is_gscc else c.pure_white)
        _, tn_h = _draw_text_top(sb_draw, tx, ry + (row_h - 34) // 2 - (6 if is_win else 0), inn.batting_team, f_tn, tn_col)
        if is_win:
            f_wt = _load_font(config, 16, "extrabold")
            _draw_text_top(
                sb_draw,
                tx,
                ry + (row_h - 34) // 2 - 6 + tn_h + 6,
                "WINNER",
                f_wt,
                _hex_rgba(c.gold_accent if is_gscc else c.crimson_signal),
                tracking=3,
            )

    img.alpha_composite(sb_panel, (sb_x, sb_y))
    cur_y = sb_y + sb_h + 28

    # 5. Separated Player of the Match Pill (aligned with scoreboard left edge, strictly <= safe_right_x)
    lower_x = sb_x  # 90 — exact left-edge alignment with Scoreboard panel!
    lower_w = min(816, config.safe_right_x - lower_x)  # ends at x = 906 <= 910!

    if match_info.player_of_match:
        potm_h = 66
        potm_panel = _make_clipped_panel(
            lower_w,
            potm_h,
            radius=16,
            fill_top=_hex_rgba(c.surface_glass, 232),
            outline=_hex_rgba(c.gold_bright, 170),
            outline_width=2,
        )
        pd = ImageDraw.Draw(potm_panel)
        f_tag = _load_font(config, 18, "black")
        tag_txt = "PLAYER OF THE MATCH"
        ttw, tth, _ = _measure_tracked(pd, tag_txt, f_tag, tracking=2)
        tag_pill = _make_clipped_panel(ttw + 26, 36, radius=10, fill_top=_hex_rgba(c.gold_soft, 255))
        potm_panel.alpha_composite(tag_pill, (16, (potm_h - 36) // 2))
        _draw_text_top(pd, 29, (potm_h - tth) // 2, tag_txt, f_tag, _hex_rgba(c.obsidian_deep), tracking=2)

        nx = 16 + ttw + 26 + 20
        avail_pw = lower_w - nx - 20
        f_pn = _fit_font(pd, config, match_info.player_of_match, max(160, avail_pw), 28, 20, "extrabold")
        _, pnh, _ = _measure_tracked(pd, match_info.player_of_match, f_pn)
        _draw_text_top(pd, nx, (potm_h - pnh) // 2, match_info.player_of_match, f_pn, _hex_rgba(c.pure_white))

        img.alpha_composite(potm_panel, (lower_x, cur_y))
        cur_y += potm_h + 24

    # 6. Structured GSCC STANDOUTS Table (with Ticker-Only auto-fallback!)
    performers = derive_standout_performers(match_info, clips, config)
    if performers and cur_y < 1260:
        f_shdr = _load_font(config, 20, "extrabold")
        hdr_title = "GSCC STANDOUTS"
        _, sh_h = _draw_text_top(draw, lower_x + 4, cur_y, hdr_title, f_shdr, _hex_rgba(c.gold_soft), tracking=4)
        cur_y += sh_h + 14

        max_rows = min(3, max(1, (1340 - cur_y) // 64))
        shown = performers[:max_rows]
        p_row_h = 62
        st_h = len(shown) * p_row_h + 12
        st_panel = _make_clipped_panel(
            lower_w,
            st_h,
            radius=18,
            fill_top=_hex_rgba(c.surface_glass, 232),
            fill_bot=_hex_rgba(c.obsidian_deep, 240),
            outline=_hex_rgba(c.gold_accent, 115),
            outline_width=1,
        )
        sd = ImageDraw.Draw(st_panel)
        f_role = _load_font(config, 16, "black")
        f_stat = _load_font(config, 25, "extrabold")

        for i, perf in enumerate(shown):
            ry = 6 + i * p_row_h
            if i > 0:
                sd.line([(20, ry), (lower_w - 20, ry)], fill=_hex_rgba(c.gold_accent, 42), width=1)

            role, pname, pstat = _parse_performer_row(perf)
            role_bg = c.crimson_signal if role == "BOWL" else c.gold_soft
            role_fg = c.pure_white if role == "BOWL" else c.obsidian_deep
            rb_w, rb_h = 74, 30
            rb = _make_clipped_panel(rb_w, rb_h, radius=8, fill_top=_hex_rgba(role_bg, 245))
            st_panel.alpha_composite(rb, (18, ry + (p_row_h - rb_h) // 2))
            rtw, rth, _ = _measure_tracked(sd, role, f_role, tracking=1)
            _draw_text_top(
                sd,
                18 + (rb_w - rtw) / 2,
                ry + (p_row_h - rth) / 2,
                role,
                f_role,
                _hex_rgba(role_fg),
                tracking=1,
            )

            stat_w = 0
            if pstat:
                stw, sth, _ = _measure_tracked(sd, pstat, f_stat)
                _draw_text_top(sd, lower_w - 22 - stw, ry + (p_row_h - sth) / 2, pstat, f_stat, _hex_rgba(c.gold_soft))
                stat_w = stw + 20

            nx = 18 + rb_w + 18
            avail_nw = max(140, lower_w - nx - 22 - stat_w)
            f_nm = _fit_font(sd, config, pname, avail_nw, 26, 19, "bold")
            _, nm_h, _ = _measure_tracked(sd, pname, f_nm)
            _draw_text_top(sd, nx, ry + (p_row_h - nm_h) / 2, pname, f_nm, _hex_rgba(c.pure_white))

        img.alpha_composite(st_panel, (lower_x, cur_y))

    # 7. Crisp Footer CTA strictly inside IG safe zone
    f_foot = _load_font(config, 23, "bold")
    _draw_centered_top(
        draw,
        cx,
        1386,
        f"FOLLOW {config.instagram_handle}   •   {config.website}",
        f_foot,
        _hex_rgba(c.gold_soft),
        tracking=1,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path
