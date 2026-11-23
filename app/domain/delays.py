"""Reply delay that looks human.

delay = min(random(min_delay, max_delay) + per_char_delay * len(reply), max_total_delay)
"""

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class DelayConfig:
    min_delay: float = 2.0
    max_delay: float = 10.0
    per_char_delay: float = 0.03
    max_total_delay: float = 30.0

    def __post_init__(self) -> None:
        values = (self.min_delay, self.max_delay, self.per_char_delay, self.max_total_delay)
        if any(v < 0 for v in values):
            raise ValueError("Delay values must not be negative")
        if self.min_delay > self.max_delay:
            raise ValueError("min_delay must not be more than max_delay")


def reply_delay(config: DelayConfig, reply_length: int, rng: random.Random) -> float:
    """Seconds to wait (with "typing...") before the reply is sent."""
    if reply_length < 0:
        raise ValueError("reply_length must not be negative")
    base = rng.uniform(config.min_delay, config.max_delay)
    return min(base + config.per_char_delay * reply_length, config.max_total_delay)
