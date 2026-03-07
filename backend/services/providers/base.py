import json
import re
from abc import ABC, abstractmethod
from typing import Callable, Optional

from backend.models import FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO


def _fix_json_newlines(text: str) -> str:
    """Escape literal newlines that appear inside JSON string values.

    LLMs frequently return JSON with unescaped newlines inside string
    values (e.g. multi-paragraph descriptions).  ``json.loads`` rejects
    these, so we walk the text and replace literal ``\\n`` inside quoted
    strings with the escaped ``\\\\n`` sequence.
    """
    out: list[str] = []
    in_string = False
    escape_next = False
    for ch in text:
        if escape_next:
            out.append(ch)
            escape_next = False
            continue
        if ch == '\\' and in_string:
            out.append(ch)
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
        if in_string and ch == '\n':
            out.append('\\n')
        elif in_string and ch == '\r':
            out.append('\\r')
        elif in_string and ch == '\t':
            out.append('\\t')
        else:
            out.append(ch)
    return ''.join(out)


def extract_json(raw: str) -> dict:
    """Extract and parse JSON from an LLM response, handling thinking tags,
    markdown code blocks, literal newlines in strings, and other common
    wrappers."""
    text = raw.strip()
    # Strip <think>...</think> or <reasoning>...</reasoning> blocks
    text = re.sub(r'<(?:think|reasoning)>.*?</(?:think|reasoning)>', '', text, flags=re.DOTALL).strip()
    # Strip markdown code fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Try to find JSON object within the text
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        snippet = text[start:end + 1]
        try:
            return json.loads(snippet)
        except json.JSONDecodeError:
            pass
        # LLMs often put literal newlines inside JSON string values —
        # escape them and retry.
        try:
            return json.loads(_fix_json_newlines(snippet))
        except json.JSONDecodeError:
            pass
    raise json.JSONDecodeError("No valid JSON found in response", text, 0)


def extract_description_fallback(raw: str) -> str:
    """Best-effort extraction of description text when JSON parsing fails.

    Looks for ``"description": "..."`` in the raw response and pulls out
    everything between the opening and closing quotes, handling the common
    case where the AI returns well-structured JSON but with literal
    newlines that break ``json.loads``.
    """
    # Strip thinking blocks first
    text = re.sub(r'<(?:think|reasoning)>.*?</(?:think|reasoning)>', '', raw, flags=re.DOTALL)
    m = re.search(r'"description"\s*:\s*"', text)
    if not m:
        return text[:500] if text else ""
    start = m.end()
    # Walk forward to find the unescaped closing quote
    i = start
    chars: list[str] = []
    while i < len(text):
        if text[i] == '\\' and i + 1 < len(text):
            # Escaped character — keep the real char
            nxt = text[i + 1]
            if nxt == 'n':
                chars.append('\n')
            elif nxt == 't':
                chars.append('\t')
            elif nxt == '"':
                chars.append('"')
            elif nxt == '\\':
                chars.append('\\')
            else:
                chars.append(nxt)
            i += 2
        elif text[i] == '"':
            break  # unescaped closing quote
        else:
            chars.append(text[i])
            i += 1
    return ''.join(chars) or text[:500]


