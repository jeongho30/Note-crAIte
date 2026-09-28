import pytest

from lnengine.bench import backend_used, cer, normalize, text_in_range


def test_normalize_ignores_spacing_and_punctuation():
    assert normalize("안녕 하세요, AI 강의!") == "안녕하세요ai강의"


def test_cer_counts_character_edits_against_reference():
    assert cer("가나다라", "가나다마") == pytest.approx(0.25)
    assert cer("가 나 다 라", "가나다라.") == 0.0


def test_backend_used_reads_whisper_log():
    assert backend_used(["whisper_init_with_params_no_state: use gpu    = 1",
                         "whisper_backend_init_gpu: using Vulkan0 backend"]) == "Vulkan0"
    assert backend_used(["whisper_backend_init_gpu: no GPU found"]) == "CPU"


def test_text_in_range_uses_segment_start():
    segments = [{"start_ms": 0, "text": "앞"}, {"start_ms": 600000, "text": "안"}, {"start_ms": 1200000, "text": "뒤"}]
    assert text_in_range(segments, 600000, 1200000) == "안"
