// G.711 mu-law <-> 16-bit linear PCM conversion.
// Twilio Media Streams send/receive 8kHz mulaw; Gemini Live expects/returns
// 16kHz PCM16. We decode mulaw->PCM, naive-upsample 8k->16k, and the reverse
// on the way out. For production quality, swap the naive resampler for a
// proper polyphase resampler (e.g. via the `node-libsamplerate` package).

const MULAW_BIAS = 0x84;
const MULAW_MAX = 0x1fff;

function mulawDecodeSample(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

function mulawEncodeSample(sample) {
  let sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  sample = Math.min(sample, MULAW_MAX);
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Twilio inbound: base64 mulaw 8kHz -> base64 PCM16 16kHz mono (for Gemini). */
export function mulawBase64ToPcm16Base64(mulawB64) {
  const mulawBuf = Buffer.from(mulawB64, "base64");
  const pcm8k = new Int16Array(mulawBuf.length);
  for (let i = 0; i < mulawBuf.length; i++) pcm8k[i] = mulawDecodeSample(mulawBuf[i]);

  // naive 2x upsample 8k -> 16k (linear interpolation)
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length - 1; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] = (pcm8k[i] + pcm8k[i + 1]) >> 1;
  }
  return Buffer.from(pcm16k.buffer).toString("base64");
}

/** Gemini outbound: base64 PCM16 24kHz mono -> base64 mulaw 8kHz (for Twilio). */
export function pcm16Base64ToMulawBase64(pcmB64, inputRate = 24000) {
  const pcmBuf = Buffer.from(pcmB64, "base64");
  const pcm = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);

  const ratio = inputRate / 8000;
  const outLen = Math.floor(pcm.length / ratio);
  const mulawOut = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = Math.floor(i * ratio);
    mulawOut[i] = mulawEncodeSample(pcm[srcIdx] || 0);
  }
  return mulawOut.toString("base64");
}
