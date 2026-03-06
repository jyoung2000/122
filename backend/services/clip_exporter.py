import asyncio
import glob
import json
import logging
import math
import os
import platform
import subprocess

import re

_IS_WINDOWS = platform.system() == "Windows"
_IS_MACOS = platform.system() == "Darwin"

from backend.config import settings as app_settings
from backend.models import TranscriptSegment
from backend.services.ass_generator import (
    generate_ass,
    FONT_SIZE_MAP as ASS_FONT_SIZE_MAP,
    FONT_WEIGHT_MAP as ASS_FONT_WEIGHT_MAP,
    POSITION_ALIGNMENT as ASS_POSITION_ALIGNMENT,
    REF_W as ASS_REF_W,
    REF_H as ASS_REF_H,
    MIN_TEXT_AREA_W,
    MIN_TEXT_AREA_H,
    _hex_to_ass_color,
    _hex_to_ass_color_with_alpha,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# GPU hardware acceleration detection & encoder selection
# ---------------------------------------------------------------------------

_gpu_info: dict | None = None


def _gpu_info_cache_clear():
    """Clear the cached GPU info so next detect_gpu_capabilities() call re-scans."""
    global _gpu_info
    _gpu_info = None


def detect_gpu_capabilities(force_redetect: bool = False) -> dict:
    """Detect available GPU hardware encoders/decoders.

    Called when:
    - User toggles GPU acceleration ON in Settings (force_redetect=True)
    - First FFmpeg export after container start (lazy init from _gpu_encode_args)
    - GET /api/gpu-acceleration endpoint

    Detection steps:
    1. Check GPU_ACCELERATION_ENABLED — if False, return CPU fallback immediately
    2. Run nvidia-smi to detect NVIDIA GPU (name, VRAM, driver version)
    3. Probe FFmpeg for compiled-in encoders (h264_nvenc, h264_vaapi, h264_qsv)
    4. Test-encode a tiny null video with each detected encoder to confirm it works
    5. Check CUDA availability for faster-whisper transcription
    6. Return best available encoder + full GPU info dict
    """
    global _gpu_info

    if _gpu_info is not None and not force_redetect:
        return _gpu_info

    # Default: CPU-only fallback
    info = {
        "vendor": "none",
        "gpu_name": "None (CPU only)",
        "encoder": "libx264",
        "hevc_encoder": None,
        "decoder": None,
        "hwaccel": None,
        "hwaccel_device": None,
        "scale_filter": "scale",
        "capabilities": ["encode_cpu"],
        "vram_mb": 0,
        "driver_version": "",
        "cuda_available": False,
        "whisper_device": "cpu",
    }

    # Gate on user toggle — if GPU acceleration is toggled OFF in Settings,
    # return CPU immediately but still detect GPUs so the UI can show them.
    if not app_settings.GPU_ACCELERATION_ENABLED:
        info["gpus"] = _detect_all_gpus()
        _gpu_info = info
        return info

    forced_vendor = (app_settings.GPU_VENDOR_OVERRIDE or "").lower().strip() or "auto"

    # ── Step 1: Detect NVIDIA GPU(s) via nvidia-smi ──
    nvidia_detected = False
    nvidia_gpus = []
    if forced_vendor in ("auto", "nvidia"):
        try:
            smi = subprocess.run(
                ["nvidia-smi", "--query-gpu=index,name,memory.total,driver_version",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10,
            )
            if smi.returncode == 0 and smi.stdout.strip():
                for line in smi.stdout.strip().split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    parts = [p.strip() for p in line.split(",")]
                    gpu_idx = parts[0] if len(parts) > 0 else "0"
                    gpu_name = parts[1] if len(parts) > 1 else "NVIDIA GPU"
                    vram = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
                    driver = parts[3] if len(parts) > 3 else ""
                    nvidia_gpus.append({
                        "index": gpu_idx, "name": gpu_name,
                        "vram_mb": vram, "driver_version": driver,
                        "vendor": "nvidia",
                    })
                    logger.info("NVIDIA GPU %s detected: %s (%d MB VRAM, driver %s)", gpu_idx, gpu_name, vram, driver)
                if nvidia_gpus:
                    nvidia_detected = True
                    # Primary GPU info uses first NVIDIA GPU for encoder selection
                    info.update({
                        "gpu_name": nvidia_gpus[0]["name"],
                        "vram_mb": nvidia_gpus[0]["vram_mb"],
                        "driver_version": nvidia_gpus[0]["driver_version"],
                    })
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            logger.debug("nvidia-smi not available: %s", e)

    # ── Step 2: Check CUDA for Whisper ──
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            info["cuda_available"] = True
            info["whisper_device"] = "cuda"
            if "whisper_cuda" not in info["capabilities"]:
                info["capabilities"].append("whisper_cuda")
            logger.info("CUDA available for Whisper transcription")
    except Exception:
        pass

    # ── Step 3: Probe FFmpeg for available HW encoders ──
    available_encoders: set[str] = set()
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=10,
        )
        for enc in (
            "h264_nvenc", "h264_vaapi", "h264_qsv",
            "hevc_nvenc", "hevc_vaapi", "hevc_qsv",
            "h264_videotoolbox", "hevc_videotoolbox",
        ):
            if enc in result.stdout:
                available_encoders.add(enc)
        logger.info("FFmpeg HW encoders available: %s", available_encoders or "none")
    except Exception as e:
        logger.warning("FFmpeg encoder probe failed: %s", e)

    # ── Step 4: Test each encoder (priority: NVENC > QSV > VAAPI) ──
    encoder_configs = []

    if "h264_nvenc" in available_encoders and (forced_vendor in ("auto", "nvidia") or nvidia_detected):
        encoder_configs.append({
            "vendor": "nvidia", "encoder": "h264_nvenc", "decoder": "h264_cuvid",
            "hwaccel": "cuda", "hwaccel_device": None,
            "test_cmd": [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1",
                "-c:v", "h264_nvenc", "-f", "null", "-",
            ],
        })

    if "h264_qsv" in available_encoders and forced_vendor in ("auto", "intel"):
        # On Windows, QSV works without an explicit device path; on Linux
        # it needs the DRI render node.
        qsv_device = None if _IS_WINDOWS else "/dev/dri/renderD128"
        qsv_test_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1",
            "-c:v", "h264_qsv", "-f", "null", "-",
        ]
        # On Windows, QSV auto-discovers the Intel GPU via DXVA2/D3D11
        if not _IS_WINDOWS and qsv_device:
            qsv_ok = os.path.exists(qsv_device)
        else:
            qsv_ok = True
        if qsv_ok:
            encoder_configs.append({
                "vendor": "intel", "encoder": "h264_qsv", "decoder": "h264_qsv",
                "hwaccel": "qsv", "hwaccel_device": qsv_device,
                "test_cmd": qsv_test_cmd,
            })

    if "h264_vaapi" in available_encoders and forced_vendor in ("auto", "intel", "amd"):
        # VAAPI is Linux-only (not available on Windows)
        vaapi_dev = "/dev/dri/renderD128"
        if not _IS_WINDOWS and os.path.exists(vaapi_dev):
            encoder_configs.append({
                "vendor": "amd" if forced_vendor == "amd" else "intel",
                "encoder": "h264_vaapi", "decoder": "h264_vaapi",
                "hwaccel": "vaapi", "hwaccel_device": vaapi_dev,
                "test_cmd": [
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-vaapi_device", vaapi_dev,
                    "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1",
                    "-vf", "format=nv12,hwupload",
                    "-c:v", "h264_vaapi", "-f", "null", "-",
                ],
            })

    # ── macOS VideoToolbox (Apple Silicon & Intel Macs) ──
    # VideoToolbox uses the Apple Media Engine for H.264/HEVC encode/decode
    # on M1/M2/M3/M4 chips and the Intel iGPU on older Macs.
    if _IS_MACOS and "h264_videotoolbox" in available_encoders and forced_vendor in ("auto", "apple"):
        encoder_configs.append({
            "vendor": "apple", "encoder": "h264_videotoolbox", "decoder": None,
            "hwaccel": "videotoolbox", "hwaccel_device": None,
            "test_cmd": [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1",
                "-c:v", "h264_videotoolbox", "-f", "null", "-",
            ],
        })

    for cfg in encoder_configs:
        try:
            test = subprocess.run(cfg["test_cmd"], capture_output=True, text=True, timeout=15)
            if test.returncode == 0:
                info.update({
                    "vendor": cfg["vendor"], "encoder": cfg["encoder"],
                    "decoder": cfg["decoder"], "hwaccel": cfg["hwaccel"],
                    "hwaccel_device": cfg["hwaccel_device"],
                    "capabilities": ["encode_gpu", "decode_gpu"],
                })
                if info["cuda_available"]:
                    info["capabilities"].append("whisper_cuda")
                # Probe HEVC encoder availability (for 4K exports)
                hevc_enc = {
                    "nvidia": "hevc_nvenc", "intel": "hevc_qsv",
                    "amd": "hevc_vaapi", "apple": "hevc_videotoolbox",
                }.get(cfg["vendor"])
                if hevc_enc and hevc_enc in available_encoders:
                    info["hevc_encoder"] = hevc_enc
                    info["capabilities"].append("encode_hevc_gpu")
                    logger.info("HEVC GPU encoder available: %s", hevc_enc)
                # Detect GPU name for Intel/AMD if not set by nvidia-smi
                if cfg["vendor"] != "nvidia" and "None" in info["gpu_name"]:
                    _detect_non_nvidia_gpu_name(info, cfg["vendor"])
                logger.info("GPU acceleration active: %s encoder=%s", cfg["vendor"].upper(), cfg["encoder"])
                info["gpus"] = _detect_all_gpus()
                _gpu_info = info
                return info
            else:
                logger.debug("Encoder %s test failed: %s", cfg["encoder"], test.stderr[:200])
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            logger.debug("Encoder %s test error: %s", cfg["encoder"], e)

    # No working GPU encoder
    if nvidia_detected:
        logger.warning(
            "NVIDIA GPU detected (%s) but NVENC encoding unavailable. "
            "Rebuild with Dockerfile.gpu for hardware encoding. "
            "CUDA Whisper transcription will still work if available.",
            info["gpu_name"],
        )

    logger.info("No GPU encoder available — using CPU encoding (libx264)")
    info["gpus"] = _detect_all_gpus()
    _gpu_info = info
    return info


def _detect_non_nvidia_gpu_name(info: dict, vendor: str):
    """Try to detect Intel/AMD/Apple GPU name from platform-specific tools."""
    try:
        if _IS_MACOS:
            # On macOS, use system_profiler to get GPU name
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType", "-detailLevel", "mini"],
                capture_output=True, text=True, timeout=10,
            )
            for line in result.stdout.split("\n"):
                stripped = line.strip()
                if stripped.startswith("Chipset Model:"):
                    info["gpu_name"] = stripped.split(":", 1)[1].strip()
                    break
            return
        elif _IS_WINDOWS:
            # Use WMIC to enumerate display adapters on Windows
            result = subprocess.run(
                ["wmic", "path", "win32_VideoController", "get", "Name"],
                capture_output=True, text=True, timeout=10,
            )
            for line in result.stdout.split("\n"):
                lower = line.strip().lower()
                if not lower or "name" in lower:
                    continue
                if vendor == "intel" and "intel" in lower:
                    info["gpu_name"] = line.strip()
                    break
                elif vendor == "amd" and ("amd" in lower or "radeon" in lower):
                    info["gpu_name"] = line.strip()
                    break
        else:
            result = subprocess.run(["lspci"], capture_output=True, text=True, timeout=5)
            for line in result.stdout.split("\n"):
                lower = line.lower()
                if "vga" in lower or "3d controller" in lower or "display" in lower:
                    if vendor == "intel" and "intel" in lower:
                        info["gpu_name"] = line.split(": ", 1)[-1].strip() if ": " in line else "Intel GPU"
                        break
                    elif vendor == "amd" and ("amd" in lower or "radeon" in lower):
                        info["gpu_name"] = line.split(": ", 1)[-1].strip() if ": " in line else "AMD GPU"
                        break
    except Exception:
        pass


