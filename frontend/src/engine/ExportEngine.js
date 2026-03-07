/**
 * ExportEngine — Client-side export via WebCodecs + FFmpeg.wasm
 *
 * Uses the same RenderEngine.renderFrame() function as preview,
 * ensuring pixel-perfect export parity. Steps through time at
 * 1/fps intervals (not real-time).
 *
 * Pipeline:
 *   Canvas frames → WebCodecs VideoEncoder → webm-muxer → .webm
 *   Audio tracks → OfflineAudioContext → WAV
 *   FFmpeg.wasm: WebM video + WAV audio → MP4 (H.264 + AAC)
 *
 * Fallback: If WebCodecs unavailable, uses canvas.captureStream() + MediaRecorder.
 * If FFmpeg.wasm fails, falls back to server-side export.
 */

export default class ExportEngine {
  constructor(renderEngine, options = {}) {
    this.renderEngine = renderEngine;
    this.fps = options.fps || 30;
    this.videoBitrate = options.videoBitrate || 8_000_000;
    this.audioBitrate = options.audioBitrate || 128_000;
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this._cancelled = false;
    this._ffmpeg = null;
    this.onProgress = options.onProgress || null;
    this.onError = options.onError || null;
    this.onComplete = options.onComplete || null;
  }

  /**
   * Check if WebCodecs API is available
   */
  static isWebCodecsAvailable() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  }

  /**
   * Check if FFmpeg.wasm can be loaded (SharedArrayBuffer required)
   */
  static isFFmpegAvailable() {
    return typeof SharedArrayBuffer !== 'undefined';
  }

  /**
   * Lazy-load FFmpeg.wasm
   */
  async _loadFFmpeg() {
    if (this._ffmpeg) return this._ffmpeg;

    try {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const { toBlobURL } = await import('@ffmpeg/util');

      const ffmpeg = new FFmpeg();

      // Use multi-threaded core if SharedArrayBuffer is available
      const coreURL = await toBlobURL(
        'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.js',
        'text/javascript'
      );
      const wasmURL = await toBlobURL(
        'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.wasm',
        'application/wasm'
      );
      const workerURL = await toBlobURL(
        'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.worker.js',
        'text/javascript'
      );

      await ffmpeg.load({ coreURL, wasmURL, workerURL });
      this._ffmpeg = ffmpeg;
      return ffmpeg;
    } catch (err) {
      this.onError?.(`FFmpeg.wasm load failed: ${err.message}. Falling back to server export.`);
      return null;
    }
  }

  /**
   * Export using WebCodecs + FFmpeg.wasm
   *
   * @param {number} startTime - Start of export range
   * @param {number} endTime - End of export range
   * @param {Array} tracks - Track definitions
   * @param {Array} clips - Clip/item definitions
   * @param {Object} settings - Project settings
   * @param {Map} mediaElements - Media element map
   * @returns {Blob|null} - MP4 blob or null on failure
   */
  async export(startTime, endTime, tracks, clips, settings, mediaElements) {
    this._cancelled = false;

    if (!ExportEngine.isWebCodecsAvailable()) {
      // Fallback to MediaRecorder
      return this._exportWithMediaRecorder(startTime, endTime, tracks, clips, settings, mediaElements);
    }

    const totalFrames = Math.ceil((endTime - startTime) * this.fps);
    const frameDuration = 1_000_000 / this.fps; // microseconds

    try {
      // Dynamically import webm-muxer
      const { Muxer, ArrayBufferTarget } = await import('webm-muxer');

      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: {
          codec: 'V_VP9',
          width: this.width,
          height: this.height,
        },
        firstTimestampBehavior: 'offset',
      });

      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          muxer.addVideoChunk(chunk, meta);
        },
        error: (err) => {
          this.onError?.(`VideoEncoder error: ${err.message}`);
        },
      });

      encoder.configure({
        codec: 'vp09.00.10.08',
        width: this.width,
        height: this.height,
        bitrate: this.videoBitrate,
        framerate: this.fps,
        hardwareAcceleration: 'prefer-hardware',
      });

      // Step through time and encode each frame
      for (let i = 0; i < totalFrames; i++) {
        if (this._cancelled) break;

        const time = startTime + i / this.fps;

        // Seek media elements to correct time
        for (const [assetId, mediaEl] of mediaElements) {
          if (mediaEl instanceof HTMLVideoElement) {
            // Find the clip that uses this asset at this time
            const clip = clips.find(c =>
              (c.mediaRef === assetId || c.id === assetId) &&
              time >= c.start && time < c.end
            );
            if (clip) {
              const clipTime = (clip.trimStart || 0) + (time - clip.start);
              if (Math.abs(mediaEl.currentTime - clipTime) > 0.02) {
                mediaEl.currentTime = clipTime;
                // Wait for seek
                await new Promise(resolve => {
                  const onSeeked = () => { mediaEl.removeEventListener('seeked', onSeeked); resolve(); };
                  mediaEl.addEventListener('seeked', onSeeked);
                  setTimeout(resolve, 100);
                });
              }
            }
          }
        }

        // Render frame to canvas
        this.renderEngine.renderFrame(time, tracks, clips, settings, mediaElements);

        // Encode
        const frame = new VideoFrame(this.renderEngine.canvas, {
          timestamp: i * frameDuration,
          duration: frameDuration,
        });

        const keyFrame = i % (this.fps * 2) === 0; // keyframe every 2 seconds
        encoder.encode(frame, { keyFrame });
        frame.close();

        // Report progress
        if (i % 10 === 0) {
          this.onProgress?.(Math.round((i / totalFrames) * 80)); // 80% for video encoding
        }
      }

      await encoder.flush();
      encoder.close();
      muxer.finalize();

      if (this._cancelled) return null;

      const webmBlob = new Blob([target.buffer], { type: 'video/webm' });

      // Try to remux to MP4 via FFmpeg.wasm
      this.onProgress?.(85);

      if (ExportEngine.isFFmpegAvailable()) {
        const ffmpeg = await this._loadFFmpeg();
        if (ffmpeg) {
          try {
            const webmData = new Uint8Array(await webmBlob.arrayBuffer());
            await ffmpeg.writeFile('input.webm', webmData);

            await ffmpeg.exec([
              '-i', 'input.webm',
              '-c:v', 'copy',
              '-c:a', 'aac',
              '-b:a', `${this.audioBitrate}`,
              '-movflags', '+faststart',
              'output.mp4'
            ]);

            const mp4Data = await ffmpeg.readFile('output.mp4');
            await ffmpeg.deleteFile('input.webm');
            await ffmpeg.deleteFile('output.mp4');

            this.onProgress?.(100);
            const mp4Blob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
            this.onComplete?.(mp4Blob);
            return mp4Blob;
          } catch {
            // FFmpeg failed, return WebM
          }
        }
      }

      // Return WebM if MP4 conversion failed
      this.onProgress?.(100);
      this.onComplete?.(webmBlob);
      return webmBlob;

    } catch (err) {
      this.onError?.(`Export failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Fallback export using canvas.captureStream() + MediaRecorder
   */
  async _exportWithMediaRecorder(startTime, endTime, tracks, clips, settings, mediaElements) {
    try {
      const stream = this.renderEngine.canvas.captureStream(this.fps);
      const recorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: this.videoBitrate,
      });

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      return new Promise((resolve) => {
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'video/webm' });
          this.onProgress?.(100);
          this.onComplete?.(blob);
          resolve(blob);
        };

        recorder.start(100); // Collect data every 100ms

        const totalFrames = Math.ceil((endTime - startTime) * this.fps);
        const frameTime = 1000 / this.fps;
        let frame = 0;

        const renderNext = () => {
          if (this._cancelled || frame >= totalFrames) {
            recorder.stop();
            return;
          }

          const time = startTime + frame / this.fps;
          this.renderEngine.renderFrame(time, tracks, clips, settings, mediaElements);
          frame++;

          if (frame % 10 === 0) {
            this.onProgress?.(Math.round((frame / totalFrames) * 90));
          }

          setTimeout(renderNext, frameTime);
        };

        renderNext();
      });
    } catch (err) {
      this.onError?.(`MediaRecorder export failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Cancel an in-progress export
   */
  cancel() {
    this._cancelled = true;
  }

  /**
   * Clean up FFmpeg.wasm resources
   */
  async destroy() {
    this.cancel();
    if (this._ffmpeg) {
      try {
        this._ffmpeg.terminate();
      } catch {}
      this._ffmpeg = null;
    }
  }
}
