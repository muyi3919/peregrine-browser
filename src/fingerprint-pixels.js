'use strict';

/**
 * An explicit JavaScript compatibility layer, not a native Chromium patch.
 * Inject before page/worker scripts and disable the fork's native Canvas noise.
 * RGBA8 readbacks use a fixed, versioned coordinate hash; source bitmaps are
 * never written. Float/HDR pixels, WebGL FBOs and PBOs retain native behavior.
 */
const PIXEL_ALGORITHM = 'peregrine-pixels-v1';

function installFingerprintPixels(seed, options) {
  'use strict';
  options ||= {};
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('Fingerprint pixel seed must be a uint32 integer.');
  }
  const algorithm = 'peregrine-pixels-v1';
  const stableReadback = options.stableReadback !== false;
  const marker = Symbol.for('peregrine.fingerprintPixels.v1');
  if (globalThis[marker]) {
    const installed = globalThis[marker];
    if (installed.seed !== seed || installed.stableReadback !== stableReadback) {
      throw new Error('A different fingerprint pixel policy is already installed in this realm.');
    }
    return installed;
  }

  const apply = Reflect.apply;
  const imul = Math.imul;
  const U8 = Uint8Array;
  const U8Clamped = Uint8ClampedArray;
  const BlobClass = globalThis.Blob;
  const PromiseClass = Promise;
  const contexts = new WeakMap();
  const html = globalThis.HTMLCanvasElement?.prototype;
  const offscreen = globalThis.OffscreenCanvas?.prototype;
  const html2d = globalThis.CanvasRenderingContext2D?.prototype;
  const offscreen2d = globalThis.OffscreenCanvasRenderingContext2D?.prototype;
  const htmlGetContext = html?.getContext;
  const offscreenGetContext = offscreen?.getContext;
  const htmlWidth = html && Object.getOwnPropertyDescriptor(html, 'width')?.get;
  const htmlHeight = html && Object.getOwnPropertyDescriptor(html, 'height')?.get;
  const offscreenWidth = offscreen && Object.getOwnPropertyDescriptor(offscreen, 'width')?.get;
  const offscreenHeight = offscreen && Object.getOwnPropertyDescriptor(offscreen, 'height')?.get;
  const originalDataURL = html?.toDataURL;
  const originalToBlob = html?.toBlob;
  const originalConvertToBlob = offscreen?.convertToBlob;
  const createElement = globalThis.document?.createElement;
  const OffscreenClass = globalThis.OffscreenCanvas;
  const original2d = new Map();
  for (const proto of [html2d, offscreen2d]) {
    if (proto && !original2d.has(proto)) original2d.set(proto, {
      getImageData: proto.getImageData,
      putImageData: proto.putImageData,
      drawImage: proto.drawImage,
      getContextAttributes: proto.getContextAttributes,
      canvas: Object.getOwnPropertyDescriptor(proto, 'canvas')?.get,
    });
  }

  // Fixed unsigned 32-bit arithmetic, independent of process, call count,
  // platform std::hash, timestamps or cryptographic random state.
  function bit(x, y, channel) {
    let h = (seed ^ 0x50475231) >>> 0;
    h = imul(h ^ (x >>> 0), 0x9e3779b1) >>> 0;
    h = imul(h ^ (y >>> 0), 0x85ebca77) >>> 0;
    h = imul(h ^ channel, 0xc2b2ae3d) >>> 0;
    h ^= h >>> 16;
    h = imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    h = imul(h, 0x846ca68b) >>> 0;
    return (h ^ (h >>> 16)) & 1;
  }

  function noise(data, width, height, x, y, stride = width * 4, start = 0, flipHeight = 0, bounds) {
    for (let row = 0; row < height; row++) {
      const sourceY = y + row;
      const canonicalY = flipHeight ? flipHeight - sourceY - 1 : sourceY;
      for (let column = 0; column < width; column++) {
        const sourceX = x + column;
        if (bounds && (sourceX < 0 || sourceY < 0 || sourceX >= bounds[0] || sourceY >= bounds[1])) continue;
        const at = start + row * stride + column * 4;
        // Keep transparent/out-of-bounds black and alpha unchanged. Replacing
        // (rather than toggling) the LSB also makes this transform idempotent.
        if (data[at + 3] === 0) continue;
        for (let channel = 0; channel < 3; channel++) {
          data[at + channel] = (data[at + channel] & 254) | bit(sourceX, canonicalY, channel);
        }
      }
    }
    return data;
  }

  function replace(proto, name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor && typeof descriptor.value === 'function') {
      Object.defineProperty(proto, name, { ...descriptor, value });
    }
  }
  function long(value) {
    const number = +value; // WebIDL ToNumber: unlike Number(), rejects BigInt.
    return Number.isFinite(number) && number !== 0 ? Math.trunc(number) >> 0 : 0;
  }
  function domString(value) {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    return String(value); // DOMString uses the string hint, not default hint.
  }
  function dimensions(canvas, isOffscreen) {
    return [apply(isOffscreen ? offscreenWidth : htmlWidth, canvas, []),
      apply(isOffscreen ? offscreenHeight : htmlHeight, canvas, [])];
  }
  function apiFor(context) {
    for (const [proto, api] of original2d) {
      if (proto.isPrototypeOf(context)) return api;
    }
    return null;
  }
  function supportedCanvas(canvas) {
    const known = contexts.get(canvas);
    if (known?.api?.getContextAttributes) {
      const attributes = apply(known.api.getContextAttributes, known.context, []);
      return attributes.colorSpace === 'srgb' && (!attributes.colorType || attributes.colorType === 'unorm8');
    }
    if (known?.id === 'webgl' || known?.id === 'webgl2') {
      return !known.context.drawingBufferColorSpace || known.context.drawingBufferColorSpace === 'srgb';
    }
    return true;
  }

  function patchGetContext(proto, original, isOffscreen) {
    if (!proto || !original) return;
    replace(proto, 'getContext', function getContext(contextId, contextOptions) {
      if (!arguments.length) return apply(original, this, arguments);
      dimensions(this, isOffscreen); // Brand check precedes argument conversion.
      const id = domString(contextId);
      let settings = contextOptions;
      if (id === '2d' && stableReadback) {
        // Native dictionary conversion still reads every other option once.
        // Its willReadFrequently getter is also read once before overriding it.
        if (settings !== null && (typeof settings === 'object' || typeof settings === 'function')) {
          const supplied = settings;
          // An empty Proxy target also accepts frozen option dictionaries;
          // overriding a frozen target's own false property violates invariants.
          settings = new Proxy({}, { get(_target, key) {
            const value = Reflect.get(supplied, key, supplied);
            return key === 'willReadFrequently' ? true : value;
          } });
        } else if (settings == null) settings = { willReadFrequently: true };
      }
      const context = apply(original, this, [id, settings]);
      if (context) contexts.set(this, { id, context, api: apiFor(context) });
      return context;
    });
  }
  patchGetContext(html, htmlGetContext, false);
  patchGetContext(offscreen, offscreenGetContext, true);

  for (const [proto, api] of original2d) {
    replace(proto, 'getImageData', function getImageData(sx, sy, sw, sh) {
      if (arguments.length < 4) return apply(api.getImageData, this, arguments);
      const args = Array.from(arguments);
      const coordinates = [];
      for (let index = 0; index < 4; index++) {
        const supplied = args[index];
        // Let native WebIDL own brand checks, conversion order, EnforceRange
        // and exceptions. Cache the sole user-visible ToNumber conversion.
        args[index] = { [Symbol.toPrimitive]() {
          const value = +supplied;
          coordinates[index] = Math.trunc(value);
          return value;
        } };
      }
      // Exactly one native read. Settings and their getters remain native.
      const image = apply(api.getImageData, this, args);
      if (image.data instanceof U8Clamped && (!image.colorSpace || image.colorSpace === 'srgb')
        && image.data.length === image.width * image.height * 4) {
        const left = coordinates[0] + (coordinates[2] < 0 ? coordinates[2] : 0);
        const top = coordinates[1] + (coordinates[3] < 0 ? coordinates[3] : 0);
        noise(image.data, image.width, image.height, left, top);
      }
      return image;
    });
  }

  function scratch(width, height, isOffscreen) {
    const canvas = !isOffscreen && createElement
      ? apply(createElement, globalThis.document, ['canvas']) : new OffscreenClass(width, height);
    if (!isOffscreen && createElement) { canvas.width = width; canvas.height = height; }
    const original = !isOffscreen && createElement ? htmlGetContext : offscreenGetContext;
    const context = apply(original, canvas, ['2d', { willReadFrequently: true, colorSpace: 'srgb' }]);
    return { canvas, context, api: apiFor(context) };
  }
  function snapshot(canvas, isOffscreen, width, height) {
    const known = contexts.get(canvas);
    let image;
    if (known?.api) {
      image = apply(known.api.getImageData, known.context, [0, 0, width, height, { colorSpace: 'srgb', pixelFormat: 'rgba-unorm8' }]);
    } else {
      // drawImage propagates origin taint. Reading this copy must still throw
      // SecurityError; there is no network fetch or origin-clean workaround.
      const copy = scratch(width, height, isOffscreen);
      apply(copy.api.drawImage, copy.context, [canvas, 0, 0]);
      image = apply(copy.api.getImageData, copy.context, [0, 0, width, height]);
    }
    noise(image.data, width, height, 0, 0);
    return image;
  }
  function encodedCopy(image, isOffscreen) {
    const copy = scratch(image.width, image.height, isOffscreen);
    apply(copy.api.putImageData, copy.context, [image, 0, 0]);
    return copy.canvas;
  }

  // A deterministic lossless RGBA8 PNG avoids a second premultiply/unpremultiply
  // round trip on a scratch bitmap. In particular, semitransparent raw readback
  // equals decoded PNG bytes. Stored DEFLATE blocks trade file size for clarity.
  let crcTable;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
        crcTable[index] = value >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  }
  function uint32(bytes, at, value) {
    bytes[at] = value >>> 24; bytes[at + 1] = value >>> 16;
    bytes[at + 2] = value >>> 8; bytes[at + 3] = value;
  }
  function chunk(type, bytes) {
    const result = new U8(bytes.length + 12);
    uint32(result, 0, bytes.length);
    for (let index = 0; index < 4; index++) result[4 + index] = type.charCodeAt(index);
    result.set(bytes, 8);
    uint32(result, result.length - 4, crc32(result.subarray(4, result.length - 4)));
    return result;
  }
  function png(image) {
    const rowBytes = image.width * 4;
    const raw = new U8((rowBytes + 1) * image.height);
    for (let row = 0; row < image.height; row++) raw.set(image.data.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
    const blocks = Math.ceil(raw.length / 65535);
    const zlib = new U8(2 + raw.length + blocks * 5 + 4);
    zlib[0] = 0x78; zlib[1] = 0x01;
    let target = 2;
    let sumA = 1, sumB = 0;
    for (let source = 0; source < raw.length;) {
      const count = Math.min(65535, raw.length - source);
      zlib[target++] = source + count === raw.length ? 1 : 0;
      zlib[target++] = count & 255; zlib[target++] = count >>> 8;
      zlib[target++] = (~count) & 255; zlib[target++] = ((~count) >>> 8) & 255;
      zlib.set(raw.subarray(source, source + count), target);
      target += count;
      for (let index = source; index < source + count; index++) {
        sumA = (sumA + raw[index]) % 65521; sumB = (sumB + sumA) % 65521;
      }
      source += count;
    }
    uint32(zlib, target, (sumB << 16) | sumA);
    const header = new U8(13); uint32(header, 0, image.width); uint32(header, 4, image.height);
    header[8] = 8; header[9] = 6; // 8-bit RGBA, noninterlaced.
    const parts = [new U8([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
      chunk('sRGB', new U8([0])), chunk('IDAT', zlib), chunk('IEND', new U8(0))];
    const result = new U8(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  function dataURL(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = 'data:image/png;base64,';
    // Limit intermediate strings, and avoid argument-spread stack limits.
    const pieces = [];
    let piece = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const n = (bytes[index] << 16) | ((bytes[index + 1] || 0) << 8) | (bytes[index + 2] || 0);
      piece += alphabet[n >>> 18] + alphabet[(n >>> 12) & 63]
        + (index + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=')
        + (index + 2 < bytes.length ? alphabet[n & 63] : '=');
      if (piece.length >= 16384) { pieces.push(piece); piece = ''; }
    }
    pieces.push(piece);
    return result + pieces.join('');
  }
  function lossless(type) { return type.toLowerCase() !== 'image/jpeg' && type.toLowerCase() !== 'image/webp'; }

  if (html && originalDataURL) replace(html, 'toDataURL', function toDataURL(type, quality) {
    dimensions(this, false); // Receiver validation before user string conversion.
    const format = type === undefined ? 'image/png' : domString(type);
    const [width, height] = dimensions(this, false); // Conversion may resize/draw.
    if (!supportedCanvas(this)) return apply(originalDataURL, this, [format, quality]);
    if (!width || !height) return apply(originalDataURL, this, [format, quality]);
    const image = snapshot(this, false, width, height);
    if (lossless(format)) return dataURL(png(image));
    return apply(originalDataURL, encodedCopy(image, false), [format, quality]);
  });
  if (html && originalToBlob) replace(html, 'toBlob', function toBlob(callback, type, quality) {
    if (typeof callback !== 'function') return apply(originalToBlob, this, arguments);
    dimensions(this, false);
    const format = type === undefined ? 'image/png' : domString(type);
    const [width, height] = dimensions(this, false);
    if (!supportedCanvas(this)) return apply(originalToBlob, this, [callback, format, quality]);
    if (!width || !height) return apply(originalToBlob, this, [callback, format, quality]);
    const image = snapshot(this, false, width, height);
    const copy = encodedCopy(image, false);
    if (!lossless(format)) return apply(originalToBlob, copy, [callback, format, quality]);
    const blob = new BlobClass([png(image)], { type: 'image/png' });
    // Use the native serialization task to invoke callbacks and report thrown
    // callback exceptions. Do not turn user exceptions into a null Blob.
    return apply(originalToBlob, copy, [function serialized() { apply(callback, undefined, [blob]); }, 'image/png']);
  });
  if (offscreen && originalConvertToBlob) replace(offscreen, 'convertToBlob', function convertToBlob(encodeOptions) {
    // The native operation owns dictionary conversion and rejects detached,
    // tainted and zero-sized sources. This validation promise is also the task
    // boundary; copy our pixels synchronously so later drawing cannot race it.
    try { dimensions(this, true); } catch { return apply(originalConvertToBlob, this, arguments); }
    if (!supportedCanvas(this)) return apply(originalConvertToBlob, this, arguments);
    let normalized = encodeOptions;
    if (encodeOptions !== undefined && encodeOptions !== null && typeof encodeOptions !== 'object' && typeof encodeOptions !== 'function') {
      return apply(originalConvertToBlob, this, arguments);
    }
    try {
      const quality = encodeOptions?.quality;
      const convertedQuality = quality === undefined ? undefined : +quality;
      const type = encodeOptions?.type;
      normalized = { ...(convertedQuality === undefined ? {} : { quality: convertedQuality }), type: type === undefined ? 'image/png' : domString(type) };
    } catch (error) { return PromiseClass.reject(error); }
    const validation = apply(originalConvertToBlob, this, [normalized]);
    if (!supportedCanvas(this)) return validation;
    let image;
    try {
      const [width, height] = dimensions(this, true);
      if (!width || !height) return validation;
      image = snapshot(this, true, width, height);
    } catch (error) {
      // Consume the validation rejection while returning the original native
      // failure when possible; never grant access to a tainted source.
      return validation.then(() => { throw error; });
    }
    if (lossless(normalized.type)) {
      try {
        const blob = new BlobClass([png(image)], { type: 'image/png' });
        return validation.then(() => blob);
      } catch (error) { return validation.then(() => { throw error; }); }
    }
    return validation.then(() => apply(originalConvertToBlob, encodedCopy(image, true), [normalized]));
  });

  for (const proto of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
    if (!proto || !Object.hasOwn(proto, 'readPixels')) continue;
    const original = proto.readPixels;
    const getParameter = proto.getParameter;
    const contextLost = proto.isContextLost;
    const isWebGL2 = proto === globalThis.WebGL2RenderingContext?.prototype;
    replace(proto, 'readPixels', function readPixels(x, y, width, height, format, type, destination, destinationOffset) {
      const result = apply(original, this, arguments);
      // Unsupported overloads and custom coercion objects are forwarded exactly
      // once. No getError(), binding changes, second read or GPU-buffer writes.
      if (arguments.length < 7 || !ArrayBuffer.isView(destination)
        || !['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(Object.prototype.toString.call(destination))
        || [x, y, width, height, format, type].some(value => typeof value !== 'number')
        || (isWebGL2 && destinationOffset !== undefined && typeof destinationOffset !== 'number')) return result;
      const px = long(x), py = long(y), w = long(width), h = long(height);
      if (format !== 0x1908 || type !== 0x1401 || w <= 0 || h <= 0
        || apply(contextLost, this, [])) return result;
      const parameter = name => apply(getParameter, this, [name]);
      // FBO/internal formats and PBO paths need separate, explicitly validated
      // policies. Never touch their output under a guessed RGBA8 layout.
      if (parameter(isWebGL2 ? 0x8caa : 0x8ca6) !== null) return result;
      if (isWebGL2 && (parameter(0x88ed) !== null || parameter(0x0c02) !== 0x0405)) return result;
      if (parameter(0x8b9b) !== 0x1908 || parameter(0x8b9a) !== 0x1401) return result;
      const bufferWidth = this.drawingBufferWidth, bufferHeight = this.drawingBufferHeight;
      if (this.drawingBufferColorSpace && this.drawingBufferColorSpace !== 'srgb') return result;
      if (!bufferWidth || !bufferHeight) return result;
      const alignment = parameter(0x0d05);
      const rowLength = isWebGL2 ? parameter(0x0d02) : 0;
      const skipRows = isWebGL2 ? parameter(0x0d03) : 0;
      const skipPixels = isWebGL2 ? parameter(0x0d04) : 0;
      const offset = !isWebGL2 || destinationOffset === undefined ? 0 : Math.trunc(destinationOffset);
      if (![1, 2, 4, 8].includes(alignment) || offset < 0 || !Number.isFinite(offset)
        || rowLength < 0 || skipRows < 0 || skipPixels < 0 || skipPixels + w > (rowLength || w)) return result;
      const stride = Math.ceil(4 * (rowLength || w) / alignment) * alignment;
      const start = offset + skipRows * stride + skipPixels * 4;
      const end = start + (h - 1) * stride + w * 4;
      if (!Number.isSafeInteger(end) || end > destination.length) return result;
      noise(destination, w, h, px, py, stride, start, bufferHeight, [bufferWidth, bufferHeight]);
      return result;
    });
  }
  const status = Object.freeze({ algorithm, seed, stableReadback, javascriptLayer: true });
  Object.defineProperty(globalThis, marker, { value: status, configurable: false });
  return status;
}

function buildFingerprintPixelsSource(seed, options = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('Fingerprint pixel seed must be a uint32 integer.');
  const policy = { stableReadback: options.stableReadback !== false };
  return `(${installFingerprintPixels.toString()})(${seed},${JSON.stringify(policy)});`;
}

module.exports = { PIXEL_ALGORITHM, buildFingerprintPixelsSource, installFingerprintPixels };
