/**
 * Client-side GPU detection via WebGPU, WebGL, and WebCodecs.
 * Detects all available GPUs in the user's browser and checks
 * hardware encoding capabilities.
 */

export async function detectClientGPUs() {
  const gpus = [];

  // ── WebGPU Detection ──
  if (navigator.gpu) {
    for (const powerPref of ['high-performance', 'low-power']) {
      try {
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: powerPref,
        });
        if (!adapter) continue;

        const info = adapter.info || {};
        const limits = adapter.limits || {};
        const features = [...(adapter.features || [])];

        // Avoid duplicates (same vendor+architecture = same physical GPU)
        const gpuId = `${info.vendor}-${info.architecture}-${info.device}`;
        if (gpus.some(g => g.id === gpuId)) continue;

        gpus.push({
          id: gpuId,
          name: _formatGPUName(info),
          vendor: info.vendor || 'unknown',
          architecture: info.architecture || '',
          device: info.device || '',
          type: powerPref === 'high-performance' ? 'discrete' : 'integrated',
          backend: 'webgpu',
          hasFP16: features.includes('shader-f16'),
          hasTimestampQuery: features.includes('timestamp-query'),
          maxBufferSize: limits.maxBufferSize || 0,
          maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize || 0,
          estimatedVRAM_MB: Math.round((limits.maxBufferSize || 0) / (1024 * 1024)),
          features,
          powerPreference: powerPref,
          whisperCapable: features.includes('shader-f16') && (limits.maxStorageBufferBindingSize || 0) >= 128 * 1024 * 1024,
        });
      } catch (e) {
        console.warn(`WebGPU adapter request (${powerPref}) failed:`, e);
      }
    }
  }

  // ── WebGL Fallback (for GPU name identification) ──
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        // Enrich existing WebGPU entries with more readable WebGL renderer name
        for (const gpu of gpus) {
          if (!gpu.webglRenderer) {
            gpu.webglRenderer = renderer;
            gpu.webglVendor = vendor;
            if (renderer && (
              renderer.includes('RTX') || renderer.includes('GTX') ||
              renderer.includes('Radeon') || renderer.includes('Arc') ||
              renderer.includes('Apple M') || renderer.includes('Apple GPU')
            )) {
              // Extract clean GPU name from ANGLE renderer strings
              // e.g. "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, ...)" → "Apple M3 Pro"
              const appleMatch = renderer.match(/Apple (M\d[\w\s]*?)(?:,|$)/);
              gpu.name = appleMatch ? `Apple ${appleMatch[1].trim()}` : renderer;
            }
          }
        }
        // If no WebGPU adapters found, add a WebGL-only entry
        if (gpus.length === 0) {
          // Extract clean name from ANGLE renderer for Apple Silicon
          let gpuName = renderer || 'Unknown GPU';
          const appleMatch = renderer && renderer.match(/Apple (M\d[\w\s]*?)(?:,|$)/);
          if (appleMatch) gpuName = `Apple ${appleMatch[1].trim()}`;
          gpus.push({
            id: `webgl-${vendor}-${renderer}`,
            name: gpuName,
            vendor: vendor || 'unknown',
            architecture: '',
            device: '',
            type: 'unknown',
            backend: 'webgl-only',
            hasFP16: false,
            hasTimestampQuery: false,
            maxBufferSize: 0,
            maxStorageBufferBindingSize: 0,
            estimatedVRAM_MB: 0,
            features: [],
            powerPreference: null,
            whisperCapable: false,
            webglRenderer: renderer,
            webglVendor: vendor,
          });
        }
      }
    }
  } catch (e) {
    console.warn('WebGL detection failed:', e);
  }

  return gpus;
}

/**
 * Check WebCodecs hardware encoding support for H.264 and HEVC.
 */
export async function detectWebCodecsCapabilities() {
  const caps = {
    h264HardwareEncode: false,
    hevcHardwareEncode: false,
    h264Decode: false,
    hevcDecode: false,
  };

  if (typeof VideoEncoder === 'undefined') return caps;

  // H.264 hardware encode check
  try {
    const h264Config = {
      codec: 'avc1.640028',
      width: 1920, height: 1080,
      bitrate: 5_000_000, framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
    };
    const result = await VideoEncoder.isConfigSupported(h264Config);
    caps.h264HardwareEncode = result.supported === true;
  } catch { /* unsupported */ }

  // HEVC hardware encode check
  try {
    const hevcConfig = {
      codec: 'hev1.1.6.L120.B0',
      width: 1920, height: 1080,
      bitrate: 5_000_000, framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
    };
    const result = await VideoEncoder.isConfigSupported(hevcConfig);
    caps.hevcHardwareEncode = result.supported === true;
  } catch { /* unsupported */ }

  // Decode checks
  try {
    const h264Dec = { codec: 'avc1.640028', hardwareAcceleration: 'prefer-hardware' };
    const result = await VideoDecoder.isConfigSupported(h264Dec);
    caps.h264Decode = result.supported === true;
  } catch { /* unsupported */ }

  try {
    const hevcDec = { codec: 'hev1.1.6.L120.B0', hardwareAcceleration: 'prefer-hardware' };
    const result = await VideoDecoder.isConfigSupported(hevcDec);
    caps.hevcDecode = result.supported === true;
  } catch { /* unsupported */ }

  return caps;
}

function _formatGPUName(info) {
  if (info.device && info.device !== '') return info.device;
  if (info.architecture) return `${info.vendor || 'GPU'} (${info.architecture})`;
  return info.vendor || 'Unknown GPU';
}

/**
 * Full client GPU capability scan — call once on mount.
 */
export async function scanClientGPU() {
  const gpus = await detectClientGPUs();
  const webcodecs = await detectWebCodecsCapabilities();

  return {
    webgpuSupported: !!navigator.gpu,
    webcodecSupported: typeof VideoEncoder !== 'undefined',
    gpus,
    webcodecs,
    recommended: gpus.find(g => g.type === 'discrete') || gpus[0] || null,
  };
}
