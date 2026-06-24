import hashlib
import math
from typing import Any


def build_conversation_features(messages: list[dict[str, Any]]) -> dict[str, Any]:
    user_messages = [message for message in messages if message.get("role") == "user"]
    assistant_messages = [message for message in messages if message.get("role") == "assistant"]
    text = " ".join(str(message.get("content", "")) for message in messages)
    token_count = len(text.split())
    embedding = _hash_embedding(text)
    return {
        "turn_count": len(messages),
        "user_turn_count": len(user_messages),
        "assistant_turn_count": len(assistant_messages),
        "approx_token_count": token_count,
        "summary": text[:500],
        "embedding": embedding,
    }


def _hash_embedding(text: str, dimensions: int = 16) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    values = []
    for index in range(dimensions):
        raw = digest[index] / 255.0
        values.append(round(math.sin(raw * math.pi), 6))
    return values