def build_fallback_summary(raw: str) -> dict:
    """Extract a human-readable summary from raw AI text when JSON parsing fails.

    Instead of dumping raw AI output into the overview, tries to pull out
    meaningful content or generates a clean fallback.
    """
    if not raw or not raw.strip():
        return {
            "overview": "Could not generate a summary for this video.",
            "key_topics": [],
            "tone": "unknown",
            "estimated_audience": "general",
            "content_category": "uncategorized",
        }

    text = raw.strip()
    # Strip thinking/reasoning blocks
    text = re.sub(r'<(?:think|reasoning)>.*?</(?:think|reasoning)>', '', text, flags=re.DOTALL).strip()
    # Strip markdown code fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    # Try to extract individual fields from partial/broken JSON
    result = {}
    for field in ("overview", "tone", "estimated_audience", "content_category"):
        m = re.search(rf'"{field}"\s*:\s*"', text)
        if m:
            start = m.end()
            i = start
            chars = []
            while i < len(text):
                if text[i] == '\\' and i + 1 < len(text):
                    nxt = text[i + 1]
                    chars.append('\n' if nxt == 'n' else nxt)
                    i += 2
                elif text[i] == '"':
                    break
                else:
                    chars.append(text[i])
                    i += 1
            result[field] = ''.join(chars).strip()

    # Try to extract key_topics array
    m = re.search(r'"key_topics"\s*:\s*\[', text)
    if m:
        start = m.end()
        end = text.find(']', start)
        if end > start:
            topics_str = text[start:end]
            topics = re.findall(r'"([^"]+)"', topics_str)
            result["key_topics"] = topics

    # If we got an overview from partial JSON, use it
    if result.get("overview"):
        return {
            "overview": result["overview"],
            "key_topics": result.get("key_topics", []),
            "tone": result.get("tone", "unknown"),
            "estimated_audience": result.get("estimated_audience", "general"),
            "content_category": result.get("content_category", "uncategorized"),
        }

    # Last resort: strip JSON artifacts and use cleaned text as overview
    # Remove JSON syntax characters and clean up
    cleaned = re.sub(r'[{}\[\]"]', '', text)
    cleaned = re.sub(r'\b(?:overview|key_topics|tone|estimated_audience|content_category)\s*:', '', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if cleaned and len(cleaned) > 20:
        return {
            "overview": cleaned[:500],
            "key_topics": [],
            "tone": "unknown",
            "estimated_audience": "general",
            "content_category": "uncategorized",
        }

    return {
        "overview": "Could not generate a summary for this video.",
        "key_topics": [],
        "tone": "unknown",
        "estimated_audience": "general",
        "content_category": "uncategorized",
    }


def normalize_seo_data(data: dict) -> dict:
    """Merge legacy 'hashtags' field into 'tags' and ensure all tags have # prefix."""
    tags = list(data.get("tags", []))
    # Merge any separate hashtags field into tags
    hashtags = data.pop("hashtags", [])
    if hashtags:
        existing = {t.lower().lstrip("#") for t in tags}
        for h in hashtags:
            if h.lower().lstrip("#") not in existing:
                tags.append(h)
    # Ensure all tags have # prefix
    data["tags"] = [t if t.startswith("#") else f"#{t}" for t in tags]
    return data


class ProviderError(Exception):
    pass


class ProviderRateLimitError(ProviderError):
    pass


class AllProvidersFailedError(Exception):
    pass


class AIProvider(ABC):

    @abstractmethod
    async def analyze_frames(
        self,
        frames: list[FrameData],
        custom_prompt: Optional[str] = None,
        cancel_check: Optional[Callable] = None,
        progress_callback: Optional[Callable] = None,
    ) -> list[SceneDescription]:
        """Returns empty list if provider has no vision capability.
        progress_callback(frames_done, total_frames) is called after each batch."""
        pass

    @abstractmethod
    async def generate_summary(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        cancel_check: Optional[Callable] = None,
        custom_prompt: Optional[str] = None,
    ) -> VideoSummary:
        pass

    @abstractmethod
    async def detect_viral_clips(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        video_duration: float,
        custom_prompt: Optional[str] = None,
        cancel_check: Optional[Callable] = None,
        clip_count: Optional[int] = None,
        min_duration: Optional[float] = None,
        max_duration: Optional[float] = None,
        video_summary: Optional[str] = None,
        existing_clips: Optional[str] = None,
    ) -> list[ClipCandidate]:
        """All returned clips MUST have duration between min_duration and max_duration seconds."""
        pass

    @abstractmethod
    async def generate_seo(
        self,
        clip_title: str,
        clip_transcript: str,
        video_summary: str,
        platform: str,
        cancel_check: Optional[Callable] = None,
        custom_prompt: Optional[str] = None,
    ) -> ClipSEO:
        """Generate SEO-optimized title, description, and tags for a clip."""
        pass

    @property
    @abstractmethod
    def supports_vision(self) -> bool:
        pass

    @property
    @abstractmethod
    def provider_name(self) -> str:
        pass

    @property
    def total_tokens(self) -> int:
        """Return total tokens used by this provider instance."""
        return getattr(self, '_total_tokens', 0)
