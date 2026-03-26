"""Whisper transcription subprocess worker.

Runs faster-whisper in an isolated process so that CTranslate2's CUDA context
is fully released when transcription completes. Without subprocess isolation,
CTranslate2 holds ~1.6GB of VRAM indefinitely — leaving insufficient memory
for Ollama models on a 4GB GTX 1650.

The process writes transcription results to --output as JSON and exits.
All CUDA memory is reclaimed by the OS when the process terminates.
"""

import argparse
import gc
import json
import logging
import sys

logger = logging.getLogger(__name__)


def _filter_segments(result_segments: list[dict]) -> list[dict]:
    """Remove hallucinated segments: ghosts, loops, backward jumps, duplicates."""
    cleaned = []
    prev_text = ""
    for seg in result_segments:
        text = seg.get("text", "").strip()
        if not text:
            continue

        # Skip backward-jumping timestamps
        if cleaned and seg["start"] < cleaned[-1]["start"]:
            logger.warning("Filter: backward jump at %.1fs, skipping: %s", seg["start"], text[:60])
            continue

        # Skip runaway segments (>1500 chars)
        if len(text) > 1500:
            logger.warning("Filter: runaway at %.1fs (%d chars), skipping", seg["start"], len(text))
            continue

        # Skip ghost segments: long duration + short text + high no_speech
        duration = seg["end"] - seg["start"]
        no_speech = seg.get("no_speech_prob", 0.0)
        if duration > 30 and len(text) < 30 and no_speech > 0.5:
            logger.warning("Filter: ghost at %.1fs (%.0fs, no_speech=%.2f): %s", seg["start"], duration, no_speech, text[:60])
            continue

        # Skip exact duplicate of previous segment
        if prev_text and text == prev_text and duration < 5.0:
            logger.warning("Filter: exact duplicate at %.1fs: %s", seg["start"], text[:60])
            continue

        # Repeated n-gram detection
        words = text.lower().split()
        if len(words) >= 9:
            trigrams = [tuple(words[i:i+3]) for i in range(len(words) - 2)]
            counts = {}
            for tg in trigrams:
                counts[tg] = counts.get(tg, 0) + 1
            max_rep = max(counts.values()) if counts else 0
            if max_rep >= 3 and len(trigrams) > 0 and max_rep / len(trigrams) > 0.4:
                logger.warning("Filter: looping at %.1fs: %s", seg["start"], text[:60])
                continue

        cleaned.append(seg)
        prev_text = text

    removed = len(result_segments) - len(cleaned)
    if removed > 0:
        logger.info("Hallucination filter removed %d/%d segments", removed, len(result_segments))
    return cleaned