def _detect_all_gpus() -> list[dict]:
    """Detect ALL GPUs visible to the container (NVIDIA, Intel, AMD).

    Returns a list of dicts with: name, vendor, vram_mb, driver_version, type.
    This is called alongside detect_gpu_capabilities() to populate the gpus[] list.
    """
    gpus = []
    seen_names = set()

    # ── NVIDIA GPUs via nvidia-smi ──
    try:
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.total,driver_version",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        if smi.returncode == 0 and smi.stdout.strip():
            for line in smi.stdout.strip().split("\n"):
                line = line.strip()
                if not line:
                    continue
                parts = [p.strip() for p in line.split(",")]
                gpu_idx = parts[0] if len(parts) > 0 else "0"
                gpu_name = parts[1] if len(parts) > 1 else "NVIDIA GPU"
                vram = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
                driver = parts[3] if len(parts) > 3 else ""
                gpus.append({
                    "index": gpu_idx, "name": gpu_name, "vendor": "nvidia",
                    "vram_mb": vram, "driver_version": driver, "type": "discrete",
                })
                seen_names.add(gpu_name.lower())
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # ── All GPUs via lspci (Linux) — catches Intel iGPU and AMD GPUs ──
    lspci_found = False
    if not _IS_MACOS and not _IS_WINDOWS:
        try:
            result = subprocess.run(["lspci"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                lspci_found = True
                for line in result.stdout.split("\n"):
                    lower = line.lower()
                    if not ("vga" in lower or "3d controller" in lower or "display" in lower):
                        continue
                    gpu_name = line.split(": ", 1)[-1].strip() if ": " in line else "Unknown GPU"
                    # Skip if already found via nvidia-smi (avoid duplicates)
                    if any(sn in gpu_name.lower() for sn in seen_names):
                        continue
                    if "nvidia" in lower and any(sn in lower for sn in seen_names):
                        continue
                    vendor = "intel" if "intel" in lower else "amd" if ("amd" in lower or "radeon" in lower) else "nvidia" if "nvidia" in lower else "unknown"
                    gpu_type = "integrated" if vendor == "intel" else "discrete"
                    gpus.append({
                        "index": str(len(gpus)), "name": gpu_name, "vendor": vendor,
                        "vram_mb": 0, "driver_version": "", "type": gpu_type,
                    })
                    seen_names.add(gpu_name.lower())
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    # ── Fallback: /sys/class/drm/ (Linux containers without lspci) ──
    # Docker containers often lack lspci (pciutils package).  This fallback
    # reads directly from sysfs to discover Intel/AMD/NVIDIA GPUs that the
    # kernel exposes to the container.
    if not _IS_MACOS and not _IS_WINDOWS and not lspci_found:
        _PCI_GPU_VENDORS = {
            "0x10de": "nvidia", "0x8086": "intel", "0x1002": "amd",
        }
        try:
            for card_dir in sorted(glob.glob("/sys/class/drm/card[0-9]*/device")):
                try:
                    vendor_path = os.path.join(card_dir, "vendor")
                    if not os.path.isfile(vendor_path):
                        continue
                    vendor_id = open(vendor_path).read().strip().lower()
                    vendor = _PCI_GPU_VENDORS.get(vendor_id)
                    if not vendor:
                        continue
                    # Try to read device name from uevent or construct one
                    gpu_name = f"{vendor.upper()} GPU"
                    uevent_path = os.path.join(card_dir, "uevent")
                    if os.path.isfile(uevent_path):
                        for ue_line in open(uevent_path):
                            if ue_line.startswith("PCI_SLOT_NAME="):
                                slot = ue_line.strip().split("=", 1)[1]
                                gpu_name = f"{vendor.upper()} GPU ({slot})"
                                break
                    # Try to read VRAM from resource (BAR sizes)
                    vram_mb = 0
                    resource_path = os.path.join(card_dir, "resource")
                    if os.path.isfile(resource_path):
                        try:
                            for res_line in open(resource_path):
                                parts = res_line.strip().split()
                                if len(parts) >= 2:
                                    start = int(parts[0], 16)
                                    end = int(parts[1], 16)
                                    size_mb = (end - start + 1) // (1024 * 1024)
                                    if size_mb > vram_mb:
                                        vram_mb = size_mb
                        except (ValueError, IndexError):
                            pass
                    # Skip if already detected (e.g., NVIDIA via nvidia-smi)
                    if vendor == "nvidia" and any(g["vendor"] == "nvidia" for g in gpus):
                        continue
                    if gpu_name.lower() in seen_names:
                        continue
                    gpu_type = "integrated" if vendor == "intel" else "discrete"
                    gpus.append({
                        "index": str(len(gpus)), "name": gpu_name, "vendor": vendor,
                        "vram_mb": vram_mb, "driver_version": "", "type": gpu_type,
                    })
                    seen_names.add(gpu_name.lower())
                except (OSError, IOError):
                    continue
        except Exception:
            pass

    # ── Fallback: /proc/driver/nvidia/gpus/ (multi-NVIDIA without nvidia-smi) ──
    # Some containers have the NVIDIA kernel module loaded but nvidia-smi
    # is not installed.  /proc/driver/nvidia/gpus/ lists all NVIDIA GPUs.
    if not gpus or (not any(g["vendor"] == "nvidia" for g in gpus)):
        try:
            nv_gpu_dirs = sorted(glob.glob("/proc/driver/nvidia/gpus/*/information"))
            for info_path in nv_gpu_dirs:
                try:
                    content = open(info_path).read()
                    gpu_name = "NVIDIA GPU"
                    for line in content.split("\n"):
                        if line.startswith("Model:"):
                            gpu_name = line.split(":", 1)[1].strip()
                            break
                    if gpu_name.lower() in seen_names:
                        continue
                    gpus.append({
                        "index": str(len(gpus)), "name": gpu_name, "vendor": "nvidia",
                        "vram_mb": 0, "driver_version": "", "type": "discrete",
                    })
                    seen_names.add(gpu_name.lower())
                except (OSError, IOError):
                    continue
        except Exception:
            pass

    # ── macOS GPUs via system_profiler ──
    if _IS_MACOS:
        try:
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType", "-detailLevel", "mini"],
                capture_output=True, text=True, timeout=10,
            )
            for line in result.stdout.split("\n"):
                stripped = line.strip()
                if stripped.startswith("Chipset Model:"):
                    gpu_name = stripped.split(":", 1)[1].strip()
                    gpus.append({
                        "index": str(len(gpus)), "name": gpu_name, "vendor": "apple",
                        "vram_mb": 0, "driver_version": "", "type": "integrated",
                    })
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    # ── Windows GPUs via WMIC ──
    if _IS_WINDOWS:
        try:
            result = subprocess.run(
                ["wmic", "path", "win32_VideoController", "get", "Name"],
                capture_output=True, text=True, timeout=10,
            )
            for line in result.stdout.split("\n"):
                name = line.strip()
                lower = name.lower()
                if not lower or "name" in lower:
                    continue
                if any(sn in lower for sn in seen_names):
                    continue
                vendor = "intel" if "intel" in lower else "amd" if ("amd" in lower or "radeon" in lower) else "nvidia" if "nvidia" in lower else "unknown"
                gpu_type = "integrated" if vendor == "intel" else "discrete"
                gpus.append({
                    "index": str(len(gpus)), "name": name, "vendor": vendor,
                    "vram_mb": 0, "driver_version": "", "type": gpu_type,
                })
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    logger.info("All GPUs detected: %s", [g["name"] for g in gpus])
    return gpus


def _gpu_encode_args(quality_preset: dict, export_quality: str = "1080p") -> list[str]:
    """Return FFmpeg encoder arguments based on user toggle + detected GPU.

    Critical: checks GPU_ACCELERATION_ENABLED first. If the user has the
    toggle OFF in Settings, always returns libx264 CPU args regardless of
    what GPUs are available. Only when ON does it use the detected GPU encoder.
    """
    # Respect user toggle — if OFF, always CPU
    if not app_settings.GPU_ACCELERATION_ENABLED:
        return [
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", quality_preset.get("preset", "medium"),
            "-crf", str(quality_preset.get("crf", 23)),
        ]

    gpu = detect_gpu_capabilities()
    crf = quality_preset.get("crf", 23)

    # Use HEVC for 4K exports when the GPU supports it — HEVC delivers
    # ~40% better compression at 4K than H.264 with similar quality.
    use_hevc = (
        export_quality == "4k"
        and gpu.get("hevc_encoder")
        and app_settings.GPU_HEVC_FOR_4K
    )

    # GPU device index — lets the user pick which GPU to encode on
    gpu_device = (app_settings.GPU_DEVICE_INDEX or "").strip()

    if gpu["encoder"] == "h264_nvenc":
        # NVENC supports --gpu N to select a specific NVIDIA GPU
        device_args = ["-gpu", gpu_device] if gpu_device else []
        if use_hevc:
            return device_args + [
                "-c:v", "hevc_nvenc",
                "-preset", "p5",
                "-rc", "vbr",
                "-cq", str(max(crf - 2, 0)),  # HEVC CQ is slightly different
                "-b:v", "0",
                "-pix_fmt", "yuv420p",
                "-tag:v", "hvc1",  # Apple/browser compatibility
            ]
        return device_args + [
            "-c:v", "h264_nvenc",
            "-preset", "p5",
            "-rc", "vbr",
            "-cq", str(crf),
            "-b:v", "0",
            "-pix_fmt", "yuv420p",
        ]
    elif gpu["encoder"] == "h264_vaapi":
        return [
            "-vaapi_device", gpu["hwaccel_device"],
            "-c:v", "h264_vaapi",
            "-qp", str(crf),
            "-pix_fmt", "vaapi",
        ]
    elif gpu["encoder"] == "h264_qsv":
        if use_hevc:
            return [
                "-c:v", "hevc_qsv",
                "-global_quality", str(max(crf - 2, 0)),
                "-preset", "medium",
                "-pix_fmt", "yuv420p",
            ]
        return [
            "-c:v", "h264_qsv",
            "-global_quality", str(crf),
            "-preset", "medium",
            "-pix_fmt", "yuv420p",
        ]
    elif gpu["encoder"] == "h264_videotoolbox":
        # Apple VideoToolbox (M1/M2/M3/M4 and Intel Macs)
        # VideoToolbox uses Apple's Media Engine for hardware H.264/HEVC
        # encoding.  Quality is controlled via -q:v (1-100, higher=better)
        # or -b:v for bitrate mode.  We map CRF roughly to VT quality.
        vt_quality = max(1, min(100, int(100 - (crf * 3))))  # CRF 23 → ~31
        if use_hevc:
            return [
                "-c:v", "hevc_videotoolbox",
                "-q:v", str(vt_quality),
                "-pix_fmt", "yuv420p",
                "-tag:v", "hvc1",  # Browser/Apple compatibility
            ]
        return [
            "-c:v", "h264_videotoolbox",
            "-q:v", str(vt_quality),
            "-pix_fmt", "yuv420p",
        ]
    else:
        return [
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", quality_preset.get("preset", "medium"),
            "-crf", str(quality_preset.get("crf", 23)),
        ]


def _gpu_decode_args() -> list[str]:
    """Return FFmpeg input-side args for hardware-accelerated decoding.

    These args must be placed BEFORE the -i input flag.  When GPU
    acceleration is disabled or no suitable decoder is available,
    returns an empty list (software decode).

    Supported paths:
    - NVIDIA CUDA/CUVID: ``-hwaccel cuda`` (D3D11VA interop on Windows)
    - Intel QSV: ``-hwaccel qsv`` (DXVA2 on Windows, VAAPI on Linux)
    - Apple VideoToolbox: ``-hwaccel videotoolbox`` (macOS M-series & Intel)
    - Windows D3D11VA: ``-hwaccel d3d11va`` (universal Windows fallback)
    - Intel/AMD VAAPI (Linux only): ``-hwaccel vaapi -hwaccel_device /dev/dri/renderD128``

    Note: When using filter chains (subtitles, crop, scale, speed) the
    decoded frames must be downloaded back to system memory for the
    filters to work.  We intentionally omit ``-hwaccel_output_format``
    for the CUDA path when filters are likely, and let FFmpeg handle the
    automatic download.  For simple encode-only paths (no complex
    filters) we keep frames on the GPU for maximum throughput.
    """
    if not app_settings.GPU_ACCELERATION_ENABLED:
        return []
    if not app_settings.GPU_HWDECODE_ENABLED:
        return []

    gpu = detect_gpu_capabilities()

    if gpu["hwaccel"] == "cuda":
        # CUDA hardware decoding — works on both Windows (DXVA2/D3D11VA
        # backed) and Linux.  We omit -hwaccel_output_format here so
        # frames are auto-downloaded to system memory for filter
        # compatibility.  The encode side (_gpu_encode_args) uses NVENC
        # which can accept system memory input efficiently.
        return ["-hwaccel", "cuda"]
    elif gpu["hwaccel"] == "qsv":
        args = ["-hwaccel", "qsv"]
        # On Linux, QSV needs an explicit device path
        if gpu["hwaccel_device"]:
            args += ["-hwaccel_device", gpu["hwaccel_device"]]
        return args
    elif gpu["hwaccel"] == "d3d11va":
        # Windows Direct3D 11 Video Acceleration — works with Intel
        # iGPU and NVIDIA dGPU on Windows for hardware decoding even
        # when no GPU encoder is available.
        return ["-hwaccel", "d3d11va"]
    elif gpu["hwaccel"] == "videotoolbox":
        # macOS VideoToolbox — uses Apple Media Engine on M-series chips
        # or Intel Quick Sync on older Macs.  Decodes H.264, HEVC, VP9,
        # and AV1 (M3+) in hardware.  Frames are automatically returned
        # to system memory for filter compatibility.
        return ["-hwaccel", "videotoolbox"]
    elif gpu["hwaccel"] == "vaapi" and gpu["hwaccel_device"]:
        return ["-hwaccel", "vaapi", "-hwaccel_device", gpu["hwaccel_device"]]

    # On Windows, try D3D11VA as a universal fallback for decoding even
    # if no GPU encoder was detected — all modern Windows GPUs (Intel,
    # NVIDIA, AMD) support DXVA2/D3D11VA for video decoding.
    if _IS_WINDOWS and gpu["vendor"] == "none":
        return ["-hwaccel", "d3d11va"]

    # On macOS, try VideoToolbox as a universal fallback — all Macs have
    # hardware decode support via VideoToolbox.
    if _IS_MACOS and gpu["vendor"] == "none":
        return ["-hwaccel", "videotoolbox"]

    return []


def _gpu_decode_args_for_filter() -> list[str]:
    """Like _gpu_decode_args but ensures frames end up in system memory.

    Used when the FFmpeg command includes filter chains (crop, scale,
    subtitles, speed) that require software-accessible frames.
    Identical to _gpu_decode_args() — both paths already output to
    system memory — but kept as a distinct function for clarity and
    future optimization (e.g. hwdownload insertion for VAAPI).
    """
    return _gpu_decode_args()


async def _validate_export(
    output_path: str,
    expected_duration: float,
    aspect_ratio: str | None,
    subtitles_enabled: bool,
    export_quality: str = "1080p",
) -> None:
    """QA check: verify exported clip is valid and matches expected parameters.

    Hard failures (missing file, empty file, no video stream, unreadable) raise
    RuntimeError.  Soft mismatches (duration, resolution) are logged as warnings.
    """
    if not os.path.exists(output_path):
        raise RuntimeError("Export QA failed: output file does not exist")

    file_size = os.path.getsize(output_path)
    if file_size == 0:
        raise RuntimeError("Export QA failed: output file is empty")

    # Probe the output video
    probe_cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_streams", "-show_format", output_path,
    ]
    proc = await asyncio.create_subprocess_exec(
        *probe_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError("Export QA failed: ffprobe could not read output file")

    probe = json.loads(stdout.decode())

    # Must have at least one video stream
    video_streams = [s for s in probe.get("streams", []) if s.get("codec_type") == "video"]
    if not video_streams:
        raise RuntimeError("Export QA failed: no video stream in output")

    # Duration validation — two-tier check:
    # 1. Warning for >5% or >0.5s drift (soft mismatch, often harmless
    #    keyframe alignment or container overhead).
    # 2. Hard failure for >20% or >5s drift, which indicates a real bug
    #    (e.g. speed not applied, -t truncation, wrong segment math).
    fmt_duration = float(probe.get("format", {}).get("duration", 0))
    dur_diff = abs(fmt_duration - expected_duration)
    dur_pct = (dur_diff / expected_duration * 100) if expected_duration > 0 else 0
    if dur_diff > 5.0 or (expected_duration > 0 and dur_pct > 20):
        raise RuntimeError(
            f"Export QA failed: duration mismatch — expected {expected_duration:.1f}s, "
            f"got {fmt_duration:.1f}s (diff={dur_diff:.1f}s, {dur_pct:.0f}%). "
            f"This likely indicates a speed or trimming bug."
        )
    elif dur_diff > 0.5 or (expected_duration > 0 and dur_pct > 5):
        logger.warning(
            "Export QA: duration drift — expected %.1fs, got %.1fs (diff=%.2fs, %.1f%%)",
            expected_duration, fmt_duration, dur_diff, dur_pct,
        )

    # Resolution check against target aspect ratio and quality
    actual_w = int(video_streams[0].get("width", 0))
    actual_h = int(video_streams[0].get("height", 0))
    if aspect_ratio and aspect_ratio in ASPECT_RATIO_DIMS:
        dims_table = ASPECT_RATIO_DIMS_BY_QUALITY.get(export_quality, ASPECT_RATIO_DIMS)
        expected_w, expected_h = dims_table.get(aspect_ratio, (1920, 1080))
        if actual_w != expected_w or actual_h != expected_h:
            logger.warning(
                "Export QA: resolution mismatch — expected %dx%d, got %dx%d (quality=%s)",
                expected_w, expected_h, actual_w, actual_h, export_quality,
            )
    else:
        # No aspect ratio — verify height matches quality tier
        expected_h = QUALITY_MAX_HEIGHT.get(export_quality, 1080)
        if actual_h != expected_h:
            logger.warning(
                "Export QA: height mismatch — expected %dp, got %dp (quality=%s)",
                expected_h, actual_h, export_quality,
            )

    # When subtitles are burned in, confirm re-encoding happened (not stream copy)
    if subtitles_enabled:
        codec = video_streams[0].get("codec_name", "")
        if codec != "h264":
            logger.warning(
                "Export QA: expected h264 codec for subtitle burn-in, got %s", codec,
            )

    # --- Social-media readiness checks ---

    # Audio stream — most social platforms require audio
    audio_streams = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio_streams:
        logger.warning("Export QA: no audio stream — social platforms may reject this video")

    # File size — conservative limit for social platforms
    MAX_SOCIAL_SIZE_MB = 500  # Twitter=512MB, IG=250MB for Reels
    file_size_mb = file_size / (1024 * 1024)
    if file_size_mb > MAX_SOCIAL_SIZE_MB:
        logger.warning(
            "Export QA: file size %.1fMB exceeds %dMB — may be too large for some platforms",
            file_size_mb, MAX_SOCIAL_SIZE_MB,
        )

    # Pixel format — H.264 yuv420p is universally compatible
    pix_fmt = video_streams[0].get("pix_fmt", "")
    if pix_fmt and pix_fmt != "yuv420p":
        logger.warning(
            "Export QA: pixel format '%s' — yuv420p recommended for social media compatibility",
            pix_fmt,
        )

    logger.info("Export QA passed for %s (%.1fs, %.1fMB, %s, %s)", output_path,
                fmt_duration, file_size_mb,
                video_streams[0].get("codec_name", "unknown"),
                pix_fmt or "unknown")


def _parse_ass_styles(ass_content: str) -> list[dict]:
    """Parse ASS Style lines into a list of dicts keyed by field name."""
    styles = []
    field_names = [
        "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour",
        "OutlineColour", "BackColour", "Bold", "Italic", "Underline", "StrikeOut",
        "ScaleX", "ScaleY", "Spacing", "Angle", "BorderStyle", "Outline",
        "Shadow", "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
    ]
    for line in ass_content.split("\n"):
        if line.startswith("Style:"):
            parts = line[len("Style:"):].strip().split(",")
            if len(parts) >= len(field_names):
                styles.append({k: v.strip() for k, v in zip(field_names, parts)})
    return styles


def _parse_ass_dialogue(ass_content: str) -> list[dict]:
    """Parse ASS Dialogue lines into a list of dicts."""
    events = []
    for line in ass_content.split("\n"):
        if line.startswith("Dialogue:"):
            # Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
            parts = line[len("Dialogue:"):].strip().split(",", 9)
            if len(parts) >= 10:
                events.append({
                    "Layer": parts[0].strip(),
                    "Start": parts[1].strip(),
                    "End": parts[2].strip(),
                    "Style": parts[3].strip(),
                    "Name": parts[4].strip(),
                    "MarginL": parts[5].strip(),
                    "MarginR": parts[6].strip(),
                    "MarginV": parts[7].strip(),
                    "Effect": parts[8].strip(),
                    "Text": parts[9],
                })
    return events


def _validate_ass_settings(
    ass_content: str,
    settings: dict,
    video_width: int,
    video_height: int,
) -> list[str]:
    """Validate that ASS subtitle content accurately reflects the input settings.

    Cross-checks every style property in the generated ASS against the expected
    values computed from the input settings dict.  This ensures the exported
    video's subtitles will match what the frontend preview displayed.

    Returns a list of mismatch descriptions.  Empty list = all checks passed.
    Raises RuntimeError for structural failures (no styles, no events).
    """
    warnings: list[str] = []

    # --- Parse ASS structure ---
    styles = _parse_ass_styles(ass_content)
    events = _parse_ass_dialogue(ass_content)

    if not styles:
        raise RuntimeError("ASS QA failed: no styles found in generated ASS")
    if not events:
        raise RuntimeError("ASS QA failed: no dialogue events found in generated ASS")

    # --- Recompute expected values from settings (mirrors ass_generator logic) ---
    font = settings.get("font", "DM Sans")
    font_size = settings.get("size", "medium")
    font_weight = settings.get("font_weight", "bold")
    font_color = settings.get("font_color", "#FFFFFF")
    position = settings.get("position", "bottom")
    background_enabled = settings.get("background_enabled", False)
    background_color = settings.get("background_color", "#000000")
    background_opacity = settings.get("background_opacity", 75)
    outline_color = settings.get("outline_color", "#000000")
    outline_opacity = settings.get("outline_opacity", 100)
    outline_width = max(0, min(10, settings.get("outline_width", 2)))
    show_speaker_labels = settings.get("show_speaker_labels", False)
    max_width_pct = max(20, min(100, settings.get("max_width", 90)))
    offset_v_pct = max(0, min(100, settings.get("offset_v", 4)))
    max_words = settings.get("max_words", 0)
    active_word_enabled = settings.get("active_word_enabled", False)
    active_word_color = settings.get("active_word_color", "#FFD700")
    active_word_outline_color = settings.get("active_word_outline_color", "#000000")

    font_scale = min(video_width, video_height) / min(ASS_REF_W, ASS_REF_H)
    # Handle both numeric (12-72) and string ("small"/"medium"/"large") sizes
    # — must mirror generate_ass() logic (ass_generator.py:197-200)
    if isinstance(font_size, (int, float)):
        base_size_px = int(font_size)
    else:
        base_size_px = ASS_FONT_SIZE_MAP.get(font_size, 30)
    # Must match generate_ass() — no compensation factor, just base * scale.
    # Use round() to match frontend Math.round() and generate_ass().
    expected_font_size = max(16, round(base_size_px * font_scale))
    expected_bold = ASS_FONT_WEIGHT_MAP.get(font_weight, 0)
    expected_alignment = 2  # Always bottom-center for absolute vertical positioning
    scaled_outline_width = max(0, round(outline_width * font_scale)) if outline_width > 0 else 0

    # Expected margins
    expected_margin_h = max(20, int(video_width * (100 - max_width_pct) / 100 / 2))
    max_margin_h = int(video_width * (1 - MIN_TEXT_AREA_W) / 2)
    expected_margin_h = min(expected_margin_h, max_margin_h)

    expected_margin_v = int(video_height * offset_v_pct / 100)

    # Expected outline/background style values
    if background_enabled:
        expected_border_style = 3
        expected_outline_colour = _hex_to_ass_color_with_alpha(background_color, background_opacity)
        expected_back_colour = "&HFF000000&"  # fully transparent — matches ass_generator fix
        expected_ol_width = max(int(4 * font_scale), 2)
        expected_shadow = 0
    else:
        expected_border_style = 1
        expected_outline_colour = _hex_to_ass_color_with_alpha(outline_color, outline_opacity)
        expected_ol_width = scaled_outline_width
        # With two-layer architecture, shadow is rendered correctly on
        # Layer 0 (uniform color → continuous shadow, no per-word boxes).
        expected_shadow = max(1, min(4, round(scaled_outline_width * 0.75))) if scaled_outline_width > 0 else 0

    # --- 1. PlayRes dimensions ---
    playres_x = re.search(r"PlayResX:\s*(\d+)", ass_content)
    playres_y = re.search(r"PlayResY:\s*(\d+)", ass_content)
    if playres_x and int(playres_x.group(1)) != video_width:
        warnings.append(f"PlayResX mismatch: expected {video_width}, got {playres_x.group(1)}")
    if playres_y and int(playres_y.group(1)) != video_height:
        warnings.append(f"PlayResY mismatch: expected {video_height}, got {playres_y.group(1)}")

    # --- Validate each style ---
    for style in styles:
        style_name = style["Name"]

        # 2. Font name
        if style["Fontname"] != font:
            warnings.append(f"Style '{style_name}': font mismatch — expected '{font}', got '{style['Fontname']}'")

        # 3. Font size
        actual_size = int(style["Fontsize"])
        if actual_size != expected_font_size:
            warnings.append(f"Style '{style_name}': font size mismatch — expected {expected_font_size}, got {actual_size}")

        # 4. Bold flag
        actual_bold = int(style["Bold"])
        if actual_bold != expected_bold:
            warnings.append(f"Style '{style_name}': bold mismatch — expected {expected_bold}, got {actual_bold}")

        # 4b. Primary font color (only when speaker colors are off — otherwise
        #     each speaker style intentionally has a different PrimaryColour)
        if not settings.get("use_speaker_colors", True):
            expected_primary = _hex_to_ass_color(font_color)
            if style["PrimaryColour"].upper() != expected_primary.upper():
                warnings.append(
                    f"Style '{style_name}': PrimaryColour mismatch — "
                    f"expected {expected_primary}, got {style['PrimaryColour']}"
                )

        # 4c. Speaker colors from override dict — when speaker colors are on
        #     and a specific color was provided for this speaker, validate it.
        if settings.get("use_speaker_colors", True):
            speaker_colors_dict = settings.get("speaker_colors", {})
            if style_name in speaker_colors_dict:
                expected_speaker_color = _hex_to_ass_color(speaker_colors_dict[style_name])
                if style["PrimaryColour"].upper() != expected_speaker_color.upper():
                    warnings.append(
                        f"Style '{style_name}': speaker color mismatch — "
                        f"expected {expected_speaker_color}, got {style['PrimaryColour']}"
                    )

        # 5. Outline color
        if style["OutlineColour"].upper() != expected_outline_colour.upper():
            warnings.append(
                f"Style '{style_name}': OutlineColour mismatch — "
                f"expected {expected_outline_colour}, got {style['OutlineColour']}"
            )

        # 6. BorderStyle
        actual_border = int(style["BorderStyle"])
        if actual_border != expected_border_style:
            warnings.append(
                f"Style '{style_name}': BorderStyle mismatch — "
                f"expected {expected_border_style}, got {actual_border}"
            )

        # 7. Outline width (box padding when background enabled)
        actual_ol = int(style["Outline"])
        if actual_ol != expected_ol_width:
            warnings.append(
                f"Style '{style_name}': Outline width mismatch — "
                f"expected {expected_ol_width}, got {actual_ol}"
            )

        # 8. Shadow
        actual_shadow = int(style["Shadow"])
        if actual_shadow != expected_shadow:
            warnings.append(
                f"Style '{style_name}': Shadow mismatch — "
                f"expected {expected_shadow}, got {actual_shadow}"
            )

        # 9. Alignment
        actual_align = int(style["Alignment"])
        if actual_align != expected_alignment:
            warnings.append(
                f"Style '{style_name}': Alignment mismatch — "
                f"expected {expected_alignment}, got {actual_align}"
            )

        # 10. Margins
        actual_ml = int(style["MarginL"])
        actual_mr = int(style["MarginR"])
        actual_mv = int(style["MarginV"])
        if actual_ml != expected_margin_h:
            warnings.append(
                f"Style '{style_name}': MarginL mismatch — "
                f"expected {expected_margin_h}, got {actual_ml}"
            )
        if actual_mr != expected_margin_h:
            warnings.append(
                f"Style '{style_name}': MarginR mismatch — "
                f"expected {expected_margin_h}, got {actual_mr}"
            )
        if actual_mv != expected_margin_v:
            warnings.append(
                f"Style '{style_name}': MarginV mismatch — "
                f"expected {expected_margin_v}, got {actual_mv}"
            )

        # 11. BackColour (when background enabled)
        if background_enabled:
            if style["BackColour"].upper() != expected_back_colour.upper():
                warnings.append(
                    f"Style '{style_name}': BackColour mismatch — "
                    f"expected {expected_back_colour}, got {style['BackColour']}"
                )

    # --- Validate dialogue events ---

    # 12. Speaker labels
    for ev in events:
        text = ev["Text"]
        # Strip inline override tags for content analysis
        plain = re.sub(r"\{[^}]*\}", "", text)
        has_label = re.match(r"^.+:\s", plain)
        if show_speaker_labels and not has_label:
            warnings.append(
                f"Speaker label missing in dialogue but show_speaker_labels=True: '{plain[:60]}'"
            )
            break  # One warning is enough
        if not show_speaker_labels and has_label:
            # Only flag if no active word (active word events don't have labels in the plain text path)
            if not active_word_enabled:
                warnings.append(
                    f"Speaker label present in dialogue but show_speaker_labels=False: '{plain[:60]}'"
                )
                break

    # 13. Active word override tags
    has_override_tags = any("\\c" in ev["Text"] for ev in events)
    if active_word_enabled and not has_override_tags:
        warnings.append("active_word_enabled=True but no inline color override tags found in events")
    if not active_word_enabled and has_override_tags:
        warnings.append("active_word_enabled=False but inline color override tags found in events")

    # 14. Active word colors (spot-check)
    if active_word_enabled and has_override_tags:
        expected_aw_color = _hex_to_ass_color(active_word_color)
        # Check that at least one event contains the expected active word color
        aw_color_found = any(expected_aw_color.upper() in ev["Text"].upper() for ev in events)
        if not aw_color_found:
            warnings.append(
                f"Active word color {expected_aw_color} not found in any dialogue event"
            )
        # Active word outline: with the minimal-tag approach, \3c is set
        # once in the bord_tag prefix (not per-word).  Verify the outline
        # color appears in the event prefix, not as per-word inline tags.
        if not background_enabled:
            expected_outline_in_prefix = _hex_to_ass_color_with_alpha(
                settings.get("outline_color", "#000000"),
                settings.get("outline_opacity", 100),
            )
            outline_in_prefix = any(
                expected_outline_in_prefix.upper() in ev["Text"].upper()
                for ev in events
            )
            if not outline_in_prefix:
                warnings.append(
                    f"Active word outline color {expected_outline_in_prefix} "
                    f"not found in any dialogue event prefix"
                )

    # 14aa. Per-word \3c/\bord/\shad conflict detection for active word mode.
    # When active word highlighting is enabled, only \c (text color) should
    # be used per-word.  Per-word \3c/\bord/\shad tags cause libass to
    # render each word as a separate segment with an independent shadow box,
    # producing visible "black bars" around words.  This applies to ALL
    # BorderStyles, not just BorderStyle=3.
    if active_word_enabled and has_override_tags:
        # Count events where \3c appears MORE than once (the bord_tag prefix
        # is allowed to set \3c once — multiple \3c means per-word overrides).
        events_with_multi_3c = sum(
            1 for ev in events if ev["Text"].count("\\3c") > 1
        )
        if events_with_multi_3c > 0:
            warnings.append(
                f"Per-word \\3c overrides detected in {events_with_multi_3c} events — "
                "this causes libass to render separate shadow boxes per word "
                "(black bars). Only \\c should vary per word."
            )
        events_with_multi_bord = sum(
            1 for ev in events if ev["Text"].count("\\bord") > 1
        )
        if events_with_multi_bord > 0:
            warnings.append(
                f"Per-word \\bord overrides detected in {events_with_multi_bord} events — "
                "this causes per-word shadow box rendering (black bars)"
            )
        events_with_multi_shad = sum(
            1 for ev in events if ev["Text"].count("\\shad") > 1
        )
        if events_with_multi_shad > 0:
            warnings.append(
                f"Per-word \\shad overrides detected in {events_with_multi_shad} events — "
                "this causes per-word shadow box rendering (black bars)"
            )

    # 14ab. Two-layer architecture validation for active word mode.
    # Layer 0 = border layer (uniform color, continuous outline/shadow)
    # Layer 1 = color layer (per-word \c overrides, \bord0\shad0)
    if active_word_enabled and events:
        layer_0_events = [ev for ev in events if ev["Layer"] == "0"]
        layer_1_events = [ev for ev in events if ev["Layer"] == "1"]

        if not layer_0_events:
            warnings.append(
                "Active word mode: no Layer 0 (border) events found — "
                "export will be missing continuous outline/shadow"
            )
        if not layer_1_events:
            warnings.append(
                "Active word mode: no Layer 1 (color) events found — "
                "export will be missing per-word color highlighting"
            )

        # Layer 0 events must NOT contain \c overrides (would break seamless border)
        for ev in layer_0_events:
            text_after_bord = ev["Text"].split("}", 1)[-1] if "}" in ev["Text"] else ev["Text"]
            if "\\c&H" in text_after_bord or "\\c" in text_after_bord.replace("\\3c", ""):
                warnings.append(
                    "Layer 0 (border) event contains \\c color overrides — "
                    "this WILL cause per-word border segmentation (black bars). "
                    "Layer 0 must use uniform color only."
                )
                break

        # Layer 1 events must have \bord0\shad0 (no border on color layer)
        for ev in layer_1_events:
            if "\\bord0" not in ev["Text"]:
                warnings.append(
                    "Layer 1 (color) event missing \\bord0 — "
                    "will render duplicate borders causing black bars"
                )
                break
            if "\\shad0" not in ev["Text"]:
                warnings.append(
                    "Layer 1 (color) event missing \\shad0 — "
                    "will render duplicate shadows causing artifacts"
                )
                break

        # CRITICAL: detect events with \bord>0 AND multiple \c overrides
        # (the exact anti-pattern that causes black bars)
        if active_word_enabled:
            bad_events = 0
            for ev in events:
                has_border = "\\bord" in ev["Text"] and "\\bord0" not in ev["Text"]
                color_changes = ev["Text"].count("\\c&H")
                if has_border and color_changes > 1:
                    bad_events += 1
            if bad_events > 0:
                warnings.append(
                    f"CRITICAL: {bad_events} events have \\bord>0 WITH multiple \\c color "
                    f"overrides — this causes libass per-word border segmentation (black bars). "
                    f"Must use two-layer architecture: Layer 0 = border only (no \\c), "
                    f"Layer 1 = color only (\\bord0)."
                )

    # 14b. Active word background color (\4c)
    # With BorderStyle=3, \4c sets BackColour which causes shadow artifacts
    # even with Shadow=0 — it must NEVER appear when background is enabled.
    # With BorderStyle=1, \4c is only valid when aw_bg_opacity > 0.
    aw_bg_opacity = settings.get("active_word_bg_opacity", 0)
    if active_word_enabled and has_override_tags:
        if background_enabled:
            has_4c = any("\\4c" in ev["Text"] for ev in events)
            if has_4c:
                warnings.append(
                    "BorderStyle=3 (background) + inline \\4c tags detected — "
                    "\\4c sets BackColour causing shadow artifacts even with "
                    "Shadow=0 (black bars around active word)"
                )
        elif aw_bg_opacity > 0:
            aw_bg_color = settings.get("active_word_bg_color", "#000000")
            expected_aw_bg = _hex_to_ass_color_with_alpha(aw_bg_color, aw_bg_opacity)
            aw_bg_found = any(expected_aw_bg.upper() in ev["Text"].upper() for ev in events)
            if not aw_bg_found:
                warnings.append(
                    f"Active word background color {expected_aw_bg} not found in any dialogue event"
                )

    # 14c. Verify no \4c tags when active word bg_opacity is 0 (and no background)
    if active_word_enabled and not background_enabled and aw_bg_opacity == 0 and has_override_tags:
        has_4c = any("\\4c" in ev["Text"] for ev in events)
        if has_4c:
            warnings.append("active_word bg_opacity=0 but \\4c tags found in dialogue events")

    # 15. Max words
    if max_words > 0:
        for ev in events:
            text = ev["Text"]
            plain = re.sub(r"\{[^}]*\}", "", text)
            # Strip speaker label prefix if present
            if show_speaker_labels:
                plain = re.sub(r"^.+?:\s", "", plain, count=1)
            words = plain.split()
            if len(words) > max_words:
                warnings.append(
                    f"Dialogue exceeds max_words={max_words}: "
                    f"'{plain[:60]}' has {len(words)} words"
                )
                break

    # 16. Font availability — verify fontconfig can actually resolve the font
    #     so FFmpeg/libass won't silently fall back to a different font.
    try:
        result = subprocess.run(
            ["fc-match", "--format", "%{family}", font],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            matched_family = result.stdout.strip().split(",")[0].strip()
            if matched_family.lower() != font.lower():
                warnings.append(
                    f"Font '{font}' not installed — fontconfig resolved to "
                    f"'{matched_family}' instead (exported video will use wrong font)"
                )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        warnings.append(f"Could not verify font availability for '{font}' (fc-match unavailable)")

    # 17. Temporal overlap — overlapping Dialogue events with the same layer
    #     cause libass to render both simultaneously, stacking them vertically
    #     (the "bouncing subtitle" bug).
    def _ass_ts_to_secs(ts: str) -> float:
        """Parse ASS timestamp H:MM:SS.cc to seconds."""
        parts = ts.split(":")
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        return 0.0

    overlap_count = 0
    if len(events) > 1:
        # Group events by layer — cross-layer overlaps are intentional
        # (the 2-layer active-word architecture has Layer 0 base text and
        # Layer 1 per-word highlights that overlap in time by design).
        layers: dict[str, list] = {}
        for ev in events:
            layer = ev.get("Layer", "0")
            layers.setdefault(layer, []).append(ev)

        for layer_events in layers.values():
            parsed = [
                (ev, _ass_ts_to_secs(ev["Start"]), _ass_ts_to_secs(ev["End"]))
                for ev in layer_events
            ]
            parsed.sort(key=lambda x: x[1])
            for i in range(len(parsed) - 1):
                _, _, end_a = parsed[i]
                _, start_b, _ = parsed[i + 1]
                if end_a > start_b + 0.005:  # tolerance for centisecond rounding
                    overlap_count += 1
    if overlap_count > 0:
        warnings.append(
            f"Temporal overlap detected in {overlap_count} event pair(s) — "
            f"overlapping events cause subtitle stacking/bouncing"
        )

    if warnings:
        logger.warning("ASS QA found %d issue(s) for %dx%d output", len(warnings), video_width, video_height)
    else:
        logger.info("ASS QA passed: all %d styles and %d events verified", len(styles), len(events))

    return warnings


def _validate_subject_tracking(
    filter_chain: str | None,
    aspect_ratio: str | None,
    src_w: int,
    src_h: int,
    subject_x: int,
    subject_keyframes: list[tuple[float, int]] | None,
) -> list[str]:
    """Validate that subject tracking is correctly applied in the FFmpeg filter chain.

    Cross-checks the crop filter in the filter chain against the expected
    behaviour given the aspect ratio, source dimensions, and subject data.

    Returns a list of issue descriptions.  Empty list = all checks passed.
    """
    warnings: list[str] = []

    has_aspect = aspect_ratio and aspect_ratio in ASPECT_RATIO_VALUES
    has_dynamic = (
        subject_keyframes
        and len(subject_keyframes) > 1
        and len(set(kf[1] for kf in subject_keyframes)) > 1
    )
    has_static_kf = subject_keyframes and not has_dynamic

    if not has_aspect:
        # No aspect ratio → no crop → no subject tracking to validate
        if filter_chain and "crop=" in filter_chain:
            warnings.append("crop filter present but no aspect ratio specified")
        return warnings

    # Compute expected crop dimensions
    target_ratio = ASPECT_RATIO_VALUES[aspect_ratio]
    src_ratio = src_w / src_h if src_h else 1

    if abs(src_ratio - target_ratio) <= 0.01:
        # Same aspect ratio → no crop needed, skip validation
        return warnings

    if not filter_chain:
        warnings.append(f"aspect_ratio={aspect_ratio} but no filter chain produced")
        return warnings

    # Verify crop filter exists
    if "crop=" not in filter_chain:
        warnings.append(f"aspect_ratio={aspect_ratio} but no crop filter in chain")
        return warnings

    if target_ratio < src_ratio:
        crop_h = src_h
        crop_w = int(src_h * target_ratio)
    else:
        crop_w = src_w
        crop_h = int(src_w / target_ratio)
    crop_w = crop_w - (crop_w % 2)
    crop_h = crop_h - (crop_h % 2)
    max_x_offset = src_w - crop_w

    # Parse the crop filter from the chain.
    # For dynamic expressions, the x parameter can contain nested if()/clip()
    # with escaped commas (\,), so we can't use a simple split.
    # Strategy: match crop=W:H: then grab everything until the last :Y before
    # the next comma-separated filter or end of string.
    crop_match = re.search(r"crop=(\d+):(\d+):(.+)", filter_chain)
    if not crop_match:
        warnings.append("Could not parse crop filter parameters from filter chain")
        return warnings

    actual_crop_w = int(crop_match.group(1))
    actual_crop_h = int(crop_match.group(2))
    remainder = crop_match.group(3)

    # For static crops: "123:0,scale=..." → x_param="123", y from "0"
    # For dynamic crops: "clip(if(...)\\,0\\,1314):0,scale=..." → x_param="clip(...)", y from "0"
    # Split on the LAST unescaped colon before the y-offset
    # The y-offset is always a plain integer followed by comma or end-of-string
    y_match = re.search(r":(\d+)(?:,|$)", remainder)
    if y_match:
        actual_y = int(y_match.group(1))
        x_param = remainder[:y_match.start()]
    else:
        # Fallback: try simple static parse
        static_match = re.match(r"(\d+):(\d+)", remainder)
        if static_match:
            x_param = static_match.group(1)
            actual_y = int(static_match.group(2))
        else:
            warnings.append("Could not parse crop x/y parameters from filter chain")
            return warnings

    # Validate crop dimensions
    if actual_crop_w != crop_w:
        warnings.append(
            f"crop width mismatch: expected {crop_w}, got {actual_crop_w}"
        )
    if actual_crop_h != crop_h:
        warnings.append(
            f"crop height mismatch: expected {crop_h}, got {actual_crop_h}"
        )

    # Validate subject tracking type (dynamic vs static)
    is_dynamic_expr = "if(lt(t" in x_param or "clip(" in x_param

    if has_dynamic:
        # Expect dynamic expression
        if not is_dynamic_expr:
            warnings.append(
                f"Dynamic keyframes provided ({len(subject_keyframes)} kfs, "
                f"{len(set(kf[1] for kf in subject_keyframes))} unique) "
                f"but crop uses static x={x_param}"
            )
        else:
            # Validate the expression is clipped to max_offset
            if f"\\,{max_x_offset})" in x_param or f",{max_x_offset})" in x_param:
                pass  # Good
            elif f"\\,0\\,{max_x_offset}" in x_param:
                pass  # clip(expr, 0, max_offset) format
            else:
                # Try to find max_offset in expression
                if str(max_x_offset) not in x_param:
                    warnings.append(
                        f"Dynamic crop expression doesn't reference max_offset={max_x_offset}"
                    )
    else:
        # Expect static offset
        if is_dynamic_expr:
            warnings.append(
                "Static subject tracking expected but dynamic expression found in crop"
            )
        else:
            # Validate the static offset is correctly computed
            try:
                actual_x = int(x_param)
            except ValueError:
                warnings.append(f"Expected static integer x offset, got '{x_param}'")
                return warnings

            # Compute expected offset
            if has_static_kf:
                sx = _safe_subject_x(subject_keyframes[0][1])
            else:
                sx = _safe_subject_x(subject_x)
            expected_x = _center_crop_offset(sx, src_w, crop_w)

            if actual_x != expected_x:
                warnings.append(
                    f"Static crop x offset mismatch: expected {expected_x} "
                    f"(from subject_x={sx}), got {actual_x}"
                )

    # Validate subject is actually centered — for static crops, verify the
    # subject pixel position falls within the crop window
    if not is_dynamic_expr:
        try:
            actual_x = int(x_param)
            if has_static_kf:
                sx = _safe_subject_x(subject_keyframes[0][1])
            else:
                sx = _safe_subject_x(subject_x)
            subject_pixel = src_w * sx / 100
            crop_left = actual_x
            crop_right = actual_x + crop_w
            if subject_pixel < crop_left or subject_pixel > crop_right:
                warnings.append(
                    f"Subject at pixel {subject_pixel:.0f} is outside crop window "
                    f"[{crop_left}, {crop_right}]"
                )
            elif actual_x > 0 and actual_x < max_x_offset:
                # Only check centering when the crop isn't edge-clamped.
                # At the frame edges, perfect centering is impossible.
                crop_center = crop_left + crop_w / 2
                center_offset_pct = abs(subject_pixel - crop_center) / crop_w * 100
                if center_offset_pct > 10:
                    warnings.append(
                        f"Subject/face at pixel {subject_pixel:.0f} is {center_offset_pct:.0f}% "
                        f"off-center in crop window [{crop_left}, {crop_right}] "
                        f"(target: <10% for face centering)"
                    )
        except ValueError:
            pass  # Already reported above

    if warnings:
        logger.warning(
            "Subject tracking QA found %d issue(s) for %s crop (%dx%d → %dx%d)",
            len(warnings), "dynamic" if has_dynamic else "static",
            src_w, src_h, crop_w, crop_h,
        )
    else:
        logger.info(
            "Subject tracking QA passed: %s crop verified for %s (%dx%d → %dx%d)",
            "dynamic" if has_dynamic else "static",
            aspect_ratio, src_w, src_h, crop_w, crop_h,
        )

    return warnings


def _verify_centering_math(
    clip_id: int | str,
    aspect_ratio: str,
    src_w: int,
    src_h: int,
    subject_x: int,
    subject_keyframes: list[tuple[float, int]] | None,
) -> None:
    """Log detailed centering verification for every keyframe (or static value).

    For each subject_x value, compute:
    - The pixel position of the subject in the source frame
    - The crop window offset
    - The pixel position of the subject within the crop (should be center)
    - The centering error in pixels and as a percentage of crop width

    This runs during every export and logs at INFO level so the container
    logs always show exactly how well subjects are centered.
    """
    target_ratio = ASPECT_RATIO_VALUES.get(aspect_ratio)
    if not target_ratio:
        return

    src_ratio = src_w / src_h if src_h else 1
    if abs(src_ratio - target_ratio) <= 0.01:
        return

    # Compute crop dimensions
    if target_ratio < src_ratio:
        crop_h = src_h
        crop_w = int(src_h * target_ratio)
    else:
        crop_w = src_w
        crop_h = int(src_w / target_ratio)
    crop_w = crop_w - (crop_w % 2)
    crop_h = crop_h - (crop_h % 2)

    def _check_sx(sx_val: int, label: str) -> None:
        sx_safe = _safe_subject_x(sx_val)
        subject_pixel = src_w * sx_safe / 100
        x_offset = _center_crop_offset(sx_safe, src_w, crop_w)
        # Where the subject lands within the crop window
        subject_in_crop = subject_pixel - x_offset
        crop_center = crop_w / 2
        error_px = abs(subject_in_crop - crop_center)
        error_pct = error_px / crop_w * 100 if crop_w > 0 else 0

        is_edge_clamped = x_offset == 0 or x_offset == (src_w - crop_w)
        if error_pct < 1.0:
            status = "FACE-CENTERED"
        elif error_pct < 5.0:
            status = "NEAR-CENTER"
        elif is_edge_clamped:
            status = "EDGE-CLAMPED"
        else:
            status = "OFF-CENTER"

        logger.info(
            "[SubjectTracking] VERIFY %s clip %s: sx=%d → safe_sx=%d, "
            "subject@%.0fpx, crop_offset=%d, subject_in_crop=%.0f/%.0f (center=%.0f), "
            "error=%.1fpx (%.2f%%) → %s",
            label, clip_id, sx_val, sx_safe,
            subject_pixel, x_offset, subject_in_crop, crop_w, crop_center,
            error_px, error_pct, status,
        )

    if subject_keyframes and len(subject_keyframes) > 1:
        unique_sx = set(kf[1] for kf in subject_keyframes)
        if len(unique_sx) > 1:
            for i, (t, sx) in enumerate(subject_keyframes):
                _check_sx(sx, f"kf[{i}] t={t:.2f}s")
            return

    # Static — verify the single value
    sx_val = subject_keyframes[0][1] if subject_keyframes else subject_x
    _check_sx(sx_val, "static")

    # Also verify the frontend-equivalent objectPosition math
    R = src_ratio / target_ratio
    if R > 1.01:
        sx_safe = _safe_subject_x(sx_val)
        center_pct = (R * sx_safe - 50) / (R - 1)
        center_pct = max(0, min(100, center_pct))
        logger.info(
            "[SubjectTracking] VERIFY frontend-equivalent clip %s: "
            "R=%.3f, sx=%d → objectPosition=%.2f%% (50%%=perfect center)",
            clip_id, R, sx_safe, center_pct,
        )

    logger.info(
        "═══════════════════════════════════════════════════════════════════════════",
    )


# ---------------------------------------------------------------------------
# Export quality presets
# ---------------------------------------------------------------------------

QUALITY_PRESETS = {
    "720p":  {"crf": 20, "preset": "medium"},
    "1080p": {"crf": 18, "preset": "medium"},
    "4k":    {"crf": 18, "preset": "medium"},
}

# Standard output resolutions by aspect ratio, keyed by quality tier
ASPECT_RATIO_DIMS_BY_QUALITY = {
    "720p": {
        "16:9": (1280, 720),
        "9:16": (720, 1280),
        "1:1":  (720, 720),
        "4:5":  (720, 900),
    },
    "1080p": {
        "16:9": (1920, 1080),
        "9:16": (1080, 1920),
        "1:1":  (1080, 1080),
        "4:5":  (1080, 1350),
    },
    "4k": {
        "16:9": (3840, 2160),
        "9:16": (2160, 3840),
        "1:1":  (2160, 2160),
        "4:5":  (2160, 2700),
    },
}

# Default (1080p) — used when no quality specified
ASPECT_RATIO_DIMS = ASPECT_RATIO_DIMS_BY_QUALITY["1080p"]

# Max output height per quality tier (for scaling without aspect ratio change)
QUALITY_MAX_HEIGHT = {
    "720p": 720,
    "1080p": 1080,
    "4k": 2160,
}

ASPECT_RATIO_VALUES = {
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "1:1": 1.0,
    "4:5": 4 / 5,
}

def _compute_safe_range(src_ratio: float, target_ratio: float, edge_buffer: int = 5) -> tuple[int, int]:
    """Compute safe subject_x range for a given aspect ratio conversion.

    Ensures that any subject_x within this range will produce a non-clamped
    objectPosition value — meaning the subject can actually be centered.

    Matches frontend computeSafeRange() exactly for preview-export parity.
    """
    R = src_ratio / target_ratio
    if R <= 1.01:
        return (5, 95)
    sx_at_min = (edge_buffer * (R - 1) + 50) / R
    sx_at_max = ((100 - edge_buffer) * (R - 1) + 50) / R
    return (
        max(5, math.ceil(sx_at_min)),
        min(95, math.floor(sx_at_max)),
    )


def _safe_subject_x(sx: int, margin: int = 10, src_ratio: float = 0, target_ratio: float = 0) -> int:
    """Clamp subject_x to safe range, dynamically if aspect ratios provided.

    When src_ratio and target_ratio are provided, computes the safe range
    based on the actual aspect ratio conversion. Otherwise falls back to
    static margin.

    Matches frontend safeSubjectX() exactly for preview-export parity.
    """
    if src_ratio > 0 and target_ratio > 0:
        lo, hi = _compute_safe_range(src_ratio, target_ratio)
        return max(lo, min(hi, round(sx)))
    return max(margin, min(100 - margin, round(sx)))


def _center_crop_offset(sx: int, src_w: int, crop_w: int) -> int:
    """Compute horizontal crop offset that centers the subject in the output.

    Places the crop window so that the subject (at sx% of src_w) ends up
    at the center of the cropped frame.

    Args:
        sx: Subject x position as 0-100 percentage of source width.
        src_w: Source video width in pixels.
        crop_w: Crop window width in pixels.

    Returns:
        Clamped pixel offset for the crop x parameter.
    """
    subject_pixel = src_w * sx / 100
    x_offset = round(subject_pixel - crop_w / 2)
    max_offset = src_w - crop_w
    return max(0, min(max_offset, x_offset))


def _build_subject_keyframes(
    scenes: list,
    clip_start: float,
    clip_end: float,
    src_ratio: float = 0,
    target_ratio: float = 0,
) -> list[tuple[float, int]]:
    """Build sorted (relative_time, subject_x) keyframes from scenes for a clip.

    Accepts scenes both within and outside the clip range.  Scenes outside
    the clip boundaries are used to interpolate accurate subject_x values
    at the clip start/end rather than falling back to center (50).  This
    ensures short clips between scene timestamps still get proper tracking.

    When src_ratio and target_ratio are provided, uses dynamic safe margin
    based on the aspect ratio conversion instead of the static margin.

    Returns at least one keyframe.  If no scenes are provided, returns [(0.0, 50)].
    """
    clip_dur = max(0.0, clip_end - clip_start)

    # Extract and sort all scene data (including scenes outside clip range)
    all_data = []
    for s in scenes:
        ts = float(s.timestamp if hasattr(s, "timestamp") else s.get("timestamp", 0))
        sx = s.subject_x if hasattr(s, "subject_x") else s.get("subject_x", 50)
        raw_sx = int(sx)
        safe_sx = _safe_subject_x(raw_sx, src_ratio=src_ratio, target_ratio=target_ratio)
        all_data.append((ts, safe_sx))

    if not all_data:
        logger.info("[SubjectTracking] _build_subject_keyframes: no scene data — returning default center (50)")
        return [(0.0, 50)]

    all_data.sort(key=lambda k: k[0])

    logger.info(
        "[SubjectTracking] _build_subject_keyframes: clip=%.1f-%.1f (%.1fs), %d scenes, "
        "timestamps=[%.1f..%.1f], subject_x values=%s",
        clip_start, clip_end, clip_dur, len(all_data),
        all_data[0][0], all_data[-1][0],
        [sx for _, sx in all_data],
    )

    # Separate into before, within, and after clip boundaries
    before = [(ts, sx) for ts, sx in all_data if ts < clip_start]
    within = [(ts, sx) for ts, sx in all_data if clip_start <= ts <= clip_end]
    after = [(ts, sx) for ts, sx in all_data if ts > clip_end]

    logger.info(
        "[SubjectTracking] _build_subject_keyframes: %d before, %d within, %d after clip range",
        len(before), len(within), len(after),
    )

    # Build keyframes from within-range scenes (convert to relative time)
    raw = [(round(ts - clip_start, 3), sx) for ts, sx in within]

    def _interp(t_abs, s1, s2):
        """Linearly interpolate subject_x at absolute time t between two scenes."""
        t1, sx1 = s1
        t2, sx2 = s2
        dt = t2 - t1
        if dt <= 0:
            return sx1
        frac = min(1.0, max(0.0, (t_abs - t1) / dt))
        result = _safe_subject_x(int(round(sx1 + (sx2 - sx1) * frac)), src_ratio=src_ratio, target_ratio=target_ratio)
        logger.debug(
            "[SubjectTracking] interpolate t=%.2f between (%.1f,sx=%d) and (%.1f,sx=%d): frac=%.3f → sx=%d",
            t_abs, t1, sx1, t2, sx2, frac, result,
        )
        return result

    # Compute accurate boundary value at t=0 (clip_start)
    if not raw or raw[0][0] > 0.0:
        if before and within:
            sx0 = _interp(clip_start, before[-1], within[0])
            logger.info("[SubjectTracking] boundary t=0: interpolated from before→within, sx=%d", sx0)
        elif before and after and not within:
            sx0 = _interp(clip_start, before[-1], after[0])
            logger.info("[SubjectTracking] boundary t=0: interpolated from before→after (no within), sx=%d", sx0)
        elif before:
            sx0 = before[-1][1]
            logger.info("[SubjectTracking] boundary t=0: using last before scene, sx=%d", sx0)
        elif within:
            sx0 = within[0][1]
            logger.info("[SubjectTracking] boundary t=0: using first within scene, sx=%d", sx0)
        elif after:
            sx0 = after[0][1]
            logger.info("[SubjectTracking] boundary t=0: using first after scene, sx=%d", sx0)
        else:
            sx0 = 50
            logger.info("[SubjectTracking] boundary t=0: no scenes available, using default center (50)")
        raw.insert(0, (0.0, sx0))

    # Compute accurate boundary value at t=clip_dur (clip_end)
    if clip_dur > 0 and (not raw or raw[-1][0] < clip_dur):
        if after and within:
            sx_end = _interp(clip_end, within[-1], after[0])
            logger.info("[SubjectTracking] boundary t=%.1f: interpolated from within→after, sx=%d", clip_dur, sx_end)
        elif before and after and not within:
            sx_end = _interp(clip_end, before[-1], after[0])
            logger.info("[SubjectTracking] boundary t=%.1f: interpolated from before→after (no within), sx=%d", clip_dur, sx_end)
        elif after:
            sx_end = after[0][1]
            logger.info("[SubjectTracking] boundary t=%.1f: using first after scene, sx=%d", clip_dur, sx_end)
        elif within:
            sx_end = within[-1][1]
            logger.info("[SubjectTracking] boundary t=%.1f: using last within scene, sx=%d", clip_dur, sx_end)
        elif before:
            sx_end = before[-1][1]
            logger.info("[SubjectTracking] boundary t=%.1f: using last before scene, sx=%d", clip_dur, sx_end)
        else:
            sx_end = 50
            logger.info("[SubjectTracking] boundary t=%.1f: no scenes, using default center (50)", clip_dur)
        raw.append((clip_dur, sx_end))

    # Sort by time (boundary insertions should be in order but ensure it)
    raw.sort(key=lambda k: k[0])

    logger.info(
        "[SubjectTracking] _build_subject_keyframes result: %d keyframes — %s",
        len(raw), [(f"t={t:.2f}s,sx={sx}") for t, sx in raw],
    )

    return raw if raw else [(0.0, 50)]


def _smooth_keyframes(
    keyframes: list[tuple[float, int]],
    max_speed: float = 50.0,
) -> list[tuple[float, int]]:
    """Smooth keyframes to limit maximum subject_x change rate.

    max_speed: maximum subject_x units per second (e.g. 50 = 50% per second).
    Performs a forward pass clamping each keyframe so the change from the
    previous one doesn't exceed max_speed * dt.

    Returns a new list of smoothed keyframes.

    DEPRECATED: Use _smooth_keyframes_bidirectional() for human-feeling movement.
    Kept for reference only.
    """
    if len(keyframes) <= 1:
        return list(keyframes)

    smoothed = [keyframes[0]]
    clamped_count = 0
    for i in range(1, len(keyframes)):
        t_prev, sx_prev = smoothed[-1]
        t_cur, sx_cur = keyframes[i]
        dt = t_cur - t_prev
        if dt <= 0:
            smoothed.append((t_cur, sx_prev))
            continue
        max_delta = max_speed * dt
        delta = sx_cur - sx_prev
        if abs(delta) > max_delta:
            original_sx = sx_cur
            sx_cur = int(sx_prev + max_delta * (1 if delta > 0 else -1))
            sx_cur = max(0, min(100, sx_cur))
            clamped_count += 1
            logger.debug(
                "[SubjectTracking] _smooth_keyframes: clamped kf[%d] t=%.2f sx %d→%d (delta=%d, maxDelta=%.1f)",
                i, t_cur, original_sx, sx_cur, delta, max_delta,
            )
        smoothed.append((t_cur, sx_cur))

    if clamped_count > 0:
        logger.info(
            "[SubjectTracking] _smooth_keyframes: %d/%d keyframes clamped (max_speed=%.0f/s)",
            clamped_count, len(keyframes) - 1, max_speed,
        )

    return smoothed


def _handle_scene_cuts(
    keyframes: list[tuple[float, int]],
    jump_threshold: int = 12,
) -> list[tuple[float, int]]:
    """Insert instant-jump keyframes at likely scene cuts.

    When subject_x changes by more than jump_threshold between consecutive
    keyframes, this is likely a scene cut — the subject didn't physically
    move, the camera cut to a new shot.  Human editors cut-to instantly,
    they never pan across a scene cut.

    Inserts a keyframe 1ms before the cut with the OLD position, so the
    transition is truly instant — below one frame at any display rate.

    Matches frontend handleSceneCuts() exactly for preview-export parity.
    """
    if len(keyframes) <= 1:
        return list(keyframes)

    result = [keyframes[0]]
    for i in range(1, len(keyframes)):
        t_prev, sx_prev = result[-1]
        t_cur, sx_cur = keyframes[i]
        delta = abs(sx_cur - sx_prev)

        if delta >= jump_threshold and (t_cur - t_prev) > 0.1:
            # Large jump detected — insert instant cut
            # 1ms gap: below one frame at any frame rate, so smoothstep can't catch it
            cut_time = round(t_cur - 0.001, 3)
            if cut_time > t_prev:
                result.append((cut_time, sx_prev))  # Hold old position until cut
                logger.debug(
                    "[SubjectTracking] _handle_scene_cuts: instant cut at t=%.3f (delta=%d, threshold=%d)",
                    t_cur, delta, jump_threshold,
                )

        result.append((t_cur, sx_cur))

    cuts_inserted = len(result) - len(keyframes)
    if cuts_inserted > 0:
        logger.info(
            "[SubjectTracking] _handle_scene_cuts: %d instant-cut keyframes inserted (threshold=%d)",
            cuts_inserted, jump_threshold,
        )

    return result


def _apply_dead_zone(
    keyframes: list[tuple[float, int]],
    threshold: int = 5,
    src_ratio: float = 0,
    target_ratio: float = 0,
) -> list[tuple[float, int]]:
    """Eliminate jittery micro-movements by snapping small changes to previous value.

    When aspect ratio info is provided, the threshold is computed dynamically
    so it operates on VISIBLE crop movement (~3% of crop width) rather than
    raw source-frame movement.

    Matches frontend applyDeadZone() exactly for preview-export parity.
    """
    if len(keyframes) <= 1:
        return list(keyframes)

    # Compute effective threshold: we want ~3% of VISIBLE crop width as the dead zone
    VISIBLE_THRESHOLD = 3  # % of visible crop width
    effective_threshold = threshold
    if src_ratio > 0 and target_ratio > 0:
        R = src_ratio / target_ratio
        if R > 1.01:
            # Convert visible threshold back to source-frame units
            effective_threshold = max(2, round(VISIBLE_THRESHOLD * (R - 1) / R))

    result = [keyframes[0]]
    snapped_count = 0
    for i in range(1, len(keyframes)):
        t, sx = keyframes[i]
        _, prev_sx = result[-1]
        if abs(sx - prev_sx) < effective_threshold:
            # Small change — hold position (snap to previous)
            result.append((t, prev_sx))
            snapped_count += 1
        else:
            result.append((t, sx))

    if snapped_count > 0:
        logger.info(
            "[SubjectTracking] _apply_dead_zone: %d/%d keyframes snapped to previous (effective_threshold=%d, base=%d)",
            snapped_count, len(keyframes) - 1, effective_threshold, threshold,
        )

    return result


def _smooth_keyframes_bidirectional(
    keyframes: list[tuple[float, int]],
    max_speed: float = 25.0,
) -> list[tuple[float, int]]:
    """Two-pass bidirectional smoothing that eliminates trailing lag.

    Forward pass: clamp speed going forward (prevents anticipation overshoot)
    Reverse pass: clamp speed going backward (prevents trailing lag)
    Average: blend both passes for natural-feeling movement

    Matches frontend smoothKeyframesBidirectional() exactly for preview-export parity.
    """
    if len(keyframes) <= 1:
        return list(keyframes)

    # Forward pass
    fwd = [keyframes[0]]
    for i in range(1, len(keyframes)):
        t_prev, sx_prev = fwd[-1]
        t_cur, sx_cur = keyframes[i]
        dt = t_cur - t_prev
        if dt <= 0:
            fwd.append((t_cur, sx_prev))
            continue
        max_delta = max_speed * dt
        delta = sx_cur - sx_prev
        if abs(delta) > max_delta:
            sx_cur = int(sx_prev + max_delta * (1 if delta > 0 else -1))
            sx_cur = max(0, min(100, sx_cur))
        fwd.append((t_cur, sx_cur))

    # Reverse pass
    rev = [keyframes[-1]]
    for i in range(len(keyframes) - 2, -1, -1):
        t_next, sx_next = rev[-1]
        t_cur, sx_cur = keyframes[i]
        dt = t_next - t_cur
        if dt <= 0:
            rev.append((t_cur, sx_next))
            continue
        max_delta = max_speed * dt
        delta = sx_cur - sx_next
        if abs(delta) > max_delta:
            sx_cur = int(sx_next + max_delta * (1 if delta > 0 else -1))
            sx_cur = max(0, min(100, sx_cur))
        rev.append((t_cur, sx_cur))
    rev.reverse()

    # Average both passes
    result = []
    for i in range(len(keyframes)):
        t = fwd[i][0]
        avg_sx = int(round((fwd[i][1] + rev[i][1]) / 2))
        avg_sx = max(0, min(100, avg_sx))
        result.append((t, avg_sx))

    logger.info(
        "[SubjectTracking] _smooth_keyframes_bidirectional: %d keyframes processed (max_speed=%.0f/s)",
        len(keyframes), max_speed,
    )

    return result


def _merge_holds(
    keyframes: list[tuple[float, int]],
    tolerance: int = 3,
) -> list[tuple[float, int]]:
    """Merge consecutive keyframes with similar values into holds.

    If several consecutive keyframes are within tolerance of each other,
    snap them all to the first value — creating a visible 'rest' period
    where the crop holds steady.

    Matches frontend mergeHolds() exactly for preview-export parity.
    """
    if len(keyframes) <= 1:
        return list(keyframes)

    result = [keyframes[0]]
    merged_count = 0
    for i in range(1, len(keyframes)):
        t, sx = keyframes[i]
        _, prev_sx = result[-1]
        if abs(sx - prev_sx) <= tolerance:
            result.append((t, prev_sx))  # Hold at previous position
            merged_count += 1
        else:
            result.append((t, sx))

    if merged_count > 0:
        logger.info(
            "[SubjectTracking] _merge_holds: %d/%d keyframes merged into holds (tolerance=%d)",
            merged_count, len(keyframes) - 1, tolerance,
        )

    return result


def _compress_range(
    keyframes: list[tuple[float, int]],
    max_range: int = 25,
) -> list[tuple[float, int]]:
    """Compress the range of subject_x values to prevent erratic swinging.

    If the full range of sx values exceeds max_range, compress toward the
    median so total motion stays within bounds.  Preserves relative timing
    and direction of motion — just reduces amplitude.

    Matches frontend compressRange() exactly for preview-export parity.
    """
    if len(keyframes) <= 1:
        return list(keyframes)

    xs = [kf[1] for kf in keyframes]
    min_x = min(xs)
    max_x = max(xs)
    current_range = max_x - min_x

    if current_range <= max_range:
        return list(keyframes)

    # Compress toward median
    sorted_xs = sorted(xs)
    median = sorted_xs[len(sorted_xs) // 2]
    scale = max_range / current_range

    result = []
    for t, sx in keyframes:
        new_sx = round(max(0, min(100, median + (sx - median) * scale)))
        result.append((t, new_sx))

    logger.info(
        "[SubjectTracking] _compress_range: range %d→%d (max=%d), median=%d, compressed %d keyframes",
        current_range, max_range, max_range, median, len(keyframes),
    )

    return result


def _build_crop_x_expr(
    keyframes: list[tuple[float, int]],
    max_offset: int,
    src_w: int = 0,
    crop_w: int = 0,
) -> str:
    """Build an FFmpeg expression for time-varying horizontal crop offset.

    Uses piecewise smoothstep (cubic Hermite: 3p^2 - 2p^3) interpolation
    between keyframes for human-feeling ease-in/ease-out movement.  The
    FFmpeg crop filter evaluates the expression per-frame using the ``t``
    time variable.

    Each keyframe's subject_x is converted to a centering offset so the
    subject ends up at the horizontal center of the cropped frame.

    If all keyframes share the same subject_x (or there's only one), returns
    a plain integer string for a static crop — no expression overhead.

    Matches frontend interpolateSubjectX() smoothstep exactly for parity.

    Args:
        keyframes: sorted list of (time_seconds, subject_x_0_to_100)
        max_offset: maximum x_offset in pixels (src_w - crop_w)
        src_w: source video width in pixels (for centering calculation)
        crop_w: crop window width in pixels (for centering calculation)

    Returns:
        FFmpeg expression string for the x parameter of the crop filter.
    """
    if max_offset <= 0:
        return "0"

    def _sx_to_offset(sx: int) -> int:
        """Convert subject_x to a centering crop offset with safety clamping."""
        sx = _safe_subject_x(sx)
        if src_w > 0 and crop_w > 0:
            return _center_crop_offset(sx, src_w, crop_w)
        # Fallback to proportional if dimensions not provided
        return max(0, min(max_offset, int(max_offset * sx / 100)))

    # Check if all keyframes have the same value → static
    unique_sx = set(kf[1] for kf in keyframes)
    if len(unique_sx) <= 1:
        sx = keyframes[0][1] if keyframes else 50
        offset = _sx_to_offset(sx)
        logger.info(
            "[SubjectTracking] _build_crop_x_expr: static — all keyframes sx=%d → offset=%d (src_w=%d, crop_w=%d, max_offset=%d)",
            sx, offset, src_w, crop_w, max_offset,
        )
        return str(offset)

    # Build piecewise smoothstep interpolation expression
    # For each segment [ti, ti+1]:
    #   p = (t - t0) / dt   (normalized progress 0..1)
    #   smoothstep(p) = p*p*(3-2*p)
    #   offset = off0 + d_off * p*p*(3-2*p)
    offsets = [(t, _sx_to_offset(sx)) for t, sx in keyframes]

    logger.info(
        "[SubjectTracking] _build_crop_x_expr: dynamic (smoothstep) — %d keyframes, offsets=%s (src_w=%d, crop_w=%d, max_offset=%d)",
        len(offsets),
        [(f"t={t:.2f}→{off}px") for t, off in offsets],
        src_w, crop_w, max_offset,
    )

    # Build nested if(lt(t,...), segment, ...) from last to first
    # Final fallback: last offset
    expr = str(offsets[-1][1])

    for i in range(len(offsets) - 2, -1, -1):
        t0, off0 = offsets[i]
        t1, off1 = offsets[i + 1]
        dt = t1 - t0
        if dt <= 0 or off0 == off1:
            # Same offset or zero-length segment → just use off0
            segment = str(off0)
        else:
            d_off = off1 - off0
            # Smoothstep: off0 + d_off * p*p*(3-2*p) where p=(t-t0)/dt
            # Use st(0,p)/ld(0) to compute p once and avoid floating-point
            # rounding differences from multiple evaluations of the same expr.
            p_expr = f"(t-{t0:.3f})/{dt:.3f}"
            segment = f"{off0}+{d_off}*st(0\\,{p_expr})*ld(0)*(3-2*ld(0))"
        expr = f"if(lt(t\\,{t1:.3f})\\,{segment}\\,{expr})"

    # Clamp to valid range
    final_expr = f"clip({expr}\\,0\\,{max_offset})"
    logger.debug("[SubjectTracking] _build_crop_x_expr: FFmpeg expression=%s", final_expr)
    return final_expr


CUSTOM_FONTS_DIR = "/data/fonts"


def _extract_force_style_from_ass(ass_content: str) -> str:
    """Extract outline/border settings from ASS content for force_style override.

    Parses the first Style line and builds a force_style string that
    guarantees outline rendering via FFmpeg's subtitles filter.

    The ASS v4+ Style format fields (0-indexed after 'Style:'):
      0:Name, 1:Fontname, 2:Fontsize, 3:PrimaryColour, 4:SecondaryColour,
      5:OutlineColour, 6:BackColour, 7:Bold, ... 15:BorderStyle,
      16:Outline, 17:Shadow, ...
    """
    for line in ass_content.split("\n"):
        if line.startswith("Style:"):
            fields = line[len("Style:"):].strip().split(",")
            if len(fields) >= 18:
                outline_colour = fields[5].strip()
                back_colour = fields[6].strip()
                border_style = fields[15].strip()
                outline = fields[16].strip()
                shadow = fields[17].strip()
                return (
                    f"BorderStyle={border_style},"
                    f"Outline={outline},"
                    f"Shadow={shadow},"
                    f"OutlineColour={outline_colour},"
                    f"BackColour={back_colour}"
                )
            break
    return ""


def _ass_time_to_sec(t: str) -> float:
    """Parse ASS timestamp 'H:MM:SS.cc' to seconds."""
    parts = t.strip().split(":")
    h = int(parts[0])
    m = int(parts[1])
    s_cc = parts[2].split(".")
    s = int(s_cc[0])
    cs = int(s_cc[1]) if len(s_cc) > 1 else 0
    return h * 3600 + m * 60 + s + cs / 100.0


def _filter_ass_by_segments(ass_content: str, subs_off_ranges: list[tuple[float, float]]) -> str:
    """Remove ASS Dialogue lines that overlap with subtitle-off time ranges.

    subs_off_ranges: list of (start, end) in clip-relative seconds where subs should be hidden.
    """
    import re

    lines = ass_content.split("\n")
    result = []
    dialogue_re = re.compile(r"^Dialogue:\s*\d+,\s*(\d+:\d+:\d+\.\d+),\s*(\d+:\d+:\d+\.\d+),")
    for line in lines:
        match = dialogue_re.match(line)
        if match:
            d_start = _ass_time_to_sec(match.group(1))
            d_end = _ass_time_to_sec(match.group(2))
            # Check if this dialogue overlaps with any subs-off range
            skip = False
            for off_start, off_end in subs_off_ranges:
                if d_start < off_end and d_end > off_start:
                    skip = True
                    break
            if skip:
                continue
        result.append(line)
    return "\n".join(result)


def _filter_ass_keep_only_ranges(ass_content: str, subs_on_ranges: list[tuple[float, float]]) -> str:
    """Keep only ASS Dialogue lines that overlap with subtitle-on time ranges.

    Used when global subtitles are off but specific segments have subtitles enabled.
    subs_on_ranges: list of (start, end) in clip-relative seconds where subs should be shown.
    """
    import re

    lines = ass_content.split("\n")
    result = []
    dialogue_re = re.compile(r"^Dialogue:\s*\d+,\s*(\d+:\d+:\d+\.\d+),\s*(\d+:\d+:\d+\.\d+),")
    for line in lines:
        match = dialogue_re.match(line)
        if match:
            d_start = _ass_time_to_sec(match.group(1))
            d_end = _ass_time_to_sec(match.group(2))
            # Only keep if this dialogue overlaps with a subs-on range
            keep = False
            for on_start, on_end in subs_on_ranges:
                if d_start < on_end and d_end > on_start:
                    keep = True
                    break
            if not keep:
                continue
        result.append(line)
    return "\n".join(result)


def _subtitle_filter(ass_path: str, force_style: str = "") -> str:
    """Return the FFmpeg subtitle filter string for a given .ass path.

    Uses the 'subtitles' filter (not 'ass') so that force_style can be
    applied.  force_style directly modifies the libass style objects via
    ass_process_force_style(), guaranteeing that outline/border settings
    are rendered even when certain libass builds silently drop them from
    the parsed ASS Style line.

    Both the 'ass' and 'subtitles' filters internally call
    ass_set_fonts(..., ASS_FONTPROVIDER_AUTODETECT, ...) which enables
    fontconfig for system font discovery automatically — no explicit
    fontprovider option is needed (and FFmpeg doesn't expose one).
    """
    safe_path = ass_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    safe_fonts_dir = CUSTOM_FONTS_DIR.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    if force_style:
        safe_force = force_style.replace("'", "\\'")
        return (
            f"subtitles=filename='{safe_path}'"
            f":fontsdir='{safe_fonts_dir}'"
            f":force_style='{safe_force}'"
        )
    return f"subtitles=filename='{safe_path}':fontsdir='{safe_fonts_dir}'"


def _detect_crop(video_path: str, start: float = 0, duration: float = 5.0) -> tuple[int, int, int, int] | None:
    """Use FFmpeg cropdetect to find baked-in black bars in the source video.

    Returns (crop_w, crop_h, crop_x, crop_y) of the detected content area,
    or None if detection fails or the entire frame is content.
    """
    try:
        # Sample a few seconds from the middle-ish of the clip
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", str(start),
            "-i", video_path,
            "-t", str(duration),
            "-vf", "cropdetect=24:2:0",
            "-f", "null", "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        # Parse the last cropdetect line (most stable after initial frames)
        crop_line = None
        for line in result.stderr.split("\n"):
            if "crop=" in line:
                crop_line = line
        if not crop_line:
            return None
        # Extract crop=W:H:X:Y
        match = re.search(r"crop=(\d+):(\d+):(\d+):(\d+)", crop_line)
        if not match:
            return None
        cw, ch, cx, cy = int(match.group(1)), int(match.group(2)), int(match.group(3)), int(match.group(4))
        return (cw, ch, cx, cy)
    except Exception as e:
        logger.debug("cropdetect failed: %s", e)
        return None


def _atempo_chain(spd: float) -> str:
    """Build chained atempo filters for a given speed value.

    FFmpeg's atempo filter only supports the 0.5–2.0 range, so extreme
    values must be split into multiple chained filters.
    """
    parts: list[str] = []
    remaining = spd
    while remaining > 2.0:
        parts.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    if abs(remaining - 1.0) > 0.001:
        parts.append(f"atempo={remaining:.4f}")
    return ",".join(parts)


def _build_speed_timeline(
    segments: list[dict],
    clip_dur: float,
    global_speed: float,
    global_volume: float,
    clip_start: float,
) -> list[dict]:
    """Build a complete timeline covering 0..clip_dur from segment overrides.

    Fills gaps between segments with global speed/volume settings.
    Returns list of dicts with keys: start, end, speed, volume, muted.
    Times are clip-relative (0-based).
    """
    sorted_segs = sorted(segments, key=lambda s: s["start"])
    timeline: list[dict] = []
    pos = 0.0

    for seg in sorted_segs:
        seg_start = max(0.0, seg["start"] - clip_start)
        seg_end = min(clip_dur, seg["end"] - clip_start)
        if seg_end <= seg_start:
            continue

        # Gap before this segment
        if seg_start > pos + 0.01:
            timeline.append({
                "start": pos, "end": seg_start,
                "speed": global_speed, "volume": global_volume, "muted": False,
            })

        seg_vol = 0.0 if seg.get("muted", False) else seg.get("volume", 1.0)
        timeline.append({
            "start": seg_start, "end": seg_end,
            "speed": seg.get("speed", global_speed),
            "volume": seg_vol, "muted": seg.get("muted", False),
        })
        pos = seg_end

    # Gap after last segment
    if pos < clip_dur - 0.01:
        timeline.append({
            "start": pos, "end": clip_dur,
            "speed": global_speed, "volume": global_volume, "muted": False,
        })

    return timeline


def _build_filter_chain(
    aspect_ratio: str | None,
    src_w: int,
    src_h: int,
    ass_path: str | None,
    subject_x: int = 50,
    subject_keyframes: list[tuple[float, int]] | None = None,
    export_quality: str = "1080p",
    subtitle_force_style: str = "",
    video_path: str | None = None,
    start_time: float = 0,
) -> tuple[str | None, bool]:
    """Build FFmpeg video filter chain.

    Always crops to fill the target aspect ratio (no blur-background).
    Uses subject_keyframes (if provided) for time-varying crop that follows
    the subject through the clip.  Falls back to static subject_x.

    subtitle_force_style: optional force_style string (e.g.
    'BorderStyle=1,Outline=6,...') extracted from the generated ASS
    content.  Passed to the subtitles filter to guarantee outline
    rendering regardless of libass build quirks.

    video_path / start_time: used for cropdetect to remove baked-in
    black bars (pillarboxing/letterboxing) from the source video.

    Returns (filter_string, is_complex_graph).
    """
    # Determine if quality requires resolution scaling (even without aspect ratio)
    target_h = QUALITY_MAX_HEIGHT.get(export_quality, 1080)
    needs_quality_scale = (src_h != target_h)

    # Detect and remove baked-in black bars from the source video.
    # Many source videos (screen recordings, re-encoded clips) have
    # pillarboxing or letterboxing baked into the pixel data.  Without
    # this, the exported video inherits those black bars, and subtitles
    # span the full frame (including the bars) instead of the content.
    effective_w, effective_h = src_w, src_h
    precrop_filter = None
    if video_path:
        crop_result = _detect_crop(video_path, start=start_time, duration=3.0)
        if crop_result:
            cw, ch, cx, cy = crop_result
            # Only apply if cropdetect found significant black bars
            # (at least 4% removed from any dimension)
            w_removed_pct = (src_w - cw) / src_w * 100 if src_w > 0 else 0
            h_removed_pct = (src_h - ch) / src_h * 100 if src_h > 0 else 0
            if w_removed_pct >= 4 or h_removed_pct >= 4:
                # Ensure even dimensions
                cw = cw - (cw % 2)
                ch = ch - (ch % 2)
                precrop_filter = f"crop={cw}:{ch}:{cx}:{cy}"
                effective_w, effective_h = cw, ch
                logger.info(
                    "Detected baked-in black bars: source %dx%d → content %dx%d "
                    "(removed %.1f%% width, %.1f%% height)",
                    src_w, src_h, cw, ch, w_removed_pct, h_removed_pct,
                )

    # Recompute after precrop may have changed effective dimensions
    needs_quality_scale = (effective_h != target_h)

    if not aspect_ratio and not ass_path and not needs_quality_scale and not precrop_filter:
        return None, False

    out_w, out_h = effective_w, effective_h
    sub = _subtitle_filter(ass_path, force_style=subtitle_force_style) if ass_path else ""

    # Simple linear chain: setsar → precrop → crop → scale → subtitles
    # Start with setsar=1 to normalize non-square pixels (SAR != 1:1).
    # Many source videos have non-square SAR which causes FFmpeg's crop
    # and scale filters to produce slightly wrong dimensions, resulting
    # in thin black bars at the edges of the exported video.
    filters = ["setsar=1"]

    # Remove baked-in black bars before any aspect ratio cropping
    if precrop_filter:
        filters.append(precrop_filter)
        # Update src dimensions for subsequent aspect ratio calculations
        src_w, src_h = effective_w, effective_h

    if aspect_ratio and aspect_ratio in ASPECT_RATIO_VALUES:
        target_ratio = ASPECT_RATIO_VALUES[aspect_ratio]
        src_ratio = src_w / src_h if src_h else 1
        dims_table = ASPECT_RATIO_DIMS_BY_QUALITY.get(export_quality, ASPECT_RATIO_DIMS)
        out_w, out_h = dims_table.get(aspect_ratio, (1920, 1080))
        out_w = out_w - (out_w % 2)
        out_h = out_h - (out_h % 2)

        if abs(src_ratio - target_ratio) > 0.01:
            if target_ratio < src_ratio:
                # Crop width (e.g. 16:9 → 9:16: need narrower crop)
                crop_h = src_h
                crop_w = int(src_h * target_ratio)
            else:
                # Crop height (e.g. 9:16 → 16:9: need shorter crop)
                crop_w = src_w
                crop_h = int(src_w / target_ratio)

            crop_w = crop_w - (crop_w % 2)
            crop_h = crop_h - (crop_h % 2)

            # Clamp crop dimensions to never exceed source frame
            crop_w = min(crop_w, src_w)
            crop_h = min(crop_h, src_h)

            max_x_offset = max(0, src_w - crop_w)

            # Keep vertical crop centered — clamp to valid range
            max_y_offset = max(0, src_h - crop_h)
            y_offset = (src_h - crop_h) // 2
            y_offset = max(0, min(max_y_offset, y_offset))

            logger.info(
                "[SubjectTracking] _build_filter_chain: %s→%s, src=%dx%d, crop=%dx%d, max_x_offset=%d",
                f"{src_ratio:.3f}", f"{target_ratio:.3f}", src_w, src_h, crop_w, crop_h, max_x_offset,
            )

            # Dynamic or static horizontal offset — center subject in frame
            if subject_keyframes and len(subject_keyframes) > 1:
                unique_sx = set(kf[1] for kf in subject_keyframes)
                if len(unique_sx) > 1:
                    # Dynamic crop: time-varying x offset
                    x_expr = _build_crop_x_expr(subject_keyframes, max_x_offset, src_w, crop_w)
                    filters.append(f"crop={crop_w}:{crop_h}:{x_expr}:{y_offset}")
                    logger.info(
                        "[SubjectTracking] DYNAMIC CROP: %d keyframes, %d unique sx values, "
                        "crop=%dx%d, y_offset=%d",
                        len(subject_keyframes), len(unique_sx), crop_w, crop_h, y_offset,
                    )
                else:
                    # All keyframes same value → static centered
                    sx = _safe_subject_x(subject_keyframes[0][1])
                    x_offset = _center_crop_offset(sx, src_w, crop_w)
                    filters.append(f"crop={crop_w}:{crop_h}:{x_offset}:{y_offset}")
                    logger.info(
                        "[SubjectTracking] STATIC CROP (converged keyframes): sx=%d → x_offset=%d, "
                        "subject_pixel=%.0f, crop_center=%.0f, crop=%dx%d",
                        sx, x_offset, src_w * sx / 100, x_offset + crop_w / 2, crop_w, crop_h,
                    )
            else:
                # Static crop: single subject_x value, centered
                if subject_keyframes:
                    sx = _safe_subject_x(subject_keyframes[0][1])
                else:
                    sx = _safe_subject_x(subject_x)
                x_offset = _center_crop_offset(sx, src_w, crop_w)
                filters.append(f"crop={crop_w}:{crop_h}:{x_offset}:{y_offset}")
                subject_pixel = src_w * sx / 100
                crop_center = x_offset + crop_w / 2
                centering_error = abs(subject_pixel - crop_center)
                logger.info(
                    "[SubjectTracking] STATIC CROP: sx=%d → x_offset=%d, "
                    "subject at pixel %.0f, crop center at pixel %.0f (error=%.1fpx), crop=%dx%d",
                    sx, x_offset, subject_pixel, crop_center, centering_error, crop_w, crop_h,
                )

        filters.append(f"scale={out_w}:{out_h}")
    elif needs_quality_scale:
        # No aspect ratio change but quality requires resizing — scale preserving aspect ratio
        # Use -2 for width so FFmpeg auto-computes an even width from the target height
        out_h = target_h
        out_w = -2
        filters.append(f"scale={out_w}:{out_h}")

    if sub:
        filters.append(sub)

    # VA-API needs frames uploaded to GPU after CPU-side subtitle filter
    if app_settings.GPU_ACCELERATION_ENABLED:
        gpu = detect_gpu_capabilities()
        if gpu["encoder"] == "h264_vaapi" and filters:
            filters.append("format=nv12")
            filters.append("hwupload")

    return (",".join(filters) if filters else None, False)


async def export_clip(
    job_id: str,
    video_path: str,
    start: float,
    end: float,
    clip_id: int,
    clip_title: str | None = None,
    aspect_ratio: str | None = None,
    subtitles_enabled: bool = False,
    subtitle_settings: dict | None = None,
    transcript: list | None = None,
    video_width: int = 1920,
    video_height: int = 1080,
    subject_x: int = 50,
    subject_scenes: list | None = None,
    progress_callback=None,
    cancel_event: "asyncio.Event | None" = None,
    export_quality: str = "1080p",
    volume: float = 1.0,
    speed: float = 1.0,
    segments: list | None = None,
    global_subtitles_enabled: bool | None = None,
) -> str:
    """Export a clip from video using FFmpeg.

    When aspect_ratio or subtitles are specified, re-encodes with filters.
    Otherwise uses stream copy for speed.

    subject_scenes: overlapping SceneDescription objects (or dicts with
        timestamp + subject_x).  When provided, enables dynamic crop that
        follows the subject through the clip.  Falls back to static
        subject_x if None or insufficient data.

    volume: Audio gain (0.0 to 2.0, default 1.0). Applied via -af volume filter.
    speed: Playback speed (0.25 to 4.0, default 1.0). Applied via setpts + atempo.

    progress_callback: optional async callable(message: str) for status updates.
    """
    async def _notify(msg: str):
        if progress_callback:
            try:
                await progress_callback(msg)
            except Exception:
                pass

    clip_dur = end - start
    output_dir = f"/data/outputs/{job_id}/clips"
    os.makedirs(output_dir, exist_ok=True)

    # Quality tag for filename
    quality_tag = export_quality.upper() if export_quality else "1080P"

    # Use clip title for filename if provided, otherwise fall back to ID-based naming
    if clip_title:
        # Sanitize title for filesystem: replace unsafe chars, collapse whitespace
        safe_title = re.sub(r'[<>:"/\\|?*]', '', clip_title)
        safe_title = re.sub(r'\s+', ' ', safe_title).strip()
        if not safe_title:
            safe_title = f"clip_{clip_id}"
        # Truncate to avoid excessively long filenames
        if len(safe_title) > 120:
            safe_title = safe_title[:120].rstrip()
        output_path = os.path.join(output_dir, f"[{quality_tag}]{safe_title}.mp4")
    else:
        output_path = os.path.join(
            output_dir, f"[{quality_tag}]clip_{clip_id}_{int(start)}_{int(end)}.mp4"
        )

    # Delete any pre-existing output file to ensure we never serve a stale
    # export from a previous run (same clip title → same filename).
    if os.path.exists(output_path):
        try:
            os.remove(output_path)
            logger.info("Removed stale output file: %s", output_path)
        except OSError as e:
            logger.warning("Could not remove stale output: %s", e)

    def _check_cancel():
        if cancel_event and cancel_event.is_set():
            raise asyncio.CancelledError("Export cancelled by user")

    ass_path = None
    subtitle_force_style = ""
    # Determine if quality requires resolution scaling
    quality_target_h = QUALITY_MAX_HEIGHT.get(export_quality, 1080)
    needs_quality_scale = (video_height != quality_target_h)
    has_speed = abs(speed - 1.0) > 0.001
    has_volume = abs(volume - 1.0) > 0.001
    has_segments = bool(segments) and len(segments) > 0
    # Detect per-segment speed overrides (different from global speed)
    has_seg_speed = False
    if has_segments:
        for seg in segments:
            if abs(seg.get("speed", 1.0) - 1.0) > 0.001:
                has_seg_speed = True
                break
    needs_filters = bool(aspect_ratio) or subtitles_enabled or needs_quality_scale or has_speed or has_volume or has_segments or has_seg_speed
    filter_parts = []
    if aspect_ratio:
        filter_parts.append(f"crop to {aspect_ratio}")
    if subtitles_enabled:
        filter_parts.append("burn subtitles")
    if needs_quality_scale:
        filter_parts.append(f"scale to {export_quality}")
    if has_seg_speed:
        seg_speeds = set(seg.get("speed", 1.0) for seg in segments)
        filter_parts.append(f"per-segment speed ({len(seg_speeds)} unique)")
    elif has_speed:
        filter_parts.append(f"speed {speed}x")
    if has_volume:
        filter_parts.append(f"volume {volume:.0%}")
    if has_segments:
        filter_parts.append(f"{len(segments)} segment overrides")
    filter_desc = " + ".join(filter_parts) if filter_parts else "stream copy"

    await _notify(f"Preparing clip {clip_id} ({clip_dur:.1f}s) — {filter_desc}")

    try:
        # Log all export settings for debugging subtitle burn-in
        logger.info(
            "Export clip %s: start=%.1f end=%.1f aspect=%s subs=%s "
            "video=%dx%d subject_x=%d scenes=%d quality=%s",
            clip_id, start, end, aspect_ratio or "original",
            subtitles_enabled, video_width, video_height,
            subject_x, len(subject_scenes or []), export_quality,
        )
        if subtitles_enabled and subtitle_settings:
            logger.info(
                "Subtitle settings: font=%s size=%s weight=%s color=%s "
                "pos=%s bg=%s outline=%s/%s/%s speakers=%s labels=%s "
                "max_width=%s offset_v=%s max_words=%s active_word=%s",
                subtitle_settings.get("font"),
                subtitle_settings.get("size"),
                subtitle_settings.get("font_weight"),
                subtitle_settings.get("font_color"),
                subtitle_settings.get("position"),
                subtitle_settings.get("background_enabled"),
                subtitle_settings.get("outline_color"),
                subtitle_settings.get("outline_opacity"),
                subtitle_settings.get("outline_width"),
                subtitle_settings.get("use_speaker_colors"),
                subtitle_settings.get("show_speaker_labels"),
                subtitle_settings.get("max_width"),
                subtitle_settings.get("offset_v"),
                subtitle_settings.get("max_words"),
                subtitle_settings.get("active_word_enabled"),
            )

        # Generate ASS subtitle file if subtitles are enabled
        if subtitles_enabled and transcript:
            settings = subtitle_settings or {}
            transcript_segments = [
                TranscriptSegment(**s) if isinstance(s, dict) else s
                for s in transcript
            ]

            # Determine output dimensions for subtitle positioning.
            # Must match the actual output resolution (quality-aware) so
            # subtitle font sizes and margins are correct in the final video.
            #
            # When the source has baked-in black bars (pillarboxing), use
            # the detected content dimensions instead of the container size.
            # Otherwise subtitles span the full frame including black bars.
            eff_w, eff_h = video_width, video_height
            crop_result = _detect_crop(video_path, start=start, duration=3.0)
            if crop_result:
                cw, ch, _, _ = crop_result
                w_rem = (video_width - cw) / video_width * 100 if video_width > 0 else 0
                h_rem = (video_height - ch) / video_height * 100 if video_height > 0 else 0
                if w_rem >= 4 or h_rem >= 4:
                    eff_w = cw - (cw % 2)
                    eff_h = ch - (ch % 2)

            dims_table = ASPECT_RATIO_DIMS_BY_QUALITY.get(export_quality, ASPECT_RATIO_DIMS)
            if aspect_ratio and aspect_ratio in dims_table:
                out_w, out_h = dims_table[aspect_ratio]
            elif not aspect_ratio:
                # No aspect ratio — use quality-scaled height, derive width
                quality_h = QUALITY_MAX_HEIGHT.get(export_quality, 1080)
                if eff_h != quality_h and eff_h > 0:
                    scale_factor = quality_h / eff_h
                    out_w = int(eff_w * scale_factor)
                    out_w = out_w - (out_w % 2)  # ensure even
                    out_h = quality_h
                else:
                    out_w, out_h = eff_w, eff_h
            else:
                out_w, out_h = eff_w, eff_h

            ass_content = generate_ass(
                segments=transcript_segments,
                start_time=start,
                end_time=end,
                font=settings.get("font", "DM Sans"),
                font_size=settings.get("size", "medium"),
                font_weight=settings.get("font_weight", "bold"),
                font_color=settings.get("font_color", "#FFFFFF"),
                position=settings.get("position", "bottom"),
                speaker_colors=settings.get("speaker_colors"),
                use_speaker_colors=settings.get("use_speaker_colors", True),
                video_width=out_w,
                video_height=out_h,
                background_enabled=settings.get("background_enabled", False),
                background_color=settings.get("background_color", "#000000"),
                background_opacity=settings.get("background_opacity", 75),
                background_radius=settings.get("background_radius", 0),
                outline_color=settings.get("outline_color", "#000000"),
                outline_opacity=settings.get("outline_opacity", 100),
                outline_width=settings.get("outline_width", 2),
                content_inset_v=0,
                content_inset_h=0,
                show_speaker_labels=settings.get("show_speaker_labels", False),
                max_width_pct=settings.get("max_width", 90),
                offset_v_pct=settings.get("offset_v", 4),
                max_words=settings.get("max_words", 0),
                active_word_enabled=settings.get("active_word_enabled", False),
                active_word_color=settings.get("active_word_color", "#FFD700"),
                active_word_outline_color=settings.get("active_word_outline_color", "#000000"),
                active_word_bg_color=settings.get("active_word_bg_color", "#000000"),
                active_word_bg_opacity=settings.get("active_word_bg_opacity", 0),
            )

            if ass_content:
                # Filter ASS dialogue lines based on per-segment subtitle overrides.
                # Two modes:
                # 1. Global subs ON: remove dialogue in segments with subtitles_enabled=false
                # 2. Global subs OFF (enabled by segment overrides): keep ONLY dialogue
                #    in segments with subtitles_enabled=true
                if has_segments:
                    # Use the original global toggle to determine base behavior.
                    # Falls back to subtitles_enabled if not provided (backwards compat).
                    global_subs = global_subtitles_enabled if global_subtitles_enabled is not None else subtitles_enabled
                    subs_on_segs = [seg for seg in segments if seg.get("subtitles_enabled", True)]
                    subs_off_segs = [seg for seg in segments if not seg.get("subtitles_enabled", True)]

                    if not global_subs and subs_on_segs:
                        # Global subs off but some segments have subs on —
                        # keep only dialogue within subs-on segment ranges
                        subs_on_ranges = [
                            (max(0, seg["start"] - start), min(end - start, seg["end"] - start))
                            for seg in subs_on_segs
                        ]
                        ass_content = _filter_ass_keep_only_ranges(ass_content, subs_on_ranges)
                    elif subs_off_segs:
                        # Global subs on — remove dialogue in subs-off segment ranges
                        subs_off_ranges = [
                            (seg["start"] - start, seg["end"] - start)
                            for seg in subs_off_segs
                        ]
                        ass_content = _filter_ass_by_segments(ass_content, subs_off_ranges)

                ass_path = os.path.join(output_dir, f"clip_{clip_id}_sub.ass")
                # Remove any stale ASS file from a previous export to ensure
                # the fresh content is always used (prevents caching issues).
                if os.path.exists(ass_path):
                    os.remove(ass_path)
                with open(ass_path, "w", encoding="utf-8") as f:
                    f.write(ass_content)
                logger.info("ASS file written: %s (%d bytes)", ass_path, len(ass_content))

                # ── Diagnostic: verify two-layer architecture ──
                # Log whether the ASS uses the two-layer approach for active
                # word mode so we can confirm the black-bar fix is active.
                if settings.get("active_word_enabled"):
                    layer0_count = ass_content.count("Dialogue: 0,")
                    layer1_count = ass_content.count("Dialogue: 1,")
                    has_nobord = "\\bord0\\shad0\\3a&HFF&" in ass_content
                    logger.info(
                        "ASS two-layer check for clip %s: Layer0=%d events, Layer1=%d events, "
                        "has_nobord_tag=%s (expected: both layers populated, nobord=True)",
                        clip_id, layer0_count, layer1_count, has_nobord,
                    )
                    if layer0_count == 0 or layer1_count == 0:
                        logger.warning(
                            "ASS two-layer architecture NOT active for clip %s — "
                            "black bars may still appear. Layer0=%d, Layer1=%d",
                            clip_id, layer0_count, layer1_count,
                        )

                # NOTE: force_style is intentionally NOT used.
                #
                # The old approach extracted outline/border settings from the
                # first ASS Style line and passed them as force_style to the
                # subtitles filter.  This caused two problems:
                #
                # 1. force_style applies GLOBALLY to all styles, overriding
                #    per-speaker PrimaryColour when use_speaker_colors=True
                #    (it extracts OutlineColour from only the first style).
                #
                # 2. force_style modifies the style objects via
                #    ass_process_force_style(), which can conflict with the
                #    per-event inline override tags (\bord, \3c, \shad) that
                #    are already prepended to every Dialogue event in
                #    ass_generator.py.
                #
                # The inline override tags are sufficient to guarantee outline
                # rendering in the exported video.  Removing force_style
                # ensures the ASS file's carefully constructed per-event and
                # per-speaker styling is preserved exactly as generated.
                subtitle_force_style = ""
                logger.info(
                    "Subtitle rendering for clip %s: using inline override tags (no force_style)",
                    clip_id,
                )

                # QA: validate ASS content matches the input settings so
                # the exported video will match the frontend preview.
                qa_warnings = _validate_ass_settings(
                    ass_content=ass_content,
                    settings=settings,
                    video_width=out_w,
                    video_height=out_h,
                )
                for w in qa_warnings:
                    logger.warning("Export QA (clip %s): %s", clip_id, w)

                # Surface ALL QA warnings to the user via progress callback
                if qa_warnings:
                    await _notify(f"QA check found {len(qa_warnings)} issue(s) for clip {clip_id}")
                    for w in qa_warnings:
                        await _notify(f"QA (clip {clip_id}): {w}")

                await _notify(f"Subtitle file generated for clip {clip_id}")
            else:
                logger.warning(
                    "No ASS content generated for clip %s — no transcript "
                    "segments overlap clip range %.1f-%.1f (%d total segments)",
                    clip_id, start, end, len(transcript),
                )

        _check_cancel()

        if needs_filters:
            # Build subject keyframes for dynamic crop tracking
            keyframes = None
            logger.info(
                "═══════════════════════════════════════════════════════════════════════════",
            )
            logger.info(
                "[SubjectTracking] ▶ EXPORT clip %s: start=%.1f end=%.1f (%.1fs), "
                "aspect=%s, src=%dx%d, subject_x=%d, scenes=%d",
                clip_id, start, end, end - start,
                aspect_ratio or "original", video_width, video_height,
                subject_x, len(subject_scenes or []),
            )
            # Compute aspect ratios for dynamic safe margin
            _src_ratio = video_width / video_height if video_height else 1
            _target_ratio = ASPECT_RATIO_VALUES.get(aspect_ratio, _src_ratio) if aspect_ratio else _src_ratio

            if subject_scenes and aspect_ratio:
                raw_kf = _build_subject_keyframes(subject_scenes, start, end, src_ratio=_src_ratio, target_ratio=_target_ratio)
                logger.info(
                    "[SubjectTracking] clip %s: %d raw keyframes from %d scenes",
                    clip_id, len(raw_kf), len(subject_scenes),
                )
                if len(raw_kf) > 1:
                    # Full pipeline: build → scene cuts → compress range → dead zone → smooth → merge holds
                    after_cuts = _handle_scene_cuts(raw_kf)
                    after_compress = _compress_range(after_cuts)
                    after_dead_zone = _apply_dead_zone(after_compress, src_ratio=_src_ratio, target_ratio=_target_ratio)
                    after_smooth = _smooth_keyframes_bidirectional(after_dead_zone)
                    keyframes = _merge_holds(after_smooth)

                    logger.info(
                        "[SubjectTracking] clip %s: pipeline stages — raw=%d → cuts=%d → compress=%d → deadzone=%d → smooth=%d → holds=%d",
                        clip_id, len(raw_kf), len(after_cuts), len(after_compress), len(after_dead_zone),
                        len(after_smooth), len(keyframes),
                    )

                    # If pipeline collapsed to single value, keep as-is (static)
                    unique = set(kf[1] for kf in keyframes)
                    if len(unique) <= 1:
                        # Use the converged keyframe value as the static subject_x
                        # so the crop still centers on the tracked subject position
                        converged_sx = keyframes[0][1]
                        logger.info(
                            "[SubjectTracking] clip %s: all keyframes converged to sx=%d — using STATIC crop centered on subject",
                            clip_id, converged_sx,
                        )
                        subject_x = converged_sx
                        keyframes = None
                    else:
                        logger.info(
                            "[SubjectTracking] clip %s: DYNAMIC tracking — %d processed keyframes, "
                            "sx range [%d, %d], keyframes=%s",
                            clip_id, len(keyframes),
                            min(kf[1] for kf in keyframes),
                            max(kf[1] for kf in keyframes),
                            [(f"t={t:.2f}s,sx={sx}") for t, sx in keyframes],
                        )
                elif len(raw_kf) == 1:
                    # Single keyframe — use its tracked value directly as the
                    # static subject_x so the crop centers on the actual subject
                    subject_x = raw_kf[0][1]
                    logger.info(
                        "[SubjectTracking] clip %s: single keyframe at sx=%d — using STATIC crop centered on subject",
                        clip_id, subject_x,
                    )
            else:
                if not subject_scenes:
                    logger.info(
                        "[SubjectTracking] clip %s: NO SCENE DATA — using default subject_x=%d (center crop)",
                        clip_id, subject_x,
                    )
                elif not aspect_ratio:
                    logger.info(
                        "[SubjectTracking] clip %s: no aspect ratio change — subject tracking not needed "
                        "(have %d scenes but original aspect ratio preserved)",
                        clip_id, len(subject_scenes),
                    )
                else:
                    logger.info(
                        "[SubjectTracking] clip %s: STATIC (subject_x=%d, scenes=%d, aspect=%s)",
                        clip_id, subject_x,
                        len(subject_scenes) if subject_scenes else 0,
                        aspect_ratio or "original",
                    )

            # Build filter chain and re-encode
            vf, is_complex = _build_filter_chain(
                aspect_ratio, video_width, video_height, ass_path,
                subject_x=subject_x,
                subject_keyframes=keyframes,
                export_quality=export_quality,
                subtitle_force_style=subtitle_force_style,
                video_path=video_path,
                start_time=start,
            )

            # QA: validate subject tracking is correctly applied in filter chain
            st_warnings = _validate_subject_tracking(
                filter_chain=vf,
                aspect_ratio=aspect_ratio,
                src_w=video_width,
                src_h=video_height,
                subject_x=subject_x,
                subject_keyframes=keyframes,
            )
            for w in st_warnings:
                logger.warning("[SubjectTracking] QA ISSUE (clip %s): %s", clip_id, w)
            if st_warnings:
                await _notify(f"Subject tracking QA found {len(st_warnings)} issue(s) for clip {clip_id}")
                for w in st_warnings:
                    await _notify(f"QA (clip {clip_id}): {w}")
            else:
                logger.info(
                    "[SubjectTracking] ✓ QA PASSED for clip %s — subject centering validated",
                    clip_id,
                )

            # Run centering verification: compute the expected center offset for
            # each keyframe and log the centering precision
            if aspect_ratio and aspect_ratio in ASPECT_RATIO_VALUES:
                _verify_centering_math(
                    clip_id=clip_id,
                    aspect_ratio=aspect_ratio,
                    src_w=video_width,
                    src_h=video_height,
                    subject_x=subject_x,
                    subject_keyframes=keyframes,
                )

            # Resolve encoding params from quality preset (fallback to config)
            qp = QUALITY_PRESETS.get(export_quality, QUALITY_PRESETS["1080p"])
            enc_crf = qp["crf"]
            enc_preset = qp["preset"]

            # ── Per-segment speed via multi-input→setpts/atempo→concat ───
            # The previous split→trim→concat approach caused FFmpeg to
            # buffer the entire decoded video for each split output.  For
            # long videos (e.g. 722s at 1080p) this exhausts memory and
            # crashes the process.  The multi-input approach opens the
            # source file once per timeline segment with its own -ss seek,
            # so each input only decodes its own frames.
            if has_seg_speed:
                clip_dur_local = end - start
                timeline = _build_speed_timeline(segments, clip_dur_local, speed, volume, start)
                n = len(timeline)
                logger.info(
                    "Per-segment speed for clip %s: %d timeline entries from %d segments — %s",
                    clip_id, n, len(segments),
                    [(f"[{tl['start']:.1f}-{tl['end']:.1f}@{tl['speed']}x]") for tl in timeline],
                )

                # Probe whether the input has an audio stream
                _probe_cmd = [
                    "ffprobe", "-v", "quiet", "-select_streams", "a",
                    "-show_entries", "stream=index", "-of", "csv=p=0",
                    video_path,
                ]
                _probe_proc = await asyncio.create_subprocess_exec(
                    *_probe_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _probe_out, _ = await _probe_proc.communicate()
                _has_audio = bool(_probe_out.strip())

                # --- Build multi-input args: one -ss/-t/-i per segment ---
                # HW decode args go before each -i so the decoder is
                # initialised per-input (required for multi-input).
                _hw_dec = _gpu_decode_args_for_filter()
                input_args: list[str] = []
                for i, tl in enumerate(timeline):
                    abs_start = start + tl["start"]
                    seg_dur = tl["end"] - tl["start"]
                    # Add 1s buffer for keyframe alignment; trim in filter
                    # ensures exact segment duration
                    input_args += _hw_dec + [
                        "-ss", f"{abs_start:.3f}",
                        "-t", f"{seg_dur + 1.0:.3f}",
                        "-i", video_path,
                    ]

                # --- Video filter chain per input ---
                fc_lines: list[str] = []
                for i, tl in enumerate(timeline):
                    seg_dur = tl["end"] - tl["start"]
                    pts_offset = tl["start"]
                    pts_factor = 1.0 / tl["speed"]

                    # 1. trim to exact segment duration (safety for -ss buffer)
                    # 2. normalize PTS to 0 then shift to clip-relative time
                    #    so subtitle burn-in and dynamic crop keyframes align
                    # 3. apply visual filters (crop, subtitles, scale)
                    # 4. normalize PTS back to 0
                    # 5. apply speed scaling if needed
                    chain = f"[{i}:v]trim=duration={seg_dur:.3f},setpts=PTS-STARTPTS"
                    if pts_offset > 0.001:
                        chain += f"+{pts_offset:.3f}/TB"
                    if vf:
                        chain += f",{vf}"
                    chain += ",setpts=PTS-STARTPTS"
                    if abs(tl["speed"] - 1.0) > 0.001:
                        chain += f",setpts={pts_factor:.6f}*PTS"
                    chain += f"[vo{i}]"
                    fc_lines.append(chain)

                # --- Audio chain (only if audio exists) ---
                if _has_audio:
                    for i, tl in enumerate(timeline):
                        seg_dur = tl["end"] - tl["start"]
                        chain = (
                            f"[{i}:a]atrim=duration={seg_dur:.3f}"
                            f",asetpts=PTS-STARTPTS"
                        )
                        if abs(tl["speed"] - 1.0) > 0.001:
                            chain += f",{_atempo_chain(tl['speed'])}"
                        seg_vol = 0.0 if tl["muted"] else tl["volume"]
                        if abs(seg_vol - 1.0) > 0.001 or tl["muted"]:
                            chain += f",volume={seg_vol:.4f}"
                        chain += f"[ao{i}]"
                        fc_lines.append(chain)

                    # Concat video + audio
                    concat_inputs = "".join(f"[vo{i}][ao{i}]" for i in range(n))
                    fc_lines.append(f"{concat_inputs}concat=n={n}:v=1:a=1[finalv][finala]")
                    map_args = ["-map", "[finalv]", "-map", "[finala]"]
                else:
                    # No audio — video-only concat
                    concat_inputs = "".join(f"[vo{i}]" for i in range(n))
                    fc_lines.append(f"{concat_inputs}concat=n={n}:v=1:a=0[finalv]")
                    map_args = ["-map", "[finalv]"]

                full_fc = ";".join(fc_lines)
                logger.info(
                    "Per-segment speed filter_complex for clip %s:\n%s",
                    clip_id, full_fc,
                )

                cmd = [
                    "ffmpeg", "-y",
                ] + input_args + [
                    "-filter_complex", full_fc,
                ] + map_args + [
                    *_gpu_encode_args(qp, export_quality),
                    "-threads", str(app_settings.FFMPEG_THREADS),
                ]
                if _has_audio:
                    cmd += ["-c:a", "aac"]
                cmd += ["-avoid_negative_ts", "make_zero"]
                if app_settings.FFMPEG_FASTSTART:
                    cmd += ["-movflags", "+faststart"]
                cmd += ["-progress", "pipe:1"]
                cmd.append(output_path)

            else:
                # ── Global speed + volume (original path) ─────────────
                # --- Speed filter: append setpts to video chain ---
                if has_speed and vf:
                    vf = f"{vf},setpts={1.0/speed}*PTS"
                elif has_speed:
                    vf = f"setpts={1.0/speed}*PTS"

                # --- Audio filter chain: atempo + volume ---
                af_parts: list[str] = []
                if has_speed:
                    atempo = _atempo_chain(speed)
                    if atempo:
                        af_parts.append(atempo)
                if has_volume:
                    if not has_segments:
                        af_parts.append(f"volume={volume:.2f}")
                # Per-segment volume overrides using FFmpeg volume expression.
                # When segments exist, we build a single volume filter with an
                # if(between()) expression that picks the right gain for each
                # time range, falling back to the global volume for gaps.
                if has_segments:
                    clip_dur_local = end - start
                    # Build expression: if(between(t,s1,e1),vol1,if(between(t,s2,e2),vol2,...,global))
                    expr = f"{volume:.4f}"  # fallback = global volume
                    for seg in reversed(segments):  # reversed so first segment is outermost if()
                        seg_start = max(0, seg["start"] - start)
                        seg_end = min(clip_dur_local, seg["end"] - start)
                        seg_vol = 0.0 if seg.get("muted", False) else seg.get("volume", 1.0)
                        expr = f"if(between(t\\,{seg_start:.3f}\\,{seg_end:.3f})\\,{seg_vol:.4f}\\,{expr})"
                    af_parts.append(f"volume='{expr}':eval=frame")
                af = ",".join(af_parts) if af_parts else None

                # -t is an OUTPUT option (placed after -i), so it caps
                # the output duration.  When speed != 1.0, the output
                # duration differs from the input duration: a 10s clip at
                # 0.5x produces 20s of output, at 2x produces 5s.
                # Use the speed-adjusted duration so slow-motion clips
                # aren't truncated and fast clips don't have trailing
                # silence.
                output_dur = (end - start) / speed if has_speed else (end - start)
                cmd = [
                    "ffmpeg", "-y",
                    *_gpu_decode_args_for_filter(),
                    "-ss", str(start),
                    "-i", video_path,
                    "-t", str(output_dur),
                ]
                if vf:
                    if is_complex:
                        cmd += ["-filter_complex", vf, "-map", "[out]", "-map", "0:a?"]
                    else:
                        cmd += ["-vf", vf]
                if af:
                    cmd += ["-af", af]
                # When active word highlighting is enabled, ensure at least
                # 30fps output so subtitle color transitions appear smooth.
                # Low-fps source videos (e.g. 24fps) show visible lag because
                # subtitle updates only render at video frame boundaries.
                _aw_enabled = subtitle_settings.get("active_word_enabled", False) if subtitle_settings else False
                if _aw_enabled and subtitles_enabled:
                    cmd += ["-r", "30"]
                cmd += [
                    *_gpu_encode_args(qp, export_quality),
                    "-threads", str(app_settings.FFMPEG_THREADS),
                    "-c:a", "aac",
                    "-avoid_negative_ts", "make_zero",
                ]
                if app_settings.FFMPEG_FASTSTART:
                    cmd += ["-movflags", "+faststart"]
                cmd += ["-progress", "pipe:1"]
                cmd.append(output_path)

            logger.info("FFmpeg export command for clip %s: %s", clip_id, " ".join(cmd))
            logger.info("FFmpeg filter chain for clip %s: %s", clip_id, vf or "(none)")
            await _notify(f"Encoding clip {clip_id} with filters ({filter_desc})...")

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Track encoding progress with ETA via FFmpeg -progress output
            import time as _time
            _enc_start = _time.monotonic()
            if has_seg_speed:
                # Compute expected output duration from per-segment speeds
                _clip_dur = sum((tl["end"] - tl["start"]) / tl["speed"] for tl in timeline)
            elif has_speed:
                _clip_dur = (end - start) / speed
            else:
                _clip_dur = (end - start)
            _last_notify_time = _enc_start
            _current_out_time = 0.0
            _stderr_chunks: list[bytes] = []

            async def _drain_stderr():
                while True:
                    chunk = await proc.stderr.read(8192)
                    if not chunk:
                        break
                    _stderr_chunks.append(chunk)

            _stderr_task = asyncio.create_task(_drain_stderr())

            # Read FFmpeg progress from stdout line by line
            async for _line in proc.stdout:
                _line_str = _line.decode("utf-8", errors="replace").strip()
                if _line_str.startswith("out_time_us="):
                    try:
                        _us = int(_line_str.split("=", 1)[1])
                        if _us > 0:
                            _current_out_time = _us / 1_000_000
                    except (ValueError, IndexError):
                        pass

                _now = _time.monotonic()
                if _now - _last_notify_time >= 2.0:
                    _last_notify_time = _now

                    if cancel_event and cancel_event.is_set():
                        proc.kill()
                        await proc.wait()
                        if os.path.exists(output_path):
                            try:
                                os.unlink(output_path)
                            except OSError:
                                pass
                        raise asyncio.CancelledError("Export cancelled by user")

                    _elapsed_s = _now - _enc_start
                    _elapsed = int(_elapsed_s)
                    if _current_out_time > 0.5 and _elapsed_s > 2 and _clip_dur > 0:
                        _speed = _current_out_time / _elapsed_s
                        _remaining = max(0, _clip_dur - _current_out_time)
                        _eta_s = int(_remaining / _speed) if _speed > 0 else 0
                        _pct = min(99, int(_current_out_time / _clip_dur * 100))
                        if _eta_s >= 60:
                            _eta_str = f"{_eta_s // 60}m {_eta_s % 60}s"
                        else:
                            _eta_str = f"{_eta_s}s"
                        await _notify(
                            f"Encoding clip {clip_id}... {_pct}% ({_elapsed}s elapsed, ~{_eta_str} remaining)"
                        )
                    else:
                        await _notify(f"Encoding clip {clip_id}... ({_elapsed}s elapsed)")

            await proc.wait()
            await _stderr_task
            stderr = b"".join(_stderr_chunks)

            if proc.returncode != 0:
                _stderr_text = stderr.decode(errors="replace")
                # Take the TAIL of stderr — the actual error is at the end,
                # not the FFmpeg version/config preamble at the start.
                raise RuntimeError(f"Clip export failed: {_stderr_text[-3000:]}")
        else:
            # No filters — use stream copy for speed
            await _notify(f"Exporting clip {clip_id} (stream copy — fast mode)")
            cmd = [
                "ffmpeg", "-y",
                "-ss", str(start),
                "-i", video_path,
                "-t", str(end - start),
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
            ]
            if app_settings.FFMPEG_FASTSTART:
                cmd += ["-movflags", "+faststart"]
            cmd.append(output_path)
            logger.info("FFmpeg stream-copy command for clip %s: %s", clip_id, " ".join(cmd))

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()

            if proc.returncode != 0:
                # Retry with re-encoding if stream copy fails
                await _notify(f"Stream copy failed for clip {clip_id}, re-encoding...")
                logger.warning(f"Stream copy failed for clip {clip_id}, re-encoding...")
                fb_qp = QUALITY_PRESETS.get(export_quality, QUALITY_PRESETS["1080p"])
                cmd = [
                    "ffmpeg", "-y",
                    *_gpu_decode_args_for_filter(),
                    "-ss", str(start),
                    "-i", video_path,
                    "-t", str(end - start),
                ]
                # Apply quality scale if source height differs from target.
                # Always normalize SAR to 1:1 to prevent black bars from
                # non-square pixel aspect ratios in the source video.
                fb_target_h = QUALITY_MAX_HEIGHT.get(export_quality, 1080)
                if video_height != fb_target_h:
                    cmd += ["-vf", f"setsar=1,scale=-2:{fb_target_h}"]
                else:
                    cmd += ["-vf", "setsar=1"]
                cmd += [
                    *_gpu_encode_args(fb_qp, export_quality),
                    "-threads", str(app_settings.FFMPEG_THREADS),
                    "-c:a", "aac",
                    "-avoid_negative_ts", "make_zero",
                ]
                if app_settings.FFMPEG_FASTSTART:
                    cmd += ["-movflags", "+faststart"]
                cmd.append(output_path)
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await proc.communicate()
                if proc.returncode != 0:
                    raise RuntimeError(f"Clip export failed: {stderr.decode()[:2000]}")

        # QA validation: verify the exported file is valid
        # Use speed-adjusted duration so the check matches actual output
        if has_seg_speed:
            qa_expected_dur = sum((tl["end"] - tl["start"]) / tl["speed"] for tl in timeline)
        elif has_speed:
            qa_expected_dur = clip_dur / speed
        else:
            qa_expected_dur = clip_dur
        await _validate_export(
            output_path=output_path,
            expected_duration=qa_expected_dur,
            aspect_ratio=aspect_ratio,
            subtitles_enabled=subtitles_enabled,
            export_quality=export_quality,
        )

        logger.info(f"Exported clip {clip_id} to {output_path}")
        return output_path

    finally:
        # Clean up temp ASS file
        if ass_path and os.path.exists(ass_path):
            try:
                os.unlink(ass_path)
            except OSError:
                pass
