import math

import pytest

from heimdarts import board as B
from heimdarts.bridge import COORD_SCALE, throw_from_mm


@pytest.mark.parametrize("label", ["T20", "D16", "S5", "25", "BULL", "S11", "T19", "D6", "S3", "D20", "T1"])
def test_target_points_score_their_own_field(label):
    x, y = B.target_point(label)
    assert B.score_at(x, y).label == label


def test_segment_order_clockwise_from_top():
    # knapp rechts der Senkrechten liegt die 1, links die 5
    assert B.score_at(30, 120).number == 1
    assert B.score_at(-30, 120).number == 5
    assert B.score_at(120, 0).number == 6
    assert B.score_at(0, -120).number == 3
    assert B.score_at(-120, 0).number == 11


def test_rings():
    assert B.score_at(0, 0).label == "BULL"
    assert B.score_at(0, 10).label == "25"
    assert B.score_at(0, 50).label == "S20"
    assert B.score_at(0, 103).label == "T20"
    assert B.score_at(0, 140).label == "S20"
    assert B.score_at(0, 166).label == "D20"
    assert B.score_at(0, 175).label == "0"


@pytest.mark.parametrize("text,expected", [("t20", "T20"), ("d16", "D16"), ("5", "S5"), ("50", "BULL"),
                                           ("25", "25"), ("0", "0"), ("bull", "BULL")])
def test_parse_label(text, expected):
    assert B.parse_label(text).label == expected


def test_calibration_points_lie_on_double_ring():
    for _, (x, y) in B.CALIBRATION_POINTS[:4]:
        assert math.hypot(x, y) == pytest.approx(B.R_DOUBLE_OUT)


def test_board_manager_throw_format():
    t = throw_from_mm(0, 103)
    assert t["segment"] == {"bed": "Triple", "multiplier": 3, "name": "T20", "number": 20}
    assert t["coords"]["y"] == pytest.approx(103 * COORD_SCALE, abs=1e-4)
    assert throw_from_mm(0, 50)["segment"]["bed"] == "SingleInner"
    assert throw_from_mm(0, 140)["segment"]["bed"] == "SingleOuter"
    assert throw_from_mm(0, 0)["segment"] == {"bed": "Double", "multiplier": 2, "name": "Bull", "number": 25}
    assert throw_from_mm(0, 10)["segment"] == {"bed": "Single", "multiplier": 1, "name": "25", "number": 25}
    miss = throw_from_mm(0, -190)["segment"]
    assert miss == {"bed": "Outside", "multiplier": 0, "name": "M3", "number": 3}
    # Außenkante Doppel liegt wie beim Board Manager bei ~0.99
    assert throw_from_mm(0, 170)["coords"]["y"] == pytest.approx(0.99, abs=1e-3)
