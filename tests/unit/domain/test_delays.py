import random

import pytest

from app.domain.delays import DelayConfig, reply_delay


def test_defaults() -> None:
    config = DelayConfig()
    assert (config.min_delay, config.max_delay) == (2.0, 10.0)
    assert (config.per_char_delay, config.max_total_delay) == (0.03, 30.0)


def test_delay_is_inside_range_plus_length() -> None:
    config = DelayConfig()
    rng = random.Random(7)
    for length in (0, 50, 200):
        delay = reply_delay(config, length, rng)
        assert 2.0 + 0.03 * length <= delay <= min(10.0 + 0.03 * length, 30.0)


def test_long_reply_is_capped() -> None:
    assert reply_delay(DelayConfig(), 5000, random.Random(1)) == 30.0


def test_fixed_range_is_deterministic() -> None:
    config = DelayConfig(min_delay=3, max_delay=3, per_char_delay=0.1, max_total_delay=60)
    assert reply_delay(config, 10, random.Random()) == pytest.approx(4.0)


def test_same_seed_same_delay() -> None:
    config = DelayConfig()
    assert reply_delay(config, 40, random.Random(5)) == reply_delay(config, 40, random.Random(5))


@pytest.mark.parametrize(
    "kwargs",
    [
        {"min_delay": -1},
        {"max_delay": -1, "min_delay": 0},
        {"per_char_delay": -0.1},
        {"max_total_delay": -5},
    ],
)
def test_negative_values_are_rejected(kwargs: dict[str, float]) -> None:
    with pytest.raises(ValueError, match="negative"):
        DelayConfig(**kwargs)


def test_min_more_than_max_is_rejected() -> None:
    with pytest.raises(ValueError, match="min_delay"):
        DelayConfig(min_delay=11, max_delay=10)


def test_negative_length_is_rejected() -> None:
    with pytest.raises(ValueError, match="reply_length"):
        reply_delay(DelayConfig(), -1, random.Random())
