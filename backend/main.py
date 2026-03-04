import os
import logging
import logging.handlers
import subprocess
import threading

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response

from backend.routers import upload, jobs, clips, fonts, presets, settings as settings_router, ws
from backend.routers import agent as agent_router
from backend.routers.api_v1 import router as api_v1_router

LOG_FILE = "/data/logs/app.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# Also write all logs to a file so they can be exported from the UI
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
_file_handler = logging.handlers.RotatingFileHandler(
    LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8",
)
_file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
logging.getLogger().addHandler(_file_handler)

logger = logging.getLogger("clipai")

app = FastAPI(title="ClipAI", version="1.0.0")


@app.on_event("startup")
async def _startup_preload():
    """Preload the Whisper model in a background thread so the first job starts fast."""
    from backend.services.transcription import preload_model
    threading.Thread(target=preload_model, daemon=True).start()

    # Pull Ollama models in the background only if Ollama is in the fallback chain.
    from backend.config import settings as cfg
    if "ollama" in cfg.active_provider_chain:
        def _pull_ollama_models():
            import httpx
            host = cfg.OLLAMA_HOST
            models = [cfg.OLLAMA_VISION_MODEL, cfg.OLLAMA_TEXT_MODEL]
            for extra in ("llava", "llama3.2:3b"):
                if extra not in models:
                    models.append(extra)
            for model in models:
                try:
                    logger.info("Background pull: requesting %s from Ollama...", model)
                    resp = httpx.post(
                        f"{host}/api/pull",
                        json={"name": model},
                        timeout=httpx.Timeout(connect=10, read=1800, write=10, pool=10),
                    )
                    if resp.status_code == 200:
                        logger.info("Background pull: %s ready", model)
                    else:
                        logger.warning("Background pull: %s returned %d", model, resp.status_code)
                except Exception as exc:
                    logger.warning("Background pull: %s failed (%s)", model, exc)
        threading.Thread(target=_pull_ollama_models, daemon=True, name="ollama-bg-pull").start()
    else:
        logger.info("Ollama not in fallback chain — skipping background model pull")

# Register API routers
app.include_router(upload.router)
app.include_router(jobs.router)
app.include_router(clips.router)
app.include_router(fonts.router)
app.include_router(presets.router)
app.include_router(settings_router.router)
app.include_router(ws.router)
app.include_router(agent_router.router)
app.include_router(api_v1_router)

# Mount MCP server at /mcp (if mcp package is available)
try:
    from mcp.server.fastmcp import FastMCP

    clipai_mcp = FastMCP(
        name="ClipAI",
        stateless_http=True,
        description=(
            "Video intelligence platform — upload videos, analyze content, "
            "generate viral clips with subtitles and SEO metadata"
        ),
    )

    # Import and register MCP tools
    from backend.mcp_tools import register_tools
    register_tools(clipai_mcp)

    app.mount("/mcp", clipai_mcp.streamable_http_app())
    logger.info("MCP server mounted at /mcp")
except ImportError:
    logger.warning("mcp package not installed — MCP endpoint disabled. Install with: pip install 'mcp>=1.8.0'")
except Exception as exc:
    logger.warning("Failed to mount MCP server: %s", exc)

# Ensure data dirs exist
for d in ["/data/uploads", "/data/outputs", "/data/logs", "/data/fonts"]:
    os.makedirs(d, exist_ok=True)

# Ensure fontconfig knows about /data/fonts so FFmpeg/libass can discover
# custom uploaded fonts by family name.  The Dockerfile also sets this up,
# but this covers non-Docker and fresh environments.
_FC_CONF = "/etc/fonts/conf.d/99-custom-fonts.conf"
if not os.path.isfile(_FC_CONF):
    try:
        os.makedirs(os.path.dirname(_FC_CONF), exist_ok=True)
        with open(_FC_CONF, "w") as f:
            f.write('<?xml version="1.0"?>\n'
                    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n'
                    '<fontconfig><dir>/data/fonts</dir></fontconfig>\n')
        subprocess.run(["fc-cache", "-f"], capture_output=True, timeout=10)
        logger.info("Created fontconfig config for /data/fonts")
    except (PermissionError, OSError, FileNotFoundError) as exc:
        logger.warning("Could not create fontconfig config (%s) — custom fonts "
                       "will still work via fontsdir in FFmpeg filter", exc)

