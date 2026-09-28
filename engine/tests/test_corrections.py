from lnengine.corrections import MAX_ITEMS, apply, select

TEXT = "오늘은 렉시컬 애널리시스와 렉시컬 토큰을 다룹니다. 파서는 다음 시간에."


def test_select_keeps_only_real_distinct_multichar_items():
    picked = select([
        {"wrong": "렉시컬 애널리시스", "right": "Lexical Analysis"},
        {"wrong": "없는 표현", "right": "x"},        # 전사에 없음
        {"wrong": "파", "right": "파서"},            # 한 글자
        {"wrong": "파서는", "right": "파서는"},       # 정정어와 같음
        {"wrong": "렉시컬 애널리시스", "right": "중복"},  # 중복
        "문자열",                                    # 형식 오류
        {"wrong": "토큰을", "right": ""},             # 정정어 없음
    ], TEXT)
    assert picked == [{"wrong": "렉시컬 애널리시스", "right": "Lexical Analysis"}]


def test_select_rejects_harmful_items_seen_in_s2():
    text = "80번 줄의 associativity를 보면 Pulse Tree가 나옵니다"
    picked = select([
        {"wrong": "80", "right": "Parsing"},                       # 숫자만: 다른 숫자까지 바뀐다
        {"wrong": "associativity", "right": "Associativity"},     # 대소문자만 다름
        {"wrong": "Pulse Tree", "right": "Parse Tree"},
    ], text)
    assert picked == [{"wrong": "Pulse Tree", "right": "Parse Tree"}]


def test_apply_keeps_ascii_word_boundaries_but_allows_korean_particles():
    fixed, applied = apply(["IDEA와 IDE를 비교"], [{"wrong": "IDE", "right": "id"}])
    assert fixed == ["IDEA와 id를 비교"]
    assert applied == [{"wrong": "IDE", "right": "id", "count": 1}]


def test_select_caps_item_count():
    text = " ".join(f"단어{i}" for i in range(100))
    assert len(select([{"wrong": f"단어{i}", "right": f"word{i}"} for i in range(100)], text)) == MAX_ITEMS


def test_apply_prefers_longest_match_and_counts():
    fixed, applied = apply([TEXT], [{"wrong": "렉시컬", "right": "lexical"},
                                    {"wrong": "렉시컬 애널리시스", "right": "Lexical Analysis"}])
    assert fixed == ["오늘은 Lexical Analysis와 lexical 토큰을 다룹니다. 파서는 다음 시간에."]
    assert {(c["wrong"], c["count"]) for c in applied} == {("렉시컬 애널리시스", 1), ("렉시컬", 1)}


def test_apply_does_not_chain_replacements():
    fixed, _ = apply(["파서"], [{"wrong": "파서", "right": "parser"}, {"wrong": "parser", "right": "잘못"}])
    assert fixed == ["parser"]


def test_apply_without_items_returns_text_unchanged():
    assert apply(["그대로"], []) == (["그대로"], [])
