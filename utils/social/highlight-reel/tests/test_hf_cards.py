"""HyperFrames card data builders (pure Python, no Node/Chrome needed) + caption link."""

from __future__ import annotations

from gscc_highlights.captions import build_caption
from gscc_highlights.config import load_config
from gscc_highlights.hf_cards import break_card_data, intro_card_data, outro_card_data, template_fingerprint
from gscc_highlights.models import ClipSpec, InningsSummary, MatchInfo, ProjectManifest, VideoPart


def _info() -> MatchInfo:
    return MatchInfo(
        slug="falcons_bears",
        title="California Falcons vs GSCC Bears",
        series="NCCA Winter T20 26-27",
        date="Nov 14, 2026",
        result_text="GSCC Bears won by 8 wickets",
        player_of_match="Sharan C",
        gscc_team="GSCC Bears",
        opponent_team="California Falcons",
        innings=[
            InningsSummary(1, "California Falcons", "GSCC Bears", 159, 9, "20"),
            InningsSummary(2, "GSCC Bears", "California Falcons", 165, 2, "12.1", is_gscc_batting=True),
        ],
        top_performers=["Sharan C 64* (25)", "Abhimanyu K 52 (22)", "Harsh P 3/22 (4 ov)"],
    )


def test_intro_data_has_hook_and_hides_generic_series():
    cfg = load_config()
    d = intro_card_data(_info(), cfg)
    assert d["teamA"] == "CALIFORNIA FALCONS" and d["teamB"] == "GSCC BEARS"
    assert d["hook"] == "WON BY 8 WICKETS"
    assert len(d["crests"]) == 2
    info = _info()
    info.series = "NCCA"
    assert "NCCA" not in intro_card_data(info, cfg)["meta"]


def test_break_data_chase_maths_and_opponent_monogram():
    cfg = load_config()
    d = break_card_data(_info(), cfg, None)
    assert d["score"] == "159/9"
    assert d["target"].endswith("160")
    assert "RRR 8.00" in d["chase"]
    assert d["crest"] is None and d["monogram"] == "CF"  # opponent never gets the GSCC crest


def test_outro_data_outcome_first_with_context_and_standouts():
    cfg = load_config()
    d = outro_card_data(_info(), cfg, None)
    assert d["headline"] == "WON BY 8 WICKETS"
    assert "47 balls to spare" in d["context"]
    assert d["status"] == "FULL TIME"
    assert [i["winner"] for i in d["innings"]] == [False, True]
    assert d["standouts"][0]["role"] == "BAT" and d["standouts"][2]["role"] == "BOWL"
    assert d["potm"]["prominent"] is True


def test_template_fingerprint_is_stable():
    assert template_fingerprint() == template_fingerprint()


def test_outro_template_positions_footer_dynamically_below_stack():
    from gscc_highlights.hf_cards import TEMPLATE_DIR

    html = (TEMPLATE_DIR / "templates" / "outro.html").read_text(encoding="utf-8")
    assert "stack.offsetTop + stack.offsetHeight" in html
    assert "#foot { top: 1400px;" not in html


def test_caption_has_full_match_link_and_no_moments_line():
    cfg = load_config()
    vp = VideoPart(index=0, local_path="/tmp/x.mp4", source_url="https://youtu.be/abc123?t=900")
    manifest = ProjectManifest(version=1, match_info=_info(), video_parts=[vp], music_choice="none", mode="gscc-only", clips=[])
    text = build_caption(manifest, cfg)
    assert "▶️ Full match: https://youtu.be/abc123" in text and "t=900" not in text
    assert "In this reel" not in text
    assert text.startswith("🏆 GSCC Bears beat California Falcons by 8 wickets!")
