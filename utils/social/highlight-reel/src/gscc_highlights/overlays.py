"""v2 Stadium Floodlight & Heritage Hybrid broadcast graphics generator (9:16 Safe Zones)."""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from gscc_highlights.config import ClubConfig
from gscc_highlights.framing import (  # noqa: F401  (re-exported for renderer / tests)
    LOWER_CARD_H,
    LOWER_CARD_W,
    LOWER_CARD_X,
    LOWER_CARD_Y_OFFSET,
    Layout,
    build_layout,
)
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
    decor: bool = False,  # decorative gold stripes/chevrons removed by default (looked busy)
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

    if not decor:
        return img

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
    m_streak_six = re.match(
        r"^(?:back-to-back\s+6s|\d+\s+sixes\s+in\s+a\s+row)\s+from\s+(.+?)!?$",
        raw_head,
        flags=re.IGNORECASE,
    )
    m_strike = re.match(
        r"^(.+?)\s+(?:strikes(?:\s*\(Run Out\))?|cleans up .+|claims (?:his\s+)?\d+\w+(?:\s+wicket)?|grabs a \d+\w+|"
        r"completes a (?:5-for|hat-trick)|wraps up .+all out|wraps up the innings|gets the stumping|"
        r"traps .+ LBW|HAT-TRICK|—\s*(?:caught & bowled|stumped))!?$",
        raw_head,
        flags=re.IGNORECASE,
    )

    if m_four:
        hero = m_four.group(1).strip()
        return hero, stat_badge, detail
    if m_six:
        hero = m_six.group(1).strip()
        return hero, stat_badge, detail
    if m_streak_six:
        hero = m_streak_six.group(1).strip()
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


def _innings_monogram(inn: InningsSummary | None, fallback_team: str = "") -> str:
    """Prefer official CricClubs/NCCA batting_code (e.g. 'ALC'), falling back to team initials."""
    if inn is not None:
        code = re.sub(r"[^A-Za-z0-9]", "", (inn.batting_code or "").strip()).upper()
        if 2 <= len(code) <= 4:
            return code
        return _team_initials(inn.batting_team)
    return _team_initials(fallback_team)


def _format_innings_score_pair(inn: InningsSummary, *, uppercase: bool = False) -> tuple[str, str]:
    """Return cricket-native (big_score, sub_line), rendering 10 wickets as '145' + 'ALL OUT • ...'."""
    rr = _compute_run_rate(inn.runs, inn.overs_text)
    ov_str = _format_overs_display(inn.overs_text)
    if uppercase:
        ov_str = ov_str.upper()
    sep = "   •   " if uppercase else "  •  "
    parts = [p for p in [ov_str, rr] if p]
    if inn.wickets >= 10:
        big = str(inn.runs)
        sub = sep.join(["ALL OUT", *parts])
    else:
        big = f"{inn.runs}/{inn.wickets}"
        sub = sep.join(parts)
    return big, sub


def _is_winning_team(team_name: str, result_text: str) -> bool:
    rt = " ".join((result_text or "").lower().split())
    tn = " ".join((team_name or "").lower().split())
    if not rt or not tn:
        return False
    return rt.startswith(tn + " won") or f"{tn} won" in rt

_GENERIC_SERIES = {"", "NCCA"}


def _clean_series(match_info: MatchInfo) -> str:
    """Hide generic fallback series labels (e.g. bare 'NCCA') that look like a mistake on screen."""
    s = " ".join((match_info.series or "").split())
    return "" if s.upper() in _GENERIC_SERIES else s


def _meta_line(match_info: MatchInfo) -> str:
    return "  •  ".join(p for p in [_clean_series(match_info), match_info.date] if p)


def _infer_max_balls(match_info: MatchInfo) -> int:
    """Infer the format length (T20 / 40 / 50 overs) from the longest recorded innings."""
    longest = max((_overs_to_balls(i.overs_text) for i in match_info.innings), default=0) / 6.0
    if longest <= 20.5:
        return 120
    if longest <= 40.5:
        return 240
    return 300


def _gscc_perspective(match_info: MatchInfo, config: ClubConfig) -> str:
    """Return 'win' | 'loss' | 'other' (no result yet, tie, or intra-club derby)."""
    rt = " ".join((match_info.result_text or "").split())
    if not rt or match_info.is_derby:
        return "other"
    m = re.match(r"^(.*?)\s+won\b", rt, flags=re.IGNORECASE)
    if not m:
        return "other"
    return "win" if config.is_gscc_team(m.group(1)) else "loss"


def _result_headline(match_info: MatchInfo, config: ClubConfig) -> tuple[str, str]:
    """Return (outcome-first headline from GSCC's point of view, optional chase-context line)."""
    rt = " ".join((match_info.result_text or "").split())
    persp = _gscc_perspective(match_info, config)
    m = re.match(r"^(?P<team>.*?)\s+won by\s+(?P<margin>.+)$", rt, flags=re.IGNORECASE)
    if persp in {"win", "loss"} and m:
        head = f"{'WON' if persp == 'win' else 'LOST'} BY {m.group('margin').strip().upper()}"
    else:
        head = (rt or match_info.title or "").upper()

    context = ""
    if m:
        winner = m.group("team").strip()
        inn2 = next((i for i in match_info.innings if i.innings_number == 2), None)
        if inn2 and inn2.batting_team.strip().lower() == winner.lower() and "wicket" in m.group("margin").lower():
            left = _infer_max_balls(match_info) - _overs_to_balls(inn2.overs_text)
            if left > 0:
                context = f"{winner} chased it down with {left} ball{'' if left == 1 else 's'} to spare"
    return head, context