def main():
    parser = argparse.ArgumentParser(description="Whisper transcription worker")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--device-index", type=int, default=0)
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--language", default=None)
    parser.add_argument("--task", default="transcribe")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-filter", action="store_true", default=False)
    parser.add_argument("--word-timestamps", action="store_true", default=False)
    parser.add_argument("--initial-prompt", default=None)
    # Quality parameters (must match in-process transcription path)
    parser.add_argument("--best-of", type=int, default=3)
    parser.add_argument("--no-speech-threshold", type=float, default=0.8)
    parser.add_argument("--log-prob-threshold", type=float, default=-1.5)
    parser.add_argument("--compression-ratio-threshold", type=float, default=2.4)
    parser.add_argument("--repetition-penalty", type=float, default=1.1)
    parser.add_argument("--no-repeat-ngram-size", type=int, default=3)
    parser.add_argument("--condition-on-previous", action="store_true", default=True)
    parser.add_argument("--no-condition-on-previous", dest="condition_on_previous", action="store_false")
    parser.add_argument("--prompt-reset-on-temperature", type=float, default=0.5)
    parser.add_argument("--cjk", action="store_true", default=False)
    parser.add_argument("--vad-min-silence-ms", type=int, default=300)
    parser.add_argument("--vad-speech-pad-ms", type=int, default=600)
    parser.add_argument("--vad-onset", type=float, default=0.2)
    parser.add_argument("--vad-min-speech-ms", type=int, default=100)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    try:
        from faster_whisper import WhisperModel

        model_kwargs = {
            "device": args.device,
            "compute_type": args.compute_type,
        }
        if args.device == "cuda":
            model_kwargs["device_index"] = args.device_index

        logger.info(
            "Loading Whisper model=%s device=%s device_index=%d compute_type=%s",
            args.model, args.device, args.device_index, args.compute_type,
        )

        model = WhisperModel(args.model, **model_kwargs)

        logger.info("Transcribing: %s", args.audio)

        # All quality parameters matching the in-process path (transcription.py ~line 1076)
        compression_ratio = 3.0 if args.cjk else args.compression_ratio_threshold

        transcribe_kwargs = {
            "beam_size": args.beam_size,
            "best_of": args.best_of if args.beam_size > 1 else 1,
            "word_timestamps": args.word_timestamps,
            "vad_filter": args.vad_filter,
            "task": args.task,
            "condition_on_previous_text": args.condition_on_previous,
            "no_speech_threshold": args.no_speech_threshold,
            "log_prob_threshold": args.log_prob_threshold,
            "compression_ratio_threshold": compression_ratio,
            "repetition_penalty": args.repetition_penalty,
            "no_repeat_ngram_size": args.no_repeat_ngram_size,
            "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            "prompt_reset_on_temperature": args.prompt_reset_on_temperature,
        }

        if args.vad_filter:
            transcribe_kwargs["vad_parameters"] = {
                "min_silence_duration_ms": args.vad_min_silence_ms,
                "speech_pad_ms": args.vad_speech_pad_ms,
                "onset": args.vad_onset,
                "min_speech_duration_ms": args.vad_min_speech_ms,
            }

        if args.language:
            transcribe_kwargs["language"] = args.language
        if args.initial_prompt:
            transcribe_kwargs["initial_prompt"] = args.initial_prompt

        logger.info(
            "Transcribe params: beam=%d, best_of=%d, repetition_penalty=%.1f, "
            "compression_ratio=%.1f, no_speech=%.1f, cjk=%s",
            args.beam_size, transcribe_kwargs["best_of"],
            args.repetition_penalty, compression_ratio,
            args.no_speech_threshold, args.cjk,
        )

        segments_gen, info = model.transcribe(args.audio, **transcribe_kwargs)

        # Materialize segments (generator)
        result_segments = []
        for seg in segments_gen:
            seg_data = {
                "id": seg.id,
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
                "avg_logprob": seg.avg_logprob,
                "no_speech_prob": seg.no_speech_prob,
            }
            if seg.words:
                seg_data["words"] = [
                    {"start": w.start, "end": w.end, "word": w.word, "probability": w.probability}
                    for w in seg.words
                ]
            result_segments.append(seg_data)

        # Filter hallucinations (ghosts, loops, backward jumps, duplicates)
        result_segments = _filter_segments(result_segments)

        result = {
            "segments": result_segments,
            "info": {
                "language": info.language,
                "language_probability": info.language_probability,
                "duration": info.duration,
                "duration_after_vad": getattr(info, "duration_after_vad", info.duration),
            },
            "status": "ok",
        }

        # CTranslate2 silently returns 0 segments when cudaMalloc fails
        if len(result_segments) == 0 and info.duration > 10:
            logger.error(
                "WHISPER WORKER: 0 segments for %.1fs audio (language=%s, model=%s). "
                "CTranslate2 likely hit a silent CUDA OOM. "
                "Parent process should retry with a smaller model.",
                info.duration, info.language, args.model,
            )
            result["warning"] = "zero_segments_possible_oom"

        with open(args.output, "w") as f:
            json.dump(result, f)

        logger.info(
            "Transcription complete: %d segments, %.1fs, language=%s",
            len(result_segments), info.duration, info.language,
        )

        # Explicit cleanup before exit
        del model
        gc.collect()

    except Exception as e:
        logger.error("Whisper worker failed: %s", e, exc_info=True)
        with open(args.output, "w") as f:
            json.dump({"status": "error", "error": str(e)}, f)
        sys.exit(1)

    # Process exits → OS reclaims ALL CUDA memory
    sys.exit(0)


if __name__ == "__main__":
    main()
