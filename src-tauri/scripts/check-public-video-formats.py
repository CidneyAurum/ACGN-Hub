"""Offline contract checks against the installed yt-dlp format selector, no requests."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import unittest
import yt_dlp

path = Path(__file__).resolve().parents[1] / "resources" / "public_video_bridge.py"
spec = importlib.util.spec_from_file_location("public_video_bridge", path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

def video(identifier="30016", height=360, codec="avc1.64001E", ext="mp4"):
    return {"format_id": identifier, "ext": ext, "vcodec": codec, "acodec": "none", "height": height,
            "width": 640, "tbr": 300, "url": "https://example.invalid/video", "protocol": "https"}

def audio(identifier="30216", codec="mp4a.40.2", abr=64):
    return {"format_id": identifier, "ext": "m4a", "vcodec": "none", "acodec": codec,
            "abr": abr, "url": "https://example.invalid/audio", "protocol": "https"}

def select(formats):
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "cachedir": False}) as downloader:
        choices = list(downloader.build_format_selector(bridge.FORMAT_SELECTOR)({
            "formats": formats, "has_merged_format": any(item["vcodec"] != "none" and item["acodec"] != "none" for item in formats),
            "incomplete_formats": False,
        }))
    return choices[0] if choices else None

class FormatContract(unittest.TestCase):
    def test_prefer_verified_low_bandwidth_aac_over_best_audio(self):
        chosen = select([audio(), audio("30280", abr=192), video(), video("30080", height=1080)])
        checked = bridge.selected_public_format(chosen)
        self.assertEqual(checked["videoFormatId"], "30080")
        self.assertEqual(checked["audioFormatId"], "30216")
        self.assertEqual(checked["height"], 1080)

    def test_fallback_to_other_actual_aac_when_30216_absent(self):
        checked = bridge.selected_public_format(select([audio("30280", abr=192), video()]))
        self.assertEqual(checked["audioFormatId"], "30280")
        self.assertEqual(checked["audioPreference"], "other_available_aac")

    def test_id_variants_keep_30216_preference(self):
        checked = bridge.selected_public_format(select([audio("30216-0"), audio("30280", abr=192), video()]))
        self.assertEqual(checked["audioFormatId"], "30216-0")

    def test_unknown_zero_oversized_height_and_wrong_video_codec_are_unavailable(self):
        for invalid in [video(height=None), video(height=0), video(height=2160), video(codec="vp09", ext="webm")]:
            with self.subTest(invalid=invalid):
                self.assertIsNone(select([audio(), invalid]))

    def test_no_audio_and_non_aac_are_unavailable(self):
        self.assertIsNone(select([video()]))
        self.assertIsNone(select([audio(codec="opus"), video()]))

    def test_wrong_codec_on_preferred_id_cannot_override_real_aac(self):
        chosen = select([audio(codec="opus"), audio("30280", abr=192), video()])
        self.assertEqual(bridge.selected_public_format(chosen)["audioFormatId"], "30280")

    def test_muxed_avc_aac_is_a_valid_final_fallback(self):
        muxed = {**video("muxed"), "acodec": "mp4a.40.2"}
        self.assertEqual(bridge.selected_public_format(select([muxed]))["audioFormatId"], "muxed")

    def test_actual_selection_validation_rejects_drm_and_unknown_height(self):
        for invalid in [{**video(), "has_drm": True}, video(height=None), video(height=True), video(height=float("nan"))]:
            with self.assertRaises(ValueError):
                bridge.selected_public_format({"requested_formats": [invalid, audio()]})

    def test_inspect_and_download_share_the_exact_selector(self):
        self.assertEqual(bridge.options()["format"], bridge.FORMAT_SELECTOR)

    def test_chooses_actual_720_when_1080_is_not_available(self):
        chosen = select([audio(), video(), video("30064", height=720)])
        self.assertEqual(bridge.selected_public_format(chosen)["height"], 720)

if __name__ == "__main__":
    unittest.main(verbosity=2)