def _intro_hook_text(match_info: MatchInfo, config: ClubConfig) -> str:
    """Stakes line for the intro: result on a win, score line on other completed games, chase target if partial."""
    persp = _gscc_perspective(match_info, config)
    if persp == "win":
        return _result_headline(match_info, config)[0]
    inns = sorted(match_info.innings, key=lambda i: i.innings_number)
    if (match_info.result_text or "").strip():
        if len(inns) >= 2:
            a, b = inns[0], inns[1]
            return (
                f"{_team_initials(a.batting_team)} {a.runs}/{a.wickets}   •   "
                f"{_team_initials(b.batting_team)} {b.runs}/{b.wickets}"
            )
        return ""
    inn1 = inns[0] if inns else None
    if inn1 and inn1.runs > 0 and not match_info.is_derby:
        if config.is_gscc_team(inn1.batting_team):
            return f"{inn1.runs}/{inn1.wickets}  ({_format_overs_display(inn1.overs_text).upper()})"
        return f"CHASING {inn1.runs + 1}"
    return ""


def _potm_is_gscc(match_info: MatchInfo, config: ClubConfig, performers: Sequence[str]) -> bool:
    """Player of the Match is shown prominently only when he is (very likely) a GSCC player."""
    p = " ".join((match_info.player_of_match or "").lower().split())
    if not p:
        return False
    for perf in performers:
        if p in " ".join(perf.lower().split()):
            return True
    return _gscc_perspective(match_info, config) == "win"


_HOW_OUT_RE = re.compile(
    r"^(?P<bat>.+?)\s+(?P<how>(?:c\s*&\s*b|c|b|lbw|st|hit wicket)\b.*?)\s+(?P<score>\d+\*?\s*\(\d+(?:\s+balls?)?\))\s*$"
)
_TICKER_OUT_RE = re.compile(r"^(?P<bat>.+?)\s+OUT\s*\((?P<runs>\d+)\s+off\s+(?P<balls>\d+)\)\s*$", flags=re.IGNORECASE)


def _decompose_card_copy(clip: ClipSpec) -> tuple[str, str, str]:
    """Like _decompose_clip_copy but for the lower card: on a wicket the DISMISSED BATTER is the hero line."""
    hero, stat, detail = _decompose_clip_copy(clip)
    if clip.event_type != "wicket" or _is_run_out_clip(clip):
        return hero, stat, detail
    raw_sub = _sanitize_stat_text(clip.subtext)
    m = _HOW_OUT_RE.match(raw_sub)
    if m:
        score = re.sub(r"\s+balls?", "", m.group("score"), flags=re.IGNORECASE)
        return m.group("bat").strip(), score, m.group("how").strip()
    m = _TICKER_OUT_RE.match(raw_sub)
    if m:
        bowler = hero if hero and hero != raw_sub else " ".join((clip.headline or "").split())
        bowler = re.sub(r"\s+strikes!?$", "", bowler, flags=re.IGNORECASE)
        return m.group("bat").strip(), f"{m.group('runs')} ({m.group('balls')})", (f"Bowler: {bowler}" if bowler else "")
    return hero, stat, detail


