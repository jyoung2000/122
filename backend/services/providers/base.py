import asyncio
import json
import logging
import re
from abc import ABC, abstractmethod
from typing import Callable, Optional

from backend.models import FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO

_mixin_logger = logging.getLogger(__name__)


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
        hot_zones=None,
        progress_callback=None,
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

    async def text_complete(self, prompt: str, max_tokens: int = 4096, timeout: int | None = None) -> str:
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

    @property
    def text_model_name(self) -> str:
        """Return the model ID used for text completion.

        Providers override this to return the actual model string
        (e.g. 'google/gemini-2.5-pro') so callers can log which
        model is handling their request and adapt timeouts.
        """
        return f"{self.provider_name}/unknown"

    @property
    def is_thinking_model(self) -> bool:
        """Return True if the text model is a 'thinking' model that needs extended timeouts.

        Thinking models (Gemini 2.5 Flash/Pro, Claude with extended thinking, o1/o3, etc.)
        internally reason before responding, routinely taking 60-120s+ on complex prompts.
        """
        model = self.text_model_name.lower()
        thinking_patterns = [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "o1",
            "o3",
            "o4-mini",
            "deepseek-r1",
            "qwq",
        ]
        return any(pattern in model for pattern in thinking_patterns)


class ChunkedClipDetectionMixin:
    """Mixin providing multi-pass windowed clip detection for any provider.

    Providers must implement _single_pass_clip_detection() for a single window.
    This mixin handles windowing, gap sweeps, partial results, and merge.

    Supports two modes:
    - concurrent (cloud APIs): processes 2 windows at a time via semaphore
    - sequential (Ollama/local): processes 1 window at a time for VRAM safety
    """

    @staticmethod
    def _deduplicate_clips(clips: list[ClipCandidate], max_overlap: float = 0.5) -> list[ClipCandidate]:
        """Remove clips that overlap by more than max_overlap fraction of the shorter clip."""
        if len(clips) <= 1:
            return clips

        sorted_clips = sorted(clips, key=lambda c: c.viral_score, reverse=True)
        kept: list[ClipCandidate] = []

        for clip in sorted_clips:
            is_duplicate = False
            for existing in kept:
                overlap_start = max(clip.start_time, existing.start_time)
                overlap_end = min(clip.end_time, existing.end_time)
                overlap_duration = max(0, overlap_end - overlap_start)
                shorter_duration = min(clip.duration, existing.duration)

                if shorter_duration > 0 and overlap_duration / shorter_duration > max_overlap:
                    is_duplicate = True
                    _mixin_logger.info(
                        "De-dup: dropping '%s' (%.0f-%.0fs, score=%d) — overlaps %.0f%% with '%s'",
                        clip.title, clip.start_time, clip.end_time, clip.viral_score,
                        (overlap_duration / shorter_duration) * 100, existing.title,
                    )
                    break

            if not is_duplicate:
                kept.append(clip)

        if len(kept) < len(clips):
            _mixin_logger.info("De-duplication: kept %d of %d clips", len(kept), len(clips))
        return kept

    @staticmethod
    def _condense_transcript_proportional(
        transcript: list[TranscriptSegment],
        max_chars: int = 12000,
        hot_zones=None,
    ) -> str:
        """Proportionally sample transcript so every time region gets representation.

        Hot zones get 2x weight so the AI gets more detail in high-potential regions.
        Never truncates mid-sentence — each bucket uses complete segments.
        """
        if not transcript:
            return "(no transcript)"

        # Merge consecutive same-speaker segments
        merged: list[tuple[float, float, str, str, float]] = []
        for seg in transcript:
            conf = getattr(seg, 'confidence', None) or 1.0
            if merged and merged[-1][3] == seg.speaker:
                prev = merged[-1]
                avg_conf = (prev[4] + conf) / 2
                merged[-1] = (prev[0], seg.end, prev[2] + " " + seg.text, seg.speaker, avg_conf)
            else:
                merged.append((seg.start, seg.end, seg.text, seg.speaker, conf))

        # Check if everything fits
        full_lines: list[str] = []
        for start, end, text, speaker, conf in merged:
            conf_marker = " [LOW_CONF]" if conf < 0.4 else ""
            full_lines.append(f"[{start:.0f}-{end:.0f}] {speaker}: {text}{conf_marker}")
        full_text = "\n".join(full_lines)
        if len(full_text) <= max_chars:
            return full_text

        # Build 60-second buckets
        if not merged:
            return "(no transcript)"
        video_end = merged[-1][1]
        bucket_size = 60.0
        num_buckets = max(1, int(video_end / bucket_size) + 1)

        buckets: list[list[tuple[float, float, str, str, float]]] = [[] for _ in range(num_buckets)]
        for seg in merged:
            bucket_idx = min(int(seg[0] / bucket_size), num_buckets - 1)
            buckets[bucket_idx].append(seg)

        # Score each bucket: 2x weight if overlapping hot zone
        hot_set: set[int] = set()
        if hot_zones:
            for z in hot_zones:
                z_start = getattr(z, 'start', 0)
                z_end = getattr(z, 'end', 0)
                for bi in range(max(0, int(z_start / bucket_size)), min(num_buckets, int(z_end / bucket_size) + 1)):
                    hot_set.add(bi)

        weights = [2.0 if i in hot_set else 1.0 for i in range(num_buckets)]
        total_weight = sum(weights)
        if total_weight == 0:
            total_weight = 1.0

        # Distribute char budget proportionally
        budget_per_bucket = [(max_chars * w / total_weight) for w in weights]

        # First and last bucket always get full detail
        if num_buckets >= 2:
            budget_per_bucket[0] = max(budget_per_bucket[0], max_chars * 0.08)
            budget_per_bucket[-1] = max(budget_per_bucket[-1], max_chars * 0.05)

        # Build output per bucket
        result_lines: list[str] = []
        for bi, bucket_segs in enumerate(buckets):
            budget = budget_per_bucket[bi]
            if not bucket_segs:
                continue

            bucket_lines: list[str] = []
            used = 0
            for start, end, text, speaker, conf in bucket_segs:
                conf_marker = " [LOW_CONF]" if conf < 0.4 else ""
                line = f"[{start:.0f}-{end:.0f}] {speaker}: {text}{conf_marker}"
                if used + len(line) + 1 <= budget:
                    bucket_lines.append(line)
                    used += len(line) + 1
                elif not bucket_lines:
                    # At least include one truncated line
                    avail = max(50, int(budget))
                    bucket_lines.append(line[:avail] + "...")
                    break
                else:
                    break

            if bucket_lines:
                result_lines.extend(bucket_lines)
            elif bucket_segs:
                # Bucket got no allocation — add a placeholder
                b_start = bucket_segs[0][0]
                b_end = bucket_segs[-1][1]
                result_lines.append(f"[{b_start:.0f}-{b_end:.0f}s] (content condensed)")

        return "\n".join(result_lines)

    async def _windowed_clip_detection(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        video_duration: float,
        window_duration: float = 600.0,
        overlap_duration: float = 120.0,
        _partial_results: Optional[list] = None,
        sequential: bool = False,
        **kwargs,
    ) -> list[ClipCandidate]:
        """Split long videos into overlapping windows and run clip detection on each.

        Args:
            sequential: If True, process windows one at a time (for Ollama/VRAM safety).
                        If False, process up to 2 concurrently.
        """
        # Build window list
        windows: list[tuple[float, float]] = []
        window_start = 0.0
        step = window_duration - overlap_duration
        if step <= 0:
            step = window_duration
        while window_start < video_duration:
            window_end = min(window_start + window_duration, video_duration)
            windows.append((window_start, window_end))
            window_start += step

        collected_clips: list[ClipCandidate] = []
        progress_callback = kwargs.get("progress_callback")

        async def _process_window(idx: int, w_start: float, w_end: float):
            window_transcript = [
                seg for seg in transcript
                if seg.start >= w_start - overlap_duration / 2
                and seg.end <= w_end + overlap_duration / 2
            ]
            window_scenes = [
                s for s in scenes
                if s.timestamp >= w_start and s.timestamp <= w_end
            ]

            _mixin_logger.info(
                "Window %d/%d: %.0f-%.0fs (%d segments, %d scenes)",
                idx + 1, len(windows), w_start, w_end,
                len(window_transcript), len(window_scenes),
            )

            try:
                clips = await self._single_pass_clip_detection(
                    window_transcript, window_scenes, w_end - w_start,
                    **kwargs,
                )
                collected_clips.extend(clips)
                if _partial_results is not None:
                    _partial_results.extend(clips)
                _mixin_logger.info(
                    "Window %d/%d found %d clips (total collected: %d)",
                    idx + 1, len(windows), len(clips), len(collected_clips),
                )
                if progress_callback:
                    try:
                        await progress_callback("pass1_window_done", {
                            "window_idx": idx + 1,
                            "window_total": len(windows),
                            "clips_so_far": len(collected_clips),
                        })
                    except Exception:
                        pass
                return clips
            except Exception as e:
                _mixin_logger.warning("Window %d clip detection failed: %s", idx + 1, e)
                return []

        if sequential:
            # Process one window at a time (Ollama / VRAM safety)
            for i, (ws, we) in enumerate(windows):
                cancel_check = kwargs.get("cancel_check")
                if cancel_check:
                    cancel_check()
                await _process_window(i, ws, we)
        else:
            # Concurrent with semaphore
            sem = asyncio.Semaphore(2)

            async def _concurrent_window(idx: int, ws: float, we: float):
                async with sem:
                    return await _process_window(idx, ws, we)

            try:
                results = await asyncio.gather(
                    *[_concurrent_window(i, ws, we) for i, (ws, we) in enumerate(windows)],
                    return_exceptions=True,
                )
                failed = sum(1 for r in results if isinstance(r, BaseException) or (isinstance(r, list) and not r))
                if failed == len(windows):
                    _mixin_logger.error("ALL %d windows failed in windowed detection", len(windows))
                elif failed > 0:
                    _mixin_logger.warning(
                        "%d/%d windows failed (%d clips from successful windows)",
                        failed, len(windows), len(collected_clips),
                    )
            except asyncio.CancelledError:
                _mixin_logger.warning(
                    "Windowed detection cancelled — returning %d clips from completed windows",
                    len(collected_clips),
                )

        return self._deduplicate_clips(collected_clips)

    async def _multi_pass_clip_detection(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        video_duration: float,
        tier=None,
        sequential: bool = False,
        custom_prompt: Optional[str] = None,
        cancel_check=None,
        clip_count: Optional[int] = None,
        min_duration: Optional[float] = None,
        max_duration: Optional[float] = None,
        video_summary: Optional[str] = None,
        existing_clips: Optional[str] = None,
        hot_zones=None,
        progress_callback=None,
        _partial_results: Optional[list] = None,
    ) -> list[ClipCandidate]:
        """Multi-pass clip detection for comprehensive coverage.

        Pass 1: Windowed detection across the full video
        Pass 2: Coverage sweep on under-represented regions
        Pass 3: Merge, deduplicate, score-sort

        Args:
            tier: VideoDurationTier controlling window sizes and gap limits.
            sequential: Process windows sequentially (for Ollama/local inference).
        """
        from backend.config import settings as _settings

        num_clips = clip_count or (tier.max_clip_candidates if tier else _settings.MAX_CLIP_CANDIDATES)

        # Window sizing — use tier if available, else adaptive
        if tier and tier.window_duration > 0:
            window_dur = tier.window_duration
            overlap_dur = tier.window_overlap
        elif video_duration > 1800:
            window_dur = 600.0
            overlap_dur = 120.0
        elif video_duration > 600:
            window_dur = 480.0
            overlap_dur = 90.0
        else:
            window_dur = video_duration
            overlap_dur = 0.0

        max_gaps = tier.max_gaps_pass2 if tier else 4

        _mixin_logger.info(
            "Multi-pass clip detection: %.0fs video, window=%.0fs, overlap=%.0fs, sequential=%s",
            video_duration, window_dur, overlap_dur, sequential,
        )

        all_clips: list[ClipCandidate] = []

        # Pass 1: windowed scan
        if progress_callback:
            step = window_dur - overlap_dur
            if step <= 0:
                step = window_dur
            _wcount = max(1, int((video_duration + step - 1) / step))
            await progress_callback("pass1_start", {"windows": _wcount})

        pass1_clips = await self._windowed_clip_detection(
            transcript, scenes, video_duration,
            window_duration=window_dur, overlap_duration=overlap_dur,
            _partial_results=_partial_results,
            sequential=sequential,
            custom_prompt=custom_prompt, cancel_check=cancel_check,
            clip_count=max(8, num_clips),
            min_duration=min_duration, max_duration=max_duration,
            video_summary=video_summary, existing_clips=existing_clips,
            progress_callback=progress_callback,
        )
        all_clips.extend(pass1_clips)
        _mixin_logger.info("Pass 1 found %d clips", len(pass1_clips))

        if progress_callback:
            await progress_callback("pass1_done", {"clips": len(pass1_clips)})

        # Pass 2: Coverage sweep — find regions with no clips
        if len(all_clips) < num_clips:
            from backend.services.hot_zone_scorer import get_coverage_gaps
            gaps = get_coverage_gaps(
                hot_zones or [], all_clips, video_duration,
                min_gap_duration=45.0, max_gaps=max_gaps,
            )

            if gaps:
                if progress_callback:
                    await progress_callback("pass2_start", {"gaps": len(gaps)})

                existing_desc = "\n".join(
                    f"  - '{c.title}' ({c.start_time:.0f}-{c.end_time:.0f}s)"
                    for c in all_clips
                )

                gap_sem = asyncio.Semaphore(1 if sequential else 2)

                async def _scan_gap(idx: int, gap_start: float, gap_end: float):
                    async with gap_sem:
                        if cancel_check:
                            cancel_check()
                        gap_duration = gap_end - gap_start
                        gap_transcript = [
                            s for s in transcript
                            if s.start >= gap_start - 15 and s.end <= gap_end + 15
                        ]
                        gap_scenes = [
                            s for s in scenes
                            if gap_start <= s.timestamp <= gap_end
                        ]
                        if not gap_transcript and not gap_scenes:
                            return []

                        if progress_callback:
                            await progress_callback("pass2_gap", {
                                "gap_idx": idx + 1,
                                "gap_total": len(gaps),
                                "start": gap_start,
                                "end": gap_end,
                            })

                        _mixin_logger.info(
                            "Pass 2: scanning gap %.0f-%.0fs (%d segments, %d scenes)",
                            gap_start, gap_end, len(gap_transcript), len(gap_scenes),
                        )

                        try:
                            if gap_duration > 600 and not sequential:
                                return await self._windowed_clip_detection(
                                    gap_transcript, gap_scenes, gap_duration,
                                    window_duration=480.0, overlap_duration=60.0,
                                    sequential=sequential,
                                    custom_prompt=custom_prompt, cancel_check=cancel_check,
                                    clip_count=max(3, num_clips // 2),
                                    min_duration=min_duration, max_duration=max_duration,
                                    video_summary=video_summary, existing_clips=existing_desc,
                                )
                            else:
                                return await self._single_pass_clip_detection(
                                    gap_transcript, gap_scenes, gap_duration,
                                    custom_prompt=custom_prompt, cancel_check=cancel_check,
                                    clip_count=3,
                                    min_duration=min_duration, max_duration=max_duration,
                                    video_summary=video_summary, existing_clips=existing_desc,
                                )
                        except Exception as e:
                            _mixin_logger.warning("Pass 2 gap scan failed: %s", e)
                            return []

                if sequential:
                    for i, (gs, ge) in enumerate(gaps):
                        result = await _scan_gap(i, gs, ge)
                        if result:
                            all_clips.extend(result)
                            _mixin_logger.info("Pass 2 found %d clips from gap", len(result))
                else:
                    gap_results = await asyncio.gather(
                        *[_scan_gap(i, gs, ge) for i, (gs, ge) in enumerate(gaps)],
                        return_exceptions=True,
                    )
                    for result in gap_results:
                        if isinstance(result, list):
                            all_clips.extend(result)
                        elif isinstance(result, BaseException):
                            _mixin_logger.warning("Pass 2 gap failed: %s", result)

        # Pass 3: Merge, deduplicate, sort by score
        if progress_callback:
            await progress_callback("pass3_merge", {"raw": len(all_clips)})
        raw_count = len(all_clips)
        all_clips = self._deduplicate_clips(all_clips, max_overlap=0.4)
        all_clips.sort(key=lambda c: c.viral_score, reverse=True)

        if len(all_clips) > num_clips:
            all_clips = all_clips[:num_clips]

        _mixin_logger.info(
            "Multi-pass complete: %d final clips (from %d raw)", len(all_clips), raw_count,
        )
        return all_clips
