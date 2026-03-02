"""Tests for the transcription service — speaker assignment logic.

Covers:
  - _assign_speakers with various gap patterns
  - Empty input handling
  - Speaker count capping at MAX_SPEAKERS
  - Edge cases: single segment, overlapping segments
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.services.transcription import _assign_speakers
from backend.models import TranscriptSegment


class TestAssignSpeakersEmpty(unittest.TestCase):
    """Empty and trivial inputs."""

    def test_empty_list(self):
        result = _assign_speakers([])
        self.assertEqual(result, [])

    def test_single_segment(self):
        segments = [{"start": 0.0, "end": 2.5, "text": "Hello world"}]
        result = _assign_speakers(segments)
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], TranscriptSegment)
        self.assertEqual(result[0].speaker, "Speaker 1")
        self.assertEqual(result[0].text, "Hello world")


class TestAssignSpeakersGaps(unittest.TestCase):
    """Test gap-based speaker detection."""

    def test_short_gap_same_speaker(self):
        """Gaps < 1.5s should keep the same speaker."""
        segments = [
            {"start": 0.0, "end": 2.0, "text": "First part"},
            {"start": 2.5, "end": 4.0, "text": "Second part"},  # 0.5s gap
            {"start": 4.2, "end": 6.0, "text": "Third part"},   # 0.2s gap
        ]
        result = _assign_speakers(segments)
        self.assertEqual(len(result), 3)
        # All should be same speaker
        speakers = [s.speaker for s in result]
        self.assertEqual(len(set(speakers)), 1)
        self.assertEqual(speakers[0], "Speaker 1")

    def test_medium_gap_switches_speaker(self):
        """Gaps between 1.5-4s should trigger a speaker turn."""
        segments = [
            {"start": 0.0, "end": 2.0, "text": "Person A talks"},
            {"start": 4.0, "end": 6.0, "text": "Person B responds"},  # 2.0s gap (turn)
            {"start": 8.0, "end": 10.0, "text": "Person A again"},    # 2.0s gap (turn)
        ]
        result = _assign_speakers(segments)
        self.assertEqual(len(result), 3)
        # Should toggle between speakers
        self.assertEqual(result[0].speaker, "Speaker 1")
        self.assertEqual(result[1].speaker, "Speaker 2")
        self.assertEqual(result[2].speaker, "Speaker 1")

    def test_large_gap_introduces_new_speaker(self):
        """Gaps > 4s should introduce a new speaker (up to MAX_SPEAKERS)."""
        segments = [
            {"start": 0.0, "end": 2.0, "text": "Speaker one"},
            {"start": 7.0, "end": 9.0, "text": "New speaker"},      # 5.0s gap (new)
            {"start": 14.0, "end": 16.0, "text": "Another speaker"}, # 5.0s gap (new)
        ]
        result = _assign_speakers(segments)
        self.assertEqual(len(result), 3)
        speakers = [s.speaker for s in result]
        # Should have 3 distinct speakers
        self.assertEqual(len(set(speakers)), 3)

    def test_max_speakers_cap(self):
        """Should not exceed MAX_SPEAKERS (4)."""
        # 6 segments with large gaps — should cap at 4 speakers
        segments = []
        for i in range(6):
            start = i * 10.0  # 10s gaps between each
            segments.append({"start": start, "end": start + 2.0, "text": f"Segment {i}"})
        result = _assign_speakers(segments)
        speakers = set(s.speaker for s in result)
        self.assertLessEqual(len(speakers), 4)


class TestAssignSpeakersRounding(unittest.TestCase):
    """Test that timestamps are rounded properly."""

    def test_timestamps_rounded(self):
        segments = [
            {"start": 0.123456, "end": 2.789012, "text": "Test"},
        ]
        result = _assign_speakers(segments)
        self.assertEqual(result[0].start, 0.12)
        self.assertEqual(result[0].end, 2.79)


class TestAssignSpeakersConversation(unittest.TestCase):
    """Test realistic conversation patterns."""

    def test_two_person_conversation(self):
        """Simulate a natural back-and-forth conversation."""
        segments = [
            {"start": 0.0, "end": 3.0, "text": "Hey how's it going?"},
            {"start": 3.2, "end": 3.5, "text": "Yeah"},              # 0.2s gap (same speaker continuation)
            {"start": 5.5, "end": 8.0, "text": "I'm doing great, thanks!"},  # 2.0s gap (turn)
            {"start": 8.3, "end": 11.0, "text": "So what's new?"},    # 0.3s gap (same)
            {"start": 13.0, "end": 16.0, "text": "Not much, you know"}, # 2.0s gap (turn)
        ]
        result = _assign_speakers(segments)
        self.assertEqual(len(result), 5)
        # Pattern: 1, 1, 2, 2, 1
        self.assertEqual(result[0].speaker, "Speaker 1")
        self.assertEqual(result[1].speaker, "Speaker 1")
        self.assertEqual(result[2].speaker, "Speaker 2")
        self.assertEqual(result[3].speaker, "Speaker 2")
        self.assertEqual(result[4].speaker, "Speaker 1")

    def test_monologue(self):
        """A single speaker with only short gaps should remain as one speaker."""
        segments = [
            {"start": 0.0, "end": 5.0, "text": "First sentence"},
            {"start": 5.3, "end": 10.0, "text": "Second sentence"},
            {"start": 10.2, "end": 15.0, "text": "Third sentence"},
            {"start": 15.5, "end": 20.0, "text": "Fourth sentence"},
        ]
        result = _assign_speakers(segments)
        speakers = set(s.speaker for s in result)
        self.assertEqual(len(speakers), 1)


if __name__ == "__main__":
    unittest.main()
