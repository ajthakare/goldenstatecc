"""Pillow graphics generator for unified GSCC 9:16 Instagram Reels Safe-Zone overlays."""

from __future__ import annotations

import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from gscc_highlights.config import ClubConfig
from gscc_highlights.models import ClipSpec, MatchInfo


def _hex_rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def _load_font(config: ClubConfig, size: int, weight: str = "bold") -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates: list[Path] = []
    if weight == "extrabold":
        candidates.append(config.resolve(config.font_extrabold_path))
        candidates.append(config.resolve(config.font_bold_path))
        candidates.extend(
            [
                Path("/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf"),
                Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
                Path("/System/Library/Fonts/Avenir Next.ttc"),
                Path("/System/Library/Fonts/SFNS.ttf"),
            ]
        )
    elif weight == "bold":
        candidates.append(config.resolve(config.font_bold_path))
        candidates.extend(
            [
                Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
                Path("/System/Library/Fonts/Avenir Next.ttc"),
                Path("/System/Library/Fonts/SFNS.ttf"),
            ]
        )
    else:
        candidates.append(config.resolve(config.font_regular_path))
        candidates.extend(
            [
                Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
                Path("/System/Library/Fonts/HelveticaNeue.ttc"),
                Path("/System/Library/Fonts/SFNS.ttf"),
            ]
        )

    for fp in candidates:
        if fp.exists():
            try:
                return ImageFont.truetype(str(fp), size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def _load_logo(config: ClubConfig, target_px: int) -> Image.Image:
    logo_file = config.resolve(config.logo_path)
    if logo_file.exists():
        try:
            img = Image.open(logo_file).convert("RGBA")
            img.thumbnail((target_px, target_px), Image.Resampling.LANCZOS)
            return img
        except Exception:
            pass
    # Fallback crisp circular GSCC crest badge
    badge = Image.new("RGBA", (target_px, target_px), (0, 0, 0, 0))
    d = ImageDraw.Draw(badge)
    c = config.colors
    d.ellipse(
        [(2, 2), (target_px - 3, target_px - 3)],
        fill=_hex_rgba(c.maroon_primary),
        outline=_hex_rgba(c.gold_bright),
        width=max(3, target_px // 24),
    )
    font = _load_font(config, max(16, int(target_px * 0.28)), "extrabold")
    bbox = d.textbbox((0, 0), config.short_name, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((target_px - tw) / 2, (target_px - th) / 2 - 2), config.short_name, fill=_hex_rgba(c.gold_bright), font=font)
    return badge


def _draw_vertical_gradient(img: Image.Image, top_hex: str, bot_hex: str) -> None:
    w, h = img.size
    tr, tg, tb, _ = _hex_rgba(top_hex)
    br, bg, bb, _ = _hex_rgba(bot_hex)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        ratio = y / max(1, h - 1)
        r = int(tr + (br - tr) * ratio)
        g = int(tg + (bg - tg) * ratio)
        b = int(tb + (bb - tb) * ratio)
        draw.line([(0, y), (w, y)], fill=(r, g, b, 255))


def _badge_fill_hex(event_type: str, config: ClubConfig) -> tuple[str, str]:
    """Return (pill_bg_hex, pill_text_hex) tuned to GSCC palette."""
    c = config.colors
    if event_type in {"hundred", "fifty", "winning_shot"}:
        return c.gold_bright, c.obsidian
    if event_type == "six":
        return c.gold_accent, c.obsidian
    if event_type == "wicket":
        return c.maroon_primary, c.pure_white
    return c.maroon_hover, c.pure_white


def render_intro_card(match_info: MatchInfo, config: ClubConfig, out_path: Path) -> Path:
    """Render 1080x1920 unified GSCC intro slate inside Instagram Safe Zones."""
    w, h = config.width, config.height
    c = config.colors
    img = Image.new("RGBA", (w, h), _hex_rgba(c.obsidian))
    _draw_vertical_gradient(img, c.obsidian, c.maroon_dark)
    draw = ImageDraw.Draw(img)

    # Subtle outer gold editorial frame strictly inside safe zone
    draw.rounded_rectangle(
        [(56, 260), (w - 56, 1460)],
        radius=28,
        fill=_hex_rgba(c.obsidian, 210),
        outline=_hex_rgba(c.gold_accent, 230),
        width=4,
    )
    draw.rectangle([(56, 260), (w - 56, 272)], fill=_hex_rgba(c.gold_bright))

    # Club Logo centered
    logo = _load_logo(config, 210)
    img.alpha_composite(logo, ((w - logo.width) // 2, 330))

    f_club = _load_font(config, 40, "extrabold")
    f_sub = _load_font(config, 24, "bold")
    f_pill = _load_font(config, 28, "extrabold")
    f_match = _load_font(config, 62, "extrabold")
    f_meta = _load_font(config, 30, "regular")

    def _center_text(y: int, txt: str, font, fill) -> int:
        bb = draw.textbbox((0, 0), txt, font=font)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        draw.text(((w - tw) / 2, y), txt, fill=fill, font=font)
        return y + th

    y = _center_text(575, config.name.upper(), f_club, _hex_rgba(c.gold_bright))
    y = _center_text(y + 12, config.tagline, f_sub, _hex_rgba(c.muted_text))

    # Maroon pill: MATCH HIGHLIGHTS
    pill_txt = "MATCH HIGHLIGHTS"
    pbb = draw.textbbox((0, 0), pill_txt, font=f_pill)
    pw, ph = (pbb[2] - pbb[0]) + 64, (pbb[3] - pbb[1]) + 28
    px = (w - pw) // 2
    py = y + 54
    draw.rounded_rectangle([(px, py), (px + pw, py + ph)], radius=14, fill=_hex_rgba(c.maroon_primary))
    draw.text((px + 32, py + 12), pill_txt, fill=_hex_rgba(c.pure_white), font=f_pill)

    # Match Title (wrapped cleanly if long)
    y_title = py + ph + 56
    title_lines = textwrap.wrap(match_info.title.upper(), width=22)[:3]
    for line in title_lines:
        y_title = _center_text(y_title, line, f_match, _hex_rgba(c.pure_white)) + 12

    # Series / Date / Venue
    meta_parts = [p for p in [match_info.series, match_info.date] if p]
    y_meta = y_title + 36
    if meta_parts:
        y_meta = _center_text(y_meta, "  •  ".join(meta_parts), f_meta, _hex_rgba(c.gold_soft)) + 14
    if match_info.venue:
        y_meta = _center_text(y_meta, match_info.venue, f_meta, _hex_rgba(c.muted_text)) + 14

    _center_text(1380, f"{config.instagram_handle}   •   {config.website}", f_sub, _hex_rgba(c.gold_accent))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path


def render_clip_overlay(
    match_info: MatchInfo,
    clip: ClipSpec,
    config: ClubConfig,
    out_path: Path,
) -> Path:
    """Render transparent 1080x1920 RGBA overlay strictly inside Instagram Reels Safe Zones."""
    w, h = config.width, config.height
    c = config.colors
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- 1. TOP SAFE-ZONE HEADER CARD (y = 235 .. 485) ---
    hdr_x1, hdr_y1, hdr_x2, hdr_y2 = 44, config.safe_top_y + 15, w - 44, config.video_y - 35
    draw.rounded_rectangle(
        [(hdr_x1, hdr_y1), (hdr_x2, hdr_y2)],
        radius=22,
        fill=_hex_rgba(c.obsidian, 232),
        outline=_hex_rgba(c.gold_accent, 180),
        width=2,
    )
    # Signature goldenstatecc.org gold bottom accent line
    draw.rectangle([(hdr_x1 + 18, hdr_y2 - 6), (hdr_x2 - 18, hdr_y2)], fill=_hex_rgba(c.gold_accent))

    logo = _load_logo(config, 118)
    img.alpha_composite(logo, (hdr_x1 + 26, hdr_y1 + (hdr_y2 - hdr_y1 - logo.height) // 2))

    tx = hdr_x1 + 168
    f_club_sm = _load_font(config, 24, "extrabold")
    f_match_hdr = _load_font(config, 36, "extrabold")
    f_series = _load_font(config, 23, "regular")

    draw.text((tx, hdr_y1 + 28), config.name.upper(), fill=_hex_rgba(c.gold_bright), font=f_club_sm)
    match_short = match_info.title if len(match_info.title) <= 34 else (match_info.title[:33] + "…")
    draw.text((tx, hdr_y1 + 66), match_short, fill=_hex_rgba(c.pure_white), font=f_match_hdr)
    meta = " • ".join([p for p in [match_info.series, match_info.date] if p]) or config.tagline
    draw.text((tx, hdr_y1 + 120), meta[:48], fill=_hex_rgba(c.muted_text), font=f_series)

    # --- 2. VIDEO FRAME GOLD ACCENT HAIRLINES (y = 520 & y = 1128) ---
    vy1 = config.video_y
    vy2 = config.video_y + config.video_height
    draw.rectangle([(0, vy1 - 4), (w, vy1)], fill=_hex_rgba(c.gold_accent, 235))
    draw.rectangle([(0, vy2), (w, vy2 + 4)], fill=_hex_rgba(c.gold_accent, 235))

    # --- 3. BOTTOM SAFE-ZONE CALLOUT CARD (y = 1160 .. 1460, x = 44 .. 905) ---
    # Strictly inside x <= safe_right_x (910) and y <= safe_bottom_y (1480)!
    card_x1 = 44
    card_x2 = min(config.safe_right_x, w - 160)
    card_y1 = vy2 + 34
    card_y2 = min(config.safe_bottom_y - 16, card_y1 + 300)

    pill_bg, pill_fg = _badge_fill_hex(clip.event_type, config)

    draw.rounded_rectangle(
        [(card_x1, card_y1), (card_x2, card_y2)],
        radius=22,
        fill=_hex_rgba(c.obsidian, 235),
        outline=_hex_rgba(c.gold_accent, 140),
        width=2,
    )
    # Bold vertical color bar on left edge of card
    draw.rounded_rectangle(
        [(card_x1, card_y1), (card_x1 + 14, card_y2)],
        radius=8,
        fill=_hex_rgba(pill_bg),
    )

    f_badge = _load_font(config, 26, "extrabold")
    f_head = _load_font(config, 38, "extrabold")
    f_sub = _load_font(config, 26, "regular")
    f_foot = _load_font(config, 22, "bold")

    # Event Badge Pill
    bx = card_x1 + 34
    by = card_y1 + 24
    pbb = draw.textbbox((0, 0), clip.badge, font=f_badge)
    pw, ph = (pbb[2] - pbb[0]) + 36, (pbb[3] - pbb[1]) + 18
    draw.rounded_rectangle([(bx, by), (bx + pw, by + ph)], radius=10, fill=_hex_rgba(pill_bg))
    draw.text((bx + 18, by + 7), clip.badge, fill=_hex_rgba(pill_fg), font=f_badge)

    # Over pill next to badge
    ov_txt = f"OVER {clip.over_ball}"
    draw.text((bx + pw + 22, by + 8), ov_txt, fill=_hex_rgba(c.gold_soft), font=f_badge)

    # Headline (max 2 lines)
    hy = by + ph + 18
    head_lines = textwrap.wrap(clip.headline, width=32)[:2]
    for hl in head_lines:
        draw.text((bx, hy), hl, fill=_hex_rgba(c.pure_white), font=f_head)
        hy += 44

    # Subtext (1 line truncated cleanly)
    sub = clip.subtext if len(clip.subtext) <= 46 else (clip.subtext[:45] + "…")
    if sub:
        draw.text((bx, min(hy + 4, card_y2 - 78)), sub, fill=_hex_rgba(c.warm_white, 230), font=f_sub)

    # Footer row: live score + @goldenstate_cc
    foot_txt = f"{clip.score_text}   •   {config.instagram_handle}"
    if len(foot_txt) > 54:
        foot_txt = f"{clip.score_text[:34]} • {config.instagram_handle}"
    draw.text((bx, card_y2 - 42), foot_txt, fill=_hex_rgba(c.gold_accent), font=f_foot)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    return out_path


def render_outro_card(match_info: MatchInfo, config: ClubConfig, out_path: Path) -> Path:
    """Render 1080x1920 unified GSCC outro summary card inside Instagram Safe Zones."""
    w, h = config.width, config.height
    c = config.colors
    img = Image.new("RGBA", (w, h), _hex_rgba(c.obsidian))
    _draw_vertical_gradient(img, c.maroon_dark, c.obsidian)
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [(56, 260), (w - 56, 1460)],
        radius=28,
        fill=_hex_rgba(c.obsidian, 224),
        outline=_hex_rgba(c.gold_accent, 230),
        width=4,
    )
    draw.rectangle([(56, 260), (w - 56, 272)], fill=_hex_rgba(c.gold_bright))

    logo = _load_logo(config, 165)
    img.alpha_composite(logo, ((w - logo.width) // 2, 315))

    f_pill = _load_font(config, 26, "extrabold")
    f_res = _load_font(config, 46, "extrabold")
    f_score = _load_font(config, 36, "bold")
    f_perf_hdr = _load_font(config, 24, "extrabold")
    f_perf = _load_font(config, 30, "regular")
    f_foot = _load_font(config, 26, "bold")

    def _center_text(y: int, txt: str, font, fill) -> int:
        bb = draw.textbbox((0, 0), txt, font=font)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        draw.text(((w - tw) / 2, y), txt, fill=fill, font=font)
        return y + th

    # FULL TIME gold pill
    pt = "FULL TIME"
    pbb = draw.textbbox((0, 0), pt, font=f_pill)
    pw, ph = (pbb[2] - pbb[0]) + 56, (pbb[3] - pbb[1]) + 22
    px, py = (w - pw) // 2, 515
    draw.rounded_rectangle([(px, py), (px + pw, py + ph)], radius=12, fill=_hex_rgba(c.gold_bright))
    draw.text((px + 28, py + 10), pt, fill=_hex_rgba(c.obsidian), font=f_pill)

    # Result headline
    y = py + ph + 38
    result_display = match_info.result_text or match_info.title
    for line in textwrap.wrap(result_display.upper(), width=26)[:2]:
        y = _center_text(y, line, f_res, _hex_rgba(c.pure_white)) + 10

    # Scoreboard Card
    sb_y1 = y + 34
    sb_y2 = sb_y1 + max(130, len(match_info.innings) * 74 + 36)
    draw.rounded_rectangle(
        [(108, sb_y1), (w - 108, sb_y2)],
        radius=18,
        fill=_hex_rgba(c.surface_dark, 240),
        outline=_hex_rgba(c.maroon_primary, 220),
        width=3,
    )
    ry = sb_y1 + 26
    for inn in match_info.innings[:2]:
        is_gscc = config.is_gscc_team(inn.batting_team)
        t_col = _hex_rgba(c.gold_bright if is_gscc else c.pure_white)
        draw.text((144, ry), inn.batting_team[:24], fill=t_col, font=f_score)
        sc_str = f"{inn.runs}/{inn.wickets} ({inn.overs_text} ov)"
        bb = draw.textbbox((0, 0), sc_str, font=f_score)
        draw.text((w - 144 - (bb[2] - bb[0]), ry), sc_str, fill=t_col, font=f_score)
        ry += 70

    # Player of the Match & Top Performers
    py2 = sb_y2 + 46
    if match_info.player_of_match:
        py2 = _center_text(py2, "PLAYER OF THE MATCH", f_perf_hdr, _hex_rgba(c.gold_accent)) + 10
        py2 = _center_text(py2, match_info.player_of_match, f_score, _hex_rgba(c.pure_white)) + 26

    if match_info.top_performers:
        py2 = _center_text(py2, "STANDOUT PERFORMANCES", f_perf_hdr, _hex_rgba(c.gold_soft)) + 12
        for perf in match_info.top_performers[:3]:
            if py2 < 1320:
                py2 = _center_text(py2, perf, f_perf, _hex_rgba(c.warm_white)) + 10

    _center_text(1385, f"FOLLOW {config.instagram_handle}   •   {config.website}", f_foot, _hex_rgba(c.gold_bright))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path
