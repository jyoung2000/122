## Stage 1: Build frontend with Node
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

## Stage 2: Runtime
FROM python:3.11-slim

# Make NVIDIA GPUs visible when passed through with --gpus
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

# Install system dependencies (ca-certificates ensures HTTPS model downloads work)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    git \
    ca-certificates \
    fontconfig \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    fonts-liberation2 \
    unzip \
    gnupg2 \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install CUDA runtime libraries so GPU passthrough works without the full GPU image.
# This adds ~600MB but enables Whisper GPU acceleration when an NVIDIA GPU is passed
# through via docker --gpus or docker-compose deploy.resources.reservations.
# The keyring package provides the repo GPG key; we only install the minimal runtime.
RUN apt-get update && apt-get install -y --no-install-recommends wget && \
    wget -qO /tmp/cuda-keyring.deb \
      https://developer.download.nvidia.com/compute/cuda/repos/debian12/x86_64/cuda-keyring_1.1-1_all.deb && \
    dpkg -i /tmp/cuda-keyring.deb && rm /tmp/cuda-keyring.deb && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      cuda-cudart-12-3 \
      libcublas-12-3 \
      libcublaslt-12-3 \
      libcudnn8 \
      libcufft-12-3 \
    && rm -rf /var/lib/apt/lists/*

# Ensure CUDA libraries are on LD_LIBRARY_PATH for ctranslate2/faster-whisper
ENV LD_LIBRARY_PATH=/usr/local/cuda-12.3/lib64:/usr/local/cuda/lib64:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}
ENV PATH=/usr/local/cuda-12.3/bin:${PATH}

# Install DM Sans font (default subtitle font) so FFmpeg/libass can find it
# Downloaded directly from the canonical Google Fonts GitHub repo (stable raw URLs)
RUN mkdir -p /usr/share/fonts/truetype/dmsans && \
    curl -fsSL -o /usr/share/fonts/truetype/dmsans/DMSans.ttf \
      "https://github.com/google/fonts/raw/main/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf" && \
    curl -fsSL -o /usr/share/fonts/truetype/dmsans/DMSans-Italic.ttf \
      "https://github.com/google/fonts/raw/main/ofl/dmsans/DMSans-Italic%5Bopsz%2Cwght%5D.ttf" && \
    fc-cache -f -v

# Install popular Google Fonts for subtitle use (variable + static weight files)
RUN mkdir -p /usr/share/fonts/truetype/google-fonts && \
    cd /usr/share/fonts/truetype/google-fonts && \
    curl -fsSL -o Montserrat.ttf "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" && \
    curl -fsSL -o OpenSans.ttf "https://github.com/google/fonts/raw/main/ofl/opensans/OpenSans%5Bwdth%2Cwght%5D.ttf" && \
    curl -fsSL -o Roboto.ttf "https://github.com/google/fonts/raw/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf" && \
    curl -fsSL -o Poppins-Regular.ttf "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Regular.ttf" && \
    curl -fsSL -o Poppins-Bold.ttf "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf" && \
    curl -fsSL -o Inter.ttf "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" && \
    curl -fsSL -o Nunito.ttf "https://github.com/google/fonts/raw/main/ofl/nunito/Nunito%5Bwght%5D.ttf" && \
    curl -fsSL -o Lato-Regular.ttf "https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf" && \
    curl -fsSL -o Lato-Bold.ttf "https://github.com/google/fonts/raw/main/ofl/lato/Lato-Bold.ttf" && \
    curl -fsSL -o Oswald.ttf "https://github.com/google/fonts/raw/main/ofl/oswald/Oswald%5Bwght%5D.ttf" && \
    curl -fsSL -o PlayfairDisplay.ttf "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" && \
    curl -fsSL -o BebasNeue-Regular.ttf "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf" && \
    fc-cache -f -v

# Register /data/fonts with fontconfig so libass picks up custom fonts
RUN mkdir -p /data/fonts && \
    echo '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>/data/fonts</dir></fontconfig>' \
    > /etc/fonts/conf.d/99-custom-fonts.conf

WORKDIR /app

# Install Python dependencies + CUDA support for faster-whisper
COPY backend/requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir nvidia-cublas-cu12 nvidia-cudnn-cu12==9.* || true

# Copy backend source
COPY backend/ ./backend/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist ./static

EXPOSE 1353

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "1353", "--workers", "1"]