# Symlink system-installed fonts into /data/fonts/ so they are always available
# to FFmpeg's ass filter via the fontsdir parameter.  The ass filter's fontsdir
# is the *only* guaranteed font discovery path — fontconfig may silently fail
# in some libass builds, causing all fonts to fall back to DejaVu Sans.
from backend.routers.fonts import SYSTEM_FONT_PATHS
_symlinked = 0
for _fname, _syspath in SYSTEM_FONT_PATHS.items():
    _link = os.path.join("/data/fonts", _fname)
    if os.path.isfile(_syspath) and not os.path.exists(_link):
        try:
            os.symlink(_syspath, _link)
            _symlinked += 1
        except OSError:
            pass
if _symlinked:
    logger.info("Symlinked %d system fonts into /data/fonts for FFmpeg fontsdir", _symlinked)


@app.get("/api/files/{job_id}/{path:path}")
async def serve_file(job_id: str, path: str, request: Request):
    """Serve video files and exported clips with range request support."""
    # Check uploads first, then outputs
    file_path = None
    candidates = [
        os.path.join("/data/uploads", job_id, path),
        os.path.join("/data/outputs", job_id, path),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            file_path = candidate
            break

    if not file_path:
        return Response(status_code=404, content="File not found")

    file_size = os.path.getsize(file_path)
    content_type = "video/mp4"
    if file_path.endswith(".jpg") or file_path.endswith(".jpeg"):
        content_type = "image/jpeg"
    elif file_path.endswith(".png"):
        content_type = "image/png"
    elif file_path.endswith(".webm"):
        content_type = "video/webm"
    elif file_path.endswith(".mov"):
        content_type = "video/quicktime"

    # Handle Range requests for video seeking
    range_header = request.headers.get("range")
    if range_header:
        ranges = range_header.replace("bytes=", "").split("-")
        start = int(ranges[0]) if ranges[0] else 0
        end = int(ranges[1]) if ranges[1] else file_size - 1
        end = min(end, file_size - 1)
        content_length = end - start + 1

        with open(file_path, "rb") as f:
            f.seek(start)
            data = f.read(content_length)

        return Response(
            content=data,
            status_code=206,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
                "Content-Type": content_type,
            },
        )

    # For clip files, force browser download instead of inline playback
    if "/clips/" in path:
        return FileResponse(
            file_path,
            media_type=content_type,
            filename=os.path.basename(file_path),
        )

    return FileResponse(file_path, media_type=content_type)


# Serve frontend static files
static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
if os.path.isdir(static_dir):
    app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")

    @app.get("/{path:path}")
    async def serve_spa(path: str):
        # Serve index.html for all non-API, non-asset routes (SPA routing)
        file_path = os.path.join(static_dir, path)
        if path and os.path.isfile(file_path):
            return FileResponse(file_path)

        # Inject site customisation (title, favicon) into index.html so
        # user settings persist visually across restarts without a flash.
        index_path = os.path.join(static_dir, "index.html")
        try:
            from backend.routers.settings import _load_site_config
            cfg = _load_site_config()
            if cfg.get("title") or cfg.get("favicon"):
                with open(index_path, "r") as f:
                    html = f.read()
                if cfg.get("title"):
                    html = html.replace(
                        "<title>ClipAI \u2014 Video Intelligence</title>",
                        f"<title>{cfg['title']}</title>",
                    )
                if cfg.get("favicon"):
                    import re
                    html = re.sub(
                        r'<link rel="icon"[^>]*/>',
                        f'<link rel="icon" href="/api/site-uploads/{cfg["favicon"]}" />',
                        html,
                    )
                return Response(content=html, media_type="text/html")
        except Exception:
            pass
        return FileResponse(index_path)
else:
    @app.get("/")
    async def root():
        return {"message": "ClipAI API running. Frontend not built yet."}
