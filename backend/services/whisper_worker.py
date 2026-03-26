"""Whisper transcription subprocess worker.

Runs faster-whisper in an isolated process so that CTranslate2's CUDA context
is fully released when transcription completes. Without subprocess isolation,
CTranslate2 holds ~1.6GB of VRAM indefinitely — leaving insufficient memory
for Ollama models on a 4GB GTX 1650.

PyTorch's torch.cuda.empty_cache() is a no-op in this container because
torch is compiled for CUDA 13.0 but the driver only supports 12.9. CTranslate2
uses its own CUDA runtime (12.3.2) which works fine but cannot be released
from within the process.

Usage:
    python -m backend.services.whisper_worker \\
        --audio /path/to/audio.wav \\
        --output /path/to/result.json \\
        --model large-v3 \\
        --device cuda \\
        --device-index 0 \\
        --compute-type float16

The process writes transcription results to --output as JSON and exits.
All CUDA memory is reclaimed by the OS when the process terminates.
"""

import argparse
import gc
import json
import logging
import sys

logger = logging.getLogger(__name__)


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

        transcribe_kwargs = {
            "beam_size": args.beam_size,
            "word_timestamps": args.word_timestamps,
            "vad_filter": args.vad_filter,
            "task": args.task,
        }
        if args.language:
            transcribe_kwargs["language"] = args.language
        if args.initial_prompt:
            transcribe_kwargs["initial_prompt"] = args.initial_prompt

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
