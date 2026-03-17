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


_PLACEHOLDER_PATTERNS = {
    "...", "…", "<paragraph>", "<topic1>", "<topic2>", "<topic3>",
    "<tone>", "<audience>", "<category>", "n/a", "N/A", "none",
    "placeholder", "undefined", "null",
}


def _is_placeholder(value: str) -> bool:
    """Check if a string value is a placeholder rather than real content."""
    stripped = value.strip()
    if not stripped or len(stripped) < 3:
        return True
    if stripped in _PLACEHOLDER_PATTERNS:
        return True
    # Strings that are all dots/ellipsis
    if all(c in '.…' for c in stripped):
        return True
    # Angle-bracket placeholders like <something>
    if stripped.startswith('<') and stripped.endswith('>'):
        return True
    return False


def has_real_summary_content(data: dict) -> bool:
    """Check if a parsed summary dict contains actual content, not placeholders."""
    overview = data.get("overview", "")
    if _is_placeholder(overview):
        return False
    key_topics = data.get("key_topics", [])
    # At minimum, overview must be substantial
    if len(overview.strip()) < 20:
        return False
    # Check that at least some topics exist and aren't placeholders
    real_topics = [t for t in key_topics if not _is_placeholder(t)]
    if not real_topics:
        return False
    return True


def build_summary_from_transcript(
    transcript: list["TranscriptSegment"],
    scenes: list["SceneDescription"],
) -> dict:
    """Build a basic human-readable summary directly from transcript and scene data.

    This is a deterministic last-resort fallback that always produces
    meaningful content without requiring an LLM call.
    """
    # Build overview from first several transcript segments
    overview_parts = []
    speakers_seen = set()
    total_chars = 0
    for seg in transcript:
        speakers_seen.add(seg.speaker)
        overview_parts.append(seg.text)
        total_chars += len(seg.text)
        if total_chars > 600:
            break

    num_speakers = len(speakers_seen)
    duration_mins = 0
    if transcript:
        duration_mins = round((transcript[-1].end - transcript[0].start) / 60)

    if overview_parts:
        combined_text = " ".join(overview_parts)
        # Truncate to ~300 chars at word boundary
        if len(combined_text) > 300:
            combined_text = combined_text[:300].rsplit(" ", 1)[0] + "..."
        if num_speakers > 1:
            overview = (
                f"A {duration_mins}-minute video featuring {num_speakers} speakers. "
                f"The conversation covers: {combined_text}"
            )
        else:
            overview = (
                f"A {duration_mins}-minute video. "
                f"The content covers: {combined_text}"
            )
    else:
        overview = "Video analysis completed but no transcript was available to generate a detailed summary."

    # Extract key topics from high-importance scenes
    topics = []
    seen_topic_words = set()
    for scene in sorted(scenes, key=lambda s: s.importance_score, reverse=True):
        if len(topics) >= 5:
            break
        desc = scene.description.strip()
        if not desc:
            continue
        # Use first sentence or first 60 chars as topic
        topic = desc.split(".")[0].strip()
        if len(topic) > 60:
            topic = topic[:60].rsplit(" ", 1)[0]
        # Deduplicate by checking for word overlap
        topic_words = set(topic.lower().split())
        if topic_words & seen_topic_words and len(topic_words & seen_topic_words) > 2:
            continue
        seen_topic_words |= topic_words
        topics.append(topic)

    # If no scene topics, extract from transcript
    if not topics and transcript:
        # Use unique first words of segments as rough topics
        for seg in transcript[:20]:
            text = seg.text.strip()
            if len(text) > 15 and len(topics) < 4:
                topic = text.split(".")[0].strip()
                if len(topic) > 60:
                    topic = topic[:60].rsplit(" ", 1)[0]
                if topic and topic not in topics:
                    topics.append(topic)

    if not topics:
        topics = ["video content"]

    # Determine tone from scene importance scores
    if scenes:
        avg_score = sum(s.importance_score for s in scenes) / len(scenes)
        if avg_score >= 7:
            tone = "engaging and dynamic"
        elif avg_score >= 5:
            tone = "conversational"
        else:
            tone = "casual"
    else:
        tone = "conversational"

    audience = "general viewers"
    category = "video content"

    return {
        "overview": overview,
        "key_topics": topics,
        "tone": tone,
        "estimated_audience": audience,
        "content_category": category,
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

    async def text_complete(self, prompt: str, max_tokens: int = 4096) -> str:
        """Generic text completion. Override in subclasses for provider-specific impl."""
        raise NotImplementedError(f"{self.provider_name} does not support text_complete")

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
