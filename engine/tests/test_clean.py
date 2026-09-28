from lnengine.stages.clean import clean, collapse_token_loops, transcript_text


def seg(start_s: float, text: str, dur_s: float = 1.0) -> dict:
    return {"start_ms": int(start_s * 1000), "end_ms": int((start_s + dur_s) * 1000), "text": text}


def test_collapse_token_loops_from_real_small_model_output():
    assert collapse_token_loops("A C C C C C C C C 그 다음에") == "A C 그 다음에"
    assert collapse_token_loops("R#, R#, R#, R#, R#, 이렇게") == "R#, 이렇게"
    assert collapse_token_loops("어떻게 구해요? " + "C제공을 많이 구해요 " * 5) == "어떻게 구해요? C제공을 많이 구해요"


def test_collapse_token_loops_keeps_short_natural_repetition():
    assert collapse_token_loops("네 네 네 알겠습니다") == "네 네 네 알겠습니다"


def test_clean_drops_loops_hallucinations_and_empty_segments():
    segments = [
        seg(0, "그렇죠?"), seg(1, "그렇죠?"),                      # 2번은 실제 발화일 수 있어 둔다
        seg(2, "반복"), seg(3, "반복."), seg(4, "반복"), seg(5, "반복"),  # 3번 이상은 하나만
        seg(6, "시청해주셔서 감사합니다."),
        seg(7, "  "),
        seg(8, "끝"),
    ]
    result = clean(segments)
    # 반복을 줄인 뒤 3초~8초가 비어 있어 "끝"은 새 문단이 된다
    assert transcript_text(result) == "그렇죠? 그렇죠? 반복\n\n끝"
    assert result["stats"] == {"segments_in": 9, "loops_collapsed": 0, "hallucinations_removed": 1,
                               "repeats_removed": 3}


def test_paragraphs_split_on_pause_and_length():
    segments = [seg(0, "첫 문장"), seg(1.5, "이어짐"), seg(10, "쉬고 나서"), seg(11, "가" * 400), seg(12, "새 문단")]
    paragraphs = clean(segments)["paragraphs"]
    assert [p["text"][:5] for p in paragraphs] == ["첫 문장 ", "쉬고 나서", "새 문단"]
    assert [p["start_ms"] for p in paragraphs] == [0, 10000, 12000]
