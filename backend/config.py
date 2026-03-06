from pydantic_settings import BaseSettings
from typing import Optional
from functools import lru_cache


class Settings(BaseSettings):
    # Primary provider
    AI_PROVIDER: str = "openrouter"

    # OpenRouter (uses OpenAI-compatible API — set your key from openrouter.ai)
    OPENROUTER_API_KEY: str = ""
    OPENROUTER_PRESET: str = "balanced"  # free | efficient | balanced | premium | custom
    OPENROUTER_VISION_MODEL: str = "google/gemini-2.5-flash"
    OPENROUTER_TEXT_MODEL: str = "google/gemini-2.5-pro"
    OPENROUTER_SUMMARY_MODEL: str = "google/gemini-2.5-flash"

    # Direct provider keys
    ANTHROPIC_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    GEMINI_USE_NATIVE_VIDEO: bool = False
    GROQ_API_KEY: str = ""

    # Ollama
    OLLAMA_HOST: str = "http://ollama:11434"
    OLLAMA_VISION_MODEL: str = "moondream"
    OLLAMA_TEXT_MODEL: str = "llama3.2:3b"

    # Fallback chain (ollama excluded by default — user can enable it in Settings)
    AI_FALLBACK_CHAIN: str = "openrouter,gemini,groq"

    # Analysis settings
    WHISPER_MODEL: str = "small"
    WHISPER_BEAM_SIZE: int = 1         # 1=fast/greedy, 5=slow/accurate
    WHISPER_VAD_FILTER: bool = True    # skip silence — major speedup
    FRAME_SAMPLE_RATE: int = 10        # seconds between frames (lower=more detail, slower)
    MAX_CLIP_CANDIDATES: int = 12
    CONCURRENT_ANALYSES: int = 2
    AUTO_ANALYZE: bool = True
    SUBJECT_TRACKING_ENABLED: bool = True

    # FFmpeg encoding settings
    FFMPEG_PRESET: str = "fast"       # ultrafast|superfast|veryfast|faster|fast|medium|slow
    FFMPEG_CRF: int = 23             # 0-51, lower=better quality, 23=default
    FFMPEG_THREADS: int = 0          # 0=auto (all cores), 1-N=explicit
    FFMPEG_FASTSTART: bool = True    # -movflags +faststart for web streaming

    # GPU Hardware Acceleration — user toggle persisted to user_settings.json
    GPU_ACCELERATION_ENABLED: bool = False   # Toggle in Settings > Advanced
    GPU_VENDOR_OVERRIDE: str = ""            # Empty = auto-detect; "nvidia", "intel", "amd", "apple" to force
    GPU_HWDECODE_ENABLED: bool = True        # Use GPU for video decoding (NVDEC/DXVA2/VAAPI/VideoToolbox)
    GPU_HEVC_FOR_4K: bool = True             # Use HEVC encoder for 4K exports when available

    @property
    def active_provider_chain(self) -> list[str]:
        return [p.strip() for p in self.AI_FALLBACK_CHAIN.split(",") if p.strip()]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