def _split_team_score(score_text: str) -> tuple[str, str]:
    """Split 'GSCC Bulls 25/0 (1.4 ov)' into ('GSCC Bulls', '1.4 ov')."""
    m = re.match(r"^(.*?)\s*\d+\s*/\s*\d+\s*(?:\(([^)]*)\))?", score_text or "")
    if not m:
        return (score_text or "").strip(), ""
    return m.group(1).strip(), (m.group(2) or "").strip()



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

    # 1. Top club identity
    f_club = _load_font(config, 24, "bold")
    y = _draw_centered_top(draw, cx, 258, config.name.upper(), f_club, _hex_rgba(c.gold_soft), tracking=5)
    rule_y = y + 16
    draw.line([(cx - 110, rule_y), (cx + 110, rule_y)], fill=_hex_rgba(c.gold_accent, 145), width=2)

    # 2. Hero Dual-Crest Lockup
    crest_bot = _composite_crest_lockup(img, match_info, config, cx, 322, 200)

    # 3. MATCH HIGHLIGHTS crimson pill
    f_pill = _load_font(config, 24, "extrabold")
    pill_txt = "MATCH HIGHLIGHTS"
    ptw, pth, _ = _measure_tracked(draw, pill_txt, f_pill, tracking=4)
    pw, ph = ptw + 68, pth + 26
    px, py = cx - pw // 2, crest_bot + 40
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

    # 4. Matchup stack (never orphan-wraps; both teams share one font size)
    team_a, team_b = _split_match_teams(match_info)
    y_match = py + ph + 64
    max_team_w = 900

    if team_b:
        ta_up, tb_up = team_a.upper(), team_b.upper()
        size = min(
            getattr(_fit_font(draw, config, ta_up, max_team_w, 104, 46, "black"), "size", 72),
            getattr(_fit_font(draw, config, tb_up, max_team_w, 104, 46, "black"), "size", 72),
        )
        f_team = _load_font(config, size, "black")
        y_after_a = _draw_centered_top(draw, cx, y_match, ta_up, f_team, _hex_rgba(c.pure_white))

        f_vs = _load_font(config, 28, "extrabold")
        vs_y = y_after_a + 26
        vs_tw, vs_th, _ = _measure_tracked(draw, "VS", f_vs, tracking=4)
        mid_y = vs_y + vs_th // 2
        draw.line([(cx - 200, mid_y), (cx - vs_tw // 2 - 26, mid_y)], fill=_hex_rgba(c.gold_accent, 180), width=2)
        draw.line([(cx + vs_tw // 2 + 26, mid_y), (cx + 200, mid_y)], fill=_hex_rgba(c.gold_accent, 180), width=2)
        y_after_vs = _draw_centered_top(draw, cx, vs_y, "VS", f_vs, _hex_rgba(c.gold_soft), tracking=4)
        y_after_teams = _draw_centered_top(draw, cx, y_after_vs + 24, tb_up, f_team, _hex_rgba(c.warm_white))
    else:
        t_up = team_a.upper()
        f_t = _fit_font(draw, config, t_up, max_team_w, 96, 44, "black")
        y_after_teams = _draw_centered_top(draw, cx, y_match + 28, t_up, f_t, _hex_rgba(c.pure_white))

    # 5. Match metadata (hides generic 'NCCA' series fallback)
    y_meta = y_after_teams + 46
    meta_str = _meta_line(match_info)
    if meta_str:
        f_meta = _fit_font(draw, config, meta_str, 860, 31, 21, "semibold")
        y_meta = _draw_centered_top(draw, cx, y_meta, meta_str, f_meta, _hex_rgba(c.gold_soft)) + 16
    if match_info.venue:
        f_ven = _fit_font(draw, config, match_info.venue, 840, 26, 19, "medium")
        y_meta = _draw_centered_top(draw, cx, y_meta, match_info.venue, f_ven, _hex_rgba(c.muted_text)) + 16

    # 6. Stakes / hook chip (result on a win, score line on other results, chase target on partial streams)
    hook = _intro_hook_text(match_info, config)
    if hook:
        f_hook = _fit_font(draw, config, hook, 800, 42, 26, "black", tracking=3)
        htw, hth, _ = _measure_tracked(draw, hook, f_hook, tracking=3)
        hw, hh = htw + 84, hth + 46
        hx_, hy_ = cx - hw // 2, min(max(y_meta + 56, 1100), 1250)
        chip = _make_clipped_panel(
            hw,
            hh,
            radius=hh // 2,
            fill_top=_hex_rgba(c.gold_soft, 255),
            fill_bot=_hex_rgba(c.gold_accent, 255),
        )
        img.alpha_composite(chip, (hx_, hy_))
        _draw_centered_top(draw, cx, hy_ + (hh - hth) // 2, hook, f_hook, _hex_rgba(c.obsidian_deep), tracking=3)

    # 7. Clean brand footer (strictly inside IG safe zone & 4:5 grid)
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
    clips: Sequence[ClipSpec] | None = None,
) -> Path:
    """Render 1080x1920 Innings Break card: 1st-innings score, chase maths and GSCC's own contributors."""
    bx = 60
    bw = config.safe_right_x - bx - 4  # 846px inside IG safe_right_x (910)
    cx = bx + bw // 2  # unified safe-zone visual axis (483px)
    c = config.colors
    img = _make_stadium_canvas(config, transparent_scrim=False, mood="break")
    draw = ImageDraw.Draw(img)

    inn1 = next((i for i in match_info.innings if i.innings_number == 1), None)
    inn2 = next((i for i in match_info.innings if i.innings_number == 2), None)
    bat1_team = inn1.batting_team if inn1 else match_info.gscc_team
    bat1_is_gscc = config.is_gscc_team(bat1_team)

    # Top pill: INNINGS BREAK
    f_pill = _load_font(config, 24, "extrabold")
    pill_txt = "INNINGS BREAK"
    ptw, pth, _ = _measure_tracked(draw, pill_txt, f_pill, tracking=5)
    pw, ph = ptw + 64, pth + 26
    px, py = cx - pw // 2, 300
    pill = _make_clipped_panel(
        pw, ph, radius=ph // 2, fill_top=_hex_rgba(c.surface_glass, 235), outline=_hex_rgba(c.gold_soft, 210), outline_width=2
    )
    img.alpha_composite(pill, (px, py))
    _draw_centered_top(draw, cx, py + (ph - pth) // 2, pill_txt, f_pill, _hex_rgba(c.gold_soft), tracking=5)

    # Crest: GSCC squad crest when GSCC batted; otherwise an OPPONENT monogram ring (never the GSCC crest!)
    crest_y = py + ph + 40
    ring = 150
    squad = _load_squad_logo(config, bat1_team, ring) if bat1_is_gscc else None
    if squad is not None:
        _draw_soft_halo(img, cx, crest_y + squad.height // 2, 130, c.gold_bright, 58)
        img.alpha_composite(squad, (cx - squad.width // 2, crest_y))
        crest_h = squad.height
    else:
        draw.ellipse(
            [(cx - ring // 2, crest_y), (cx + ring // 2, crest_y + ring)],
            fill=_hex_rgba("#2C2623", 245),
            outline=_hex_rgba(c.gold_accent, 205),
            width=3,
        )
        init = _innings_monogram(inn1, bat1_team)
        f_init = _load_font(config, 44 if len(init) >= 3 else 50, "black")
        itw, ith, _ = _measure_tracked(draw, init, f_init)
        _draw_text_top(draw, cx - itw / 2, crest_y + (ring - ith) / 2, init, f_init, _hex_rgba(c.warm_white))
        crest_h = ring

    y = crest_y + crest_h + 30
    f_team = _fit_font(draw, config, bat1_team.upper(), bw, 46, 28, "black")
    y = _draw_centered_top(draw, cx, y, bat1_team.upper(), f_team, _hex_rgba(c.pure_white))

    if inn1 and (inn1.runs > 0 or inn1.wickets > 0):
        score_str, meta_str = _format_innings_score_pair(inn1, uppercase=True)
        f_big = _fit_font(draw, config, score_str, bw, 190, 100, "black")
        y = _draw_centered_top(draw, cx, y + 26, score_str, f_big, _hex_rgba(c.gold_soft))

        f_ov = _fit_font(draw, config, meta_str, bw, 28, 19, "semibold", tracking=3)
        y = _draw_centered_top(draw, cx, y + 22, meta_str, f_ov, _hex_rgba(c.muted_text), tracking=3)

        div_y = y + 44
        draw.line([(cx - 210, div_y), (cx + 210, div_y)], fill=_hex_rgba(c.gold_accent, 160), width=2)

        target = inn1.runs + 1
        tgt_txt = f"TARGET  {target}"
        f_tgt = _load_font(config, 46, "black")
        ttw, tth, _ = _measure_tracked(draw, tgt_txt, f_tgt, tracking=4)
        tpw, tph = ttw + 88, tth + 38
        tpx, tpy = cx - tpw // 2, div_y + 38
        tgt_pill = _make_clipped_panel(
            tpw,
            tph,
            radius=tph // 2,
            fill_top=_hex_rgba(c.crimson_signal, 255),
            fill_bot=_hex_rgba(c.maroon_dark, 255),
            outline=_hex_rgba(c.gold_soft, 175),
            outline_width=2,
        )
        img.alpha_composite(tgt_pill, (tpx, tpy))
        _draw_centered_top(draw, cx, tpy + (tph - tth) // 2, tgt_txt, f_tgt, _hex_rgba(c.pure_white), tracking=4)
        y = tpy + tph

        # Chase maths (replaces the redundant 'X NEED N TO WIN' line)
        max_balls = _infer_max_balls(match_info)
        rrr = target / (max_balls / 6.0)
        chase_line = f"{target} OFF {max_balls} BALLS   •   RRR {rrr:.2f}"
        f_ch = _fit_font(draw, config, chase_line, bw, 30, 20, "extrabold", tracking=3)
        y = _draw_centered_top(draw, cx, y + 28, chase_line, f_ch, _hex_rgba(c.warm_white), tracking=3)

        # GSCC's own contributors in the 1st innings (bowlers if we fielded, batters if we batted)
        if not match_info.is_derby:
            role = "BAT" if bat1_is_gscc else "BOWL"
            pool = [cl for cl in (clips or []) if cl.innings_number == 1]
            perfs = derive_standout_performers(match_info, pool if pool else clips, config)
            rows = []
            for p in perfs:
                r, nm, st = _parse_performer_row(p)
                if r == role and nm:
                    rows.append((r, nm, st))
            rows = rows[:2]
            if rows:
                squad_label = (match_info.gscc_team or "GSCC").upper().replace("GSCC ", "")
                hdr = f"{squad_label} WITH THE {'BAT' if role == 'BAT' else 'BALL'}"
                lx, lw = bx, bw
                y += 54
                _, sh_h = _draw_text_top(draw, lx + 4, y, hdr, _load_font(config, 20, "extrabold"), _hex_rgba(c.gold_soft), tracking=5)
                y += sh_h + 16
                row_h = 76
                panel = _make_clipped_panel(
                    lw,
                    row_h * len(rows) + 10,
                    radius=20,
                    fill_top=_hex_rgba(c.surface_glass, 232),
                    fill_bot=_hex_rgba(c.obsidian_deep, 240),
                    outline=_hex_rgba(c.gold_accent, 110),
                    outline_width=1,
                )
                img.alpha_composite(panel, (lx, y))
                draw = ImageDraw.Draw(img)
                for i, (r, nm, st) in enumerate(rows):
                    ry = y + 5 + i * row_h
                    if i:
                        draw.line([(lx + 24, ry), (lx + lw - 24, ry)], fill=_hex_rgba(c.gold_accent, 45), width=1)
                    rb_bg = c.crimson_signal if r == "BOWL" else c.gold_soft
                    rb_fg = c.pure_white if r == "BOWL" else c.obsidian_deep
                    rb = _make_clipped_panel(92, 34, radius=10, fill_top=_hex_rgba(rb_bg, 245))
                    img.alpha_composite(rb, (lx + 24, ry + (row_h - 34) // 2))
                    f_role = _load_font(config, 18, "black")
                    rtw, rth, _ = _measure_tracked(draw, r, f_role, tracking=1)
                    _draw_text_top(draw, lx + 24 + (92 - rtw) / 2, ry + (row_h - rth) / 2, r, f_role, _hex_rgba(rb_fg), tracking=1)
                    f_st = _load_font(config, 30, "extrabold")
                    stw, sth, _ = _measure_tracked(draw, st, f_st)
                    if st:
                        _draw_text_top(draw, lx + lw - 28 - stw, ry + (row_h - sth) / 2, st, f_st, _hex_rgba(c.gold_soft))
                    f_nm = _fit_font(draw, config, nm, lw - 148 - stw - 60, 32, 20, "bold")
                    _, nh, _ = _measure_tracked(draw, nm, f_nm)
                    _draw_text_top(draw, lx + 140, ry + (row_h - nh) / 2, nm, f_nm, _hex_rgba(c.pure_white))
    else:
        f_big = _load_font(config, 54, "black")
        _draw_centered_top(draw, cx, y + 48, "2ND INNINGS COMING UP", f_big, _hex_rgba(c.gold_soft))

    f_foot = _load_font(config, 22, "bold")
    _draw_centered_top(draw, cx, 1408, f"{config.instagram_handle}   •   {config.website}", f_foot, _hex_rgba(c.gold_accent))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# 3. LIVE BROADCAST CARDS (Split Top Overlay + Slide-In Lower Callout Card)
# ---------------------------------------------------------------------------


def render_clip_backdrop(config: ClubConfig, out_path: Path) -> Path:
    """Static brand backdrop (no decorative lines) shown behind the video band of every clip."""
    img = _make_stadium_canvas(config, transparent_scrim=False, mood="break", decor=False)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path


def render_clip_top_overlay(
    match_info: MatchInfo,
    clip: ClipSpec,
    config: ClubConfig,
    out_path: Path,
    layout: Layout | None = None,
    clip_index: int | None = None,
    clip_total: int | None = None,
    innings_split: int | None = None,
) -> Path:
    """Render static transparent 1080x1920 RGBA overlay: slim Top Bar, video hairlines and reel progress bar."""
    w, h = config.width, config.height
    c = config.colors
    layout = layout or build_layout(config, None)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- 1. SLIM LIVE-CONTEXT TOP BAR ---
    hdr_x1 = 44
    hdr_y1 = layout.header_y
    hdr_w = w - 88  # 992
    hdr_h = layout.header_h

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
    crest_px = min(86, hdr_h - 26)
    crest = (
        None if match_info.is_derby else _load_squad_logo(config, match_info.gscc_team, crest_px)
    ) or _load_club_logo(config, crest_px)
    img.alpha_composite(crest, (hdr_x1 + 20, hdr_y1 + (hdr_h - crest.height) // 2 + 2))

    # Right: Cache-Safe Live Match Phase Pill
    phase_txt, is_clutch = _compute_live_phase_label(match_info, clip)
    f_phase = _load_font(config, 20, "extrabold")
    ptw, pth, _ = _measure_tracked(draw, phase_txt, f_phase, tracking=1)
    ph_w = ptw + 32
    ph_h = pth + 20
    ph_x = hdr_x1 + hdr_w - ph_w - 20
    ph_y = hdr_y1 + (hdr_h - ph_h) // 2 + 2

    is_chase_pill = phase_txt.startswith("NEED ") or phase_txt == "TARGET CHASED"
    if is_clutch:
        p_fill_t, p_fill_b = _hex_rgba(c.crimson_signal, 245), _hex_rgba(c.maroon_dark, 245)
        p_outline, p_fg = _hex_rgba(c.gold_soft, 180), _hex_rgba(c.pure_white)
    elif is_chase_pill:
        # Solid gold chase pill so 'NEED 37 OFF 49' is instantly scannable above the video
        p_fill_t, p_fill_b = _hex_rgba(c.gold_soft, 255), _hex_rgba(c.gold_accent, 255)
        p_outline, p_fg = None, _hex_rgba(c.obsidian_deep)
    else:
        p_fill_t, p_fill_b = _hex_rgba("#27211E", 235), _hex_rgba("#1C1715", 235)
        p_outline, p_fg = _hex_rgba(c.gold_accent, 140), _hex_rgba(c.gold_soft)

    phase_pill = _make_clipped_panel(
        ph_w, ph_h, radius=12, fill_top=p_fill_t, fill_bot=p_fill_b, outline=p_outline, outline_width=1 if p_outline else 0
    )
    img.alpha_composite(phase_pill, (ph_x, ph_y))
    _draw_text_top(draw, ph_x + 16, ph_y + (ph_h - pth) // 2, phase_txt, f_phase, p_fg, tracking=1)

    # Middle: Matchup Title + Meta (fitted cleanly between crest and phase pill, vertically centred)
    tx = hdr_x1 + 20 + crest.width + 20
    avail_w = max(180, ph_x - tx - 18)

    match_str = match_info.title or config.name
    f_match = _fit_font(draw, config, match_str, avail_w, 30, 21, "extrabold")
    if _measure_tracked(draw, match_str, f_match)[0] > avail_w:
        while len(match_str) > 8 and _measure_tracked(draw, match_str + "…", f_match)[0] > avail_w:
            match_str = match_str[:-1].rstrip()
        match_str += "…"

    meta_str = _meta_line(match_info) or config.name.upper()
    f_meta = _fit_font(draw, config, meta_str, avail_w, 20, 16, "medium")
    if _measure_tracked(draw, meta_str, f_meta)[0] > avail_w:
        while len(meta_str) > 8 and _measure_tracked(draw, meta_str + "…", f_meta)[0] > avail_w:
            meta_str = meta_str[:-1].rstrip()
        meta_str += "…"

    _, mh, _ = _measure_tracked(draw, match_str, f_match)
    _, sh, _ = _measure_tracked(draw, meta_str, f_meta)
    block_h = mh + 12 + sh
    y_t1 = hdr_y1 + max(14, (hdr_h - block_h) // 2 + 2)
    _draw_text_top(draw, tx, y_t1, match_str, f_match, _hex_rgba(c.pure_white))
    _draw_text_top(draw, tx, y_t1 + mh + 12, meta_str, f_meta, _hex_rgba(c.muted_text))

    # --- 2. VIDEO FRAME TRIM HAIRLINES ---
    vy1 = layout.video_y
    vy2 = layout.video_y + layout.video_h
    for offset in range(1, 8):
        a = int(90 * (1.0 - offset / 8.0))
        draw.line([(0, vy1 - 2 - offset), (w, vy1 - 2 - offset)], fill=(0, 0, 0, a), width=1)
        draw.line([(0, vy2 + 2 + offset), (w, vy2 + 2 + offset)], fill=(0, 0, 0, a), width=1)
    draw.rectangle([(0, vy1 - 2), (w, vy1)], fill=_hex_rgba(c.gold_accent, 235))
    draw.rectangle([(0, vy2), (w, vy2 + 2)], fill=_hex_rgba(c.gold_accent, 235))

    # --- 3. REEL PROGRESS: one thin bar + innings-break notch + active-innings gold highlight + "N / TOTAL" ---
    if layout.progress_y is not None and clip_total and clip_index is not None and clip_total > 1:
        bx0, bx1, by0 = LOWER_CARD_X, LOWER_CARD_X + LOWER_CARD_W, layout.progress_y
        draw.rounded_rectangle([(bx0, by0), (bx1, by0 + 6)], radius=3, fill=_hex_rgba(c.warm_white, 60))
        done_x = bx0 + int((bx1 - bx0) * (clip_index + 1) / clip_total)
        draw.rounded_rectangle([(bx0, by0), (done_x, by0 + 6)], radius=3, fill=_hex_rgba(c.gold_soft, 255))
        f_cnt = _load_font(config, 22, "extrabold")
        cnt = f"{clip_index + 1} / {clip_total}"
        cw_, _, _ = _measure_tracked(draw, cnt, f_cnt, tracking=2)
        cnt_x = bx1 - cw_
        _draw_text_top(draw, cnt_x, by0 + 20, cnt, f_cnt, _hex_rgba(c.gold_soft), tracking=2)
        if innings_split is not None and 0 < innings_split < clip_total:
            nx = bx0 + int((bx1 - bx0) * innings_split / clip_total)
            draw.rectangle([(nx - 1, by0 - 5), (nx + 1, by0 + 11)], fill=_hex_rgba(c.pure_white, 225))
            in1_active = clip.innings_number == 1
            f_off = _load_font(config, 18, "bold")
            f_on = _load_font(config, 18, "black")
            col_off = _hex_rgba(c.muted_text, 150)
            col_on = _hex_rgba(c.gold_soft, 255)
            lbl1_w, _, _ = _measure_tracked(draw, "1ST INN", f_on if in1_active else f_off, tracking=3)
            _draw_text_top(draw, bx0, by0 + 22, "1ST INN", f_on if in1_active else f_off, col_on if in1_active else col_off, tracking=3)
            lbl2_f = f_off if in1_active else f_on
            lbl2_w, _, _ = _measure_tracked(draw, "2ND INN", lbl2_f, tracking=3)
            # Place '2ND INN' right at the notch, clamped cleanly between '1ST INN' and 'N / TOTAL'
            x2 = max(bx0 + lbl1_w + 26, min(nx + 10, cnt_x - lbl2_w - 22))
            _draw_text_top(draw, x2, by0 + 22, "2ND INN", lbl2_f, col_off if in1_active else col_on, tracking=3)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    return out_path


def render_clip_lower_card(
    match_info: MatchInfo,
    clip: ClipSpec,
    config: ClubConfig,
    out_path: Path,
) -> Path:
    """Render standalone 862x262 RGBA Lower Callout Card (animated with delayed slide-in in FFmpeg)."""
    c = config.colors
    cw, ch = LOWER_CARD_W, LOWER_CARD_H
    pill_bg, pill_fg, accent_hex, display_badge = _event_palette(clip, config)

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

    pad_l = 34
    pad_r = 28
    content_w = cw - pad_l - pad_r

    # --- ROW 1: Event badge + OVER tag (left) | big live score (right, replaces tiny ticker + footer duplicate) ---
    f_badge = _load_font(config, 25, "black")
    btw, bth, _ = _measure_tracked(draw, display_badge.upper(), f_badge, tracking=2)
    bw, bh = btw + 36, bth + 18
    by = 22
    badge_pill = _make_clipped_panel(bw, bh, radius=10, fill_top=_hex_rgba(pill_bg, 255))
    card.alpha_composite(badge_pill, (pad_l, by))
    _draw_text_top(draw, pad_l + 18, by + (bh - bth) // 2, display_badge.upper(), f_badge, _hex_rgba(pill_fg), tracking=2)

    f_ov = _load_font(config, 23, "bold")
    ov_txt = f"OVER {clip.over_ball}"
    _, ov_h, _ = _measure_tracked(draw, ov_txt, f_ov, tracking=1)
    _draw_text_top(draw, pad_l + bw + 18, by + (bh - ov_h) // 2, ov_txt, f_ov, _hex_rgba(c.gold_soft), tracking=1)

    _, _, compact_score = _parse_score_from_text(clip.score_text)
    if compact_score:
        f_sc = _load_font(config, 46, "black")
        scw, sch, _ = _measure_tracked(draw, compact_score, f_sc)
        _draw_text_top(draw, cw - pad_r - scw, by + (bh - sch) // 2 - 2, compact_score, f_sc, _hex_rgba(c.pure_white))

    # --- ROW 2: Bold hero line (batter; for a wicket = the DISMISSED batter) ---
    hero_line, stat_badge, detail_line = _decompose_card_copy(clip)
    row2_y = by + bh + 20
    f_hero = _fit_font(draw, config, hero_line, content_w, 60, 34, "black")
    if _measure_tracked(draw, hero_line, f_hero)[0] > content_w:
        f_hero = _load_font(config, 36, "black")
        hero_lines = _wrap_pixel_lines(draw, hero_line, f_hero, content_w, max_lines=2)
    else:
        hero_lines = [hero_line]
    cur_y = row2_y
    for hl in hero_lines:
        _, hh = _draw_text_top(draw, pad_l, cur_y, hl, f_hero, _hex_rgba(c.pure_white))
        cur_y += hh + 8

    # --- ROW 3: batter score (gold) + detail (muted) on one line ---
    row3_y = cur_y + 10
    x_cursor = pad_l
    if stat_badge:
        f_st = _load_font(config, 38, "black")
        stw, sth, _ = _measure_tracked(draw, stat_badge, f_st)
        _draw_text_top(draw, x_cursor, row3_y, stat_badge, f_st, _hex_rgba(c.gold_soft))
        x_cursor += stw + 22
        detail_y = row3_y + max(0, (sth - 24) // 2) + 2
    else:
        detail_y = row3_y
    if detail_line:
        f_sub = _fit_font(draw, config, detail_line, max(160, cw - pad_r - x_cursor), 28, 19, "medium")
        _draw_text_top(
            draw, x_cursor, detail_y, detail_line, f_sub, _hex_rgba(c.muted_text if stat_badge else c.warm_white, 235)
        )

    # --- ROW 4: Divider + batting team / innings context (left, no duplicate over) + @goldenstate_cc (right) ---
    div_y = ch - 52
    draw.line([(pad_l, div_y), (cw - pad_r, div_y)], fill=_hex_rgba(c.gold_accent, 52), width=1)

    f_foot = _load_font(config, 20, "bold")
    handle = config.instagram_handle
    htw, hth, _ = _measure_tracked(draw, handle, f_foot)
    foot_y = div_y + (52 - hth) // 2 - 2
    _draw_text_top(draw, cw - pad_r - htw, foot_y, handle, f_foot, _hex_rgba(c.gold_accent))

    team_nm, _ = _split_team_score(clip.score_text)
    if clip.innings_number == 2:
        inn1 = next((i for i in match_info.innings if i.innings_number == 1), None)
        ctx_tag = f"Chasing {inn1.runs + 1}" if (inn1 and inn1.runs > 0) else "2nd Innings"
    else:
        ctx_tag = "1st Innings"
    foot_left = "  •  ".join(p for p in [team_nm, ctx_tag] if p) or (clip.score_text or "")
    if foot_left:
        f_fl = _fit_font(draw, config, foot_left, content_w - htw - 24, 20, 16, "semibold")
        _draw_text_top(draw, pad_l, foot_y, foot_left, f_fl, _hex_rgba(c.muted_text))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    card.save(out_path)
    return out_path


def render_clip_overlay(
    match_info: MatchInfo,
    clip: ClipSpec,
    config: ClubConfig,
    out_path: Path,
    layout: Layout | None = None,
    clip_index: int | None = None,
    clip_total: int | None = None,
) -> Path:
    """Render full-frame 1080x1920 composite RGBA overlay (Top Bar + Lower Card at rest)."""
    layout = layout or build_layout(config, None)
    top_tmp = out_path.with_name(out_path.stem + "_top_tmp.png")
    low_tmp = out_path.with_name(out_path.stem + "_low_tmp.png")
    render_clip_top_overlay(match_info, clip, config, top_tmp, layout=layout, clip_index=clip_index, clip_total=clip_total)
    render_clip_lower_card(match_info, clip, config, low_tmp)

    full = Image.open(top_tmp).convert("RGBA")
    low = Image.open(low_tmp).convert("RGBA")
    full.alpha_composite(low, (LOWER_CARD_X, layout.card_y))
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
    return "MATCH SUMMARY"  # stream stopped midway: summarise what we have (no 'to be continued')


def render_outro_card(
    match_info: MatchInfo,
    config: ClubConfig,
    out_path: Path,
    clips: Sequence[ClipSpec] | None = None,
) -> Path:
    """Render 1080x1920 broadcast Full-Time Scorecard aligned on the unified IG safe-zone axis."""
    bx = 60
    bw = config.safe_right_x - bx - 4  # 846px inside IG right-rail safe zone
    cx = bx + bw // 2  # unified vertical axis (483px) shared by header, cards, and footer
    c = config.colors
    img = _make_stadium_canvas(config, transparent_scrim=False, mood="outro")
    draw = ImageDraw.Draw(img)

    # 1. Dual-crest header
    crest_bot = _composite_crest_lockup(img, match_info, config, cx, 240, 114)

    # 2. Status pill: FULL TIME vs MATCH SUMMARY
    status_txt = _outro_status_pill(match_info)
    f_pill = _load_font(config, 22, "black")
    ptw, pth, _ = _measure_tracked(draw, status_txt, f_pill, tracking=4)
    pw, ph = ptw + 56, pth + 22
    px, py = cx - pw // 2, crest_bot + 22
    pill = _make_clipped_panel(
        pw, ph, radius=ph // 2, fill_top=_hex_rgba(c.gold_soft, 255), fill_bot=_hex_rgba(c.gold_accent, 255)
    )
    img.alpha_composite(pill, (px, py))
    _draw_centered_top(draw, cx, py + (ph - pth) // 2, status_txt, f_pill, _hex_rgba(c.obsidian_deep), tracking=4)

    # 3. Outcome-first headline (GSCC point of view) + chase context + meta
    head, context = _result_headline(match_info, config)
    y = py + ph + 28
    f_res = _fit_font(draw, config, head, bw, 84, 38, "black")
    res_lines = _wrap_pixel_lines(draw, head, f_res, bw, max_lines=2)
    for line in res_lines:
        y = _draw_centered_top(draw, cx, y, line, f_res, _hex_rgba(c.pure_white)) + 10
    if context:
        f_ctx = _fit_font(draw, config, context, bw, 26, 18, "medium")
        y = _draw_centered_top(draw, cx, y + 6, context, f_ctx, _hex_rgba(c.warm_white, 225)) + 6
    meta_s = _meta_line(match_info)
    if meta_s:
        f_m = _fit_font(draw, config, meta_s, bw, 22, 17, "medium")
        y = _draw_centered_top(draw, cx, y + 8, meta_s, f_m, _hex_rgba(c.muted_text)) + 6

    # 4. Big two-row scoreboard (unified safe-zone width)
    innings = match_info.innings[:2]
    row_h = 150
    sb_h = max(150, len(innings) * row_h)
    sb_y = y + 32
    sb_panel = _make_clipped_panel(
        bw,
        sb_h,
        radius=26,
        fill_top=_hex_rgba(c.surface_glass, 240),
        fill_bot=_hex_rgba(c.obsidian_deep, 245),
        outline=_hex_rgba(c.gold_accent, 160),
        outline_width=2,
    )
    sb_draw = ImageDraw.Draw(sb_panel)

    for idx, inn in enumerate(innings):
        ry = idx * row_h
        if idx > 0:
            sb_draw.line([(28, ry), (bw - 28, ry)], fill=_hex_rgba(c.gold_accent, 60), width=1)

        is_gscc = config.is_gscc_team(inn.batting_team)
        is_win = _is_winning_team(inn.batting_team, match_info.result_text)
        if is_win:
            win_col = _hex_rgba(c.gold_soft if is_gscc else c.crimson_signal, 255)
            sb_draw.rectangle([(0, ry + 16), (8, ry + row_h - 16)], fill=win_col)

        crest_sz = 76
        bxx = 30
        by_ = ry + (row_h - crest_sz) // 2
        sq_crest = _load_squad_logo(config, inn.batting_team, crest_sz)
        if sq_crest is not None:
            sb_panel.alpha_composite(sq_crest, (bxx + (crest_sz - sq_crest.width) // 2, by_ + (crest_sz - sq_crest.height) // 2))
        else:
            sb_draw.ellipse(
                [(bxx, by_), (bxx + crest_sz, by_ + crest_sz)],
                fill=_hex_rgba(c.maroon_dark if is_gscc else "#2C2623", 240),
                outline=_hex_rgba(c.gold_accent if is_gscc else "#5B514B", 190),
                width=2,
            )
            init = _innings_monogram(inn)
            f_init = _load_font(config, 23 if len(init) >= 3 else 26, "extrabold")
            itw, ith, _ = _measure_tracked(sb_draw, init, f_init)
            _draw_text_top(
                sb_draw,
                bxx + (crest_sz - itw) / 2,
                by_ + (crest_sz - ith) / 2,
                init,
                f_init,
                _hex_rgba(c.gold_soft if is_gscc else c.warm_white),
            )

        score_str, sub_sc = _format_innings_score_pair(inn, uppercase=False)
        f_sc = _load_font(config, 74, "black")
        sc_w, sc_h, _ = _measure_tracked(sb_draw, score_str, f_sc)
        sc_col = _hex_rgba(c.gold_soft if is_gscc else c.pure_white)
        _draw_text_top(sb_draw, bw - 34 - sc_w, ry + 24, score_str, f_sc, sc_col)

        f_sub = _load_font(config, 21, "semibold")
        ss_w, _, _ = _measure_tracked(sb_draw, sub_sc, f_sub)
        _draw_text_top(sb_draw, bw - 34 - ss_w, ry + 24 + sc_h + 12, sub_sc, f_sub, _hex_rgba(c.muted_text))

        tx = bxx + crest_sz + 24
        max_name_w = bw - 34 - max(sc_w, ss_w) - tx - 24
        f_tn = _fit_font(sb_draw, config, inn.batting_team, max(160, max_name_w), 36, 22, "extrabold")
        tn_col = _hex_rgba(c.gold_soft if is_gscc else c.pure_white)
        _, tn_h, _ = _measure_tracked(sb_draw, inn.batting_team, f_tn)
        name_y = ry + (row_h - tn_h) // 2 - (12 if is_win else 0)
        _draw_text_top(sb_draw, tx, name_y, inn.batting_team, f_tn, tn_col)
        if is_win:
            _draw_text_top(
                sb_draw,
                tx,
                name_y + tn_h + 10,
                "WINNER",
                _load_font(config, 18, "extrabold"),
                _hex_rgba(c.gold_accent if is_gscc else c.crimson_signal),
                tracking=3,
            )

    img.alpha_composite(sb_panel, (bx, sb_y))
    cur_y = sb_y + sb_h + 34

    # 5. Player of the Match: prominent only for GSCC players, otherwise a small neutral line
    performers = derive_standout_performers(match_info, clips, config)
    if match_info.player_of_match:
        if _potm_is_gscc(match_info, config, performers):
            potm_h = 70
            potm_panel = _make_clipped_panel(
                bw,
                potm_h,
                radius=16,
                fill_top=_hex_rgba(c.surface_glass, 232),
                outline=_hex_rgba(c.gold_bright, 170),
                outline_width=2,
            )
            pd = ImageDraw.Draw(potm_panel)
            f_tag = _load_font(config, 19, "black")
            tag_txt = "PLAYER OF THE MATCH"
            ttw, tth, _ = _measure_tracked(pd, tag_txt, f_tag, tracking=2)
            tag_pill = _make_clipped_panel(ttw + 28, 38, radius=10, fill_top=_hex_rgba(c.gold_soft, 255))
            potm_panel.alpha_composite(tag_pill, (16, (potm_h - 38) // 2))
            _draw_text_top(pd, 30, (potm_h - tth) // 2, tag_txt, f_tag, _hex_rgba(c.obsidian_deep), tracking=2)
            nx = 16 + ttw + 28 + 22
            f_pn = _fit_font(pd, config, match_info.player_of_match, max(160, bw - nx - 20), 32, 20, "extrabold")
            _, pnh, _ = _measure_tracked(pd, match_info.player_of_match, f_pn)
            _draw_text_top(pd, nx, (potm_h - pnh) // 2, match_info.player_of_match, f_pn, _hex_rgba(c.pure_white))
            img.alpha_composite(potm_panel, (bx, cur_y))
            cur_y += potm_h + 30
        else:
            f_small = _load_font(config, 21, "semibold")
            tag = "PLAYER OF THE MATCH:"
            tgw, tgh, _ = _measure_tracked(draw, tag, f_small, tracking=2)
            _draw_text_top(draw, bx + 4, cur_y, tag, f_small, _hex_rgba(c.muted_text), tracking=2)
            _draw_text_top(draw, bx + 4 + tgw + 14, cur_y, match_info.player_of_match, f_small, _hex_rgba(c.warm_white, 235))
            cur_y += tgh + 34

    # 6. GSCC standouts (bigger rows, same width as the scoreboard)
    if performers and cur_y < 1180:
        f_shdr = _load_font(config, 22, "extrabold")
        _, sh_h = _draw_text_top(draw, bx + 4, cur_y, "GSCC STANDOUTS", f_shdr, _hex_rgba(c.gold_soft), tracking=5)
        cur_y += sh_h + 18

        p_row_h = 84
        max_rows = min(3, max(1, (1350 - cur_y) // (p_row_h + 4)))
        shown = performers[:max_rows]
        st_h = len(shown) * p_row_h + 12
        st_panel = _make_clipped_panel(
            bw,
            st_h,
            radius=22,
            fill_top=_hex_rgba(c.surface_glass, 232),
            fill_bot=_hex_rgba(c.obsidian_deep, 240),
            outline=_hex_rgba(c.gold_accent, 115),
            outline_width=1,
        )
        sd = ImageDraw.Draw(st_panel)
        f_role = _load_font(config, 19, "black")
        f_stat = _load_font(config, 32, "extrabold")

        for i, perf in enumerate(shown):
            ry = 6 + i * p_row_h
            if i > 0:
                sd.line([(24, ry), (bw - 24, ry)], fill=_hex_rgba(c.gold_accent, 45), width=1)

            role, pname, pstat = _parse_performer_row(perf)
            role_bg = c.crimson_signal if role == "BOWL" else c.gold_soft
            role_fg = c.pure_white if role == "BOWL" else c.obsidian_deep
            rb_w, rb_h = 92, 36
            rb = _make_clipped_panel(rb_w, rb_h, radius=10, fill_top=_hex_rgba(role_bg, 245))
            st_panel.alpha_composite(rb, (24, ry + (p_row_h - rb_h) // 2))
            rtw, rth, _ = _measure_tracked(sd, role, f_role, tracking=1)
            _draw_text_top(sd, 24 + (rb_w - rtw) / 2, ry + (p_row_h - rth) / 2, role, f_role, _hex_rgba(role_fg), tracking=1)

            stat_w = 0
            if pstat:
                stw, sth, _ = _measure_tracked(sd, pstat, f_stat)
                _draw_text_top(sd, bw - 28 - stw, ry + (p_row_h - sth) / 2, pstat, f_stat, _hex_rgba(c.gold_soft))
                stat_w = stw + 24

            nx = 24 + rb_w + 24
            avail_nw = max(140, bw - nx - 28 - stat_w)
            f_nm = _fit_font(sd, config, pname, avail_nw, 34, 20, "bold")
            _, nm_h, _ = _measure_tracked(sd, pname, f_nm)
            _draw_text_top(sd, nx, ry + (p_row_h - nm_h) / 2, pname, f_nm, _hex_rgba(c.pure_white))

        img.alpha_composite(st_panel, (bx, cur_y))
        cur_y += st_h

    # 7. Crisp footer strictly inside IG safe zone (always clears the Standouts box!)
    f_foot = _load_font(config, 23, "bold")
    foot_y = min(1448, max(1410, cur_y + 28))
    _draw_centered_top(
        draw,
        cx,
        foot_y,
        f"FOLLOW {config.instagram_handle}   •   {config.website}",
        f_foot,
        _hex_rgba(c.gold_soft),
        tracking=1,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path
