export class VoiceSegmenter {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.minSpeech = sampleRate * (options.minSpeechMs ?? 180) / 1000;
    this.endSilence = sampleRate * (options.endSilenceMs ?? 1100) / 1000;
    this.maxDuration = sampleRate * (options.maxDurationMs ?? 30000) / 1000;
    this.preRollLength = sampleRate * (options.preRollMs ?? 450) / 1000;
    this.reset();
  }

  reset() {
    this.preRoll = [];
    this.preRollSamples = 0;
    this.chunks = [];
    this.recordedSamples = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.active = false;
    this.noiseFloor = 0.004;
  }

  push(input) {
    const samples = new Float32Array(input);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    const loud = rms > Math.max(0.012, this.noiseFloor * 2.6);
    if (!this.active) {
      this.preRoll.push(samples);
      this.preRollSamples += samples.length;
      while (this.preRollSamples - this.preRoll[0].length >= this.preRollLength) {
        this.preRollSamples -= this.preRoll.shift().length;
      }
      if (loud) this.speechSamples += samples.length;
      else {
        this.speechSamples = 0;
        this.noiseFloor = Math.min(0.025, this.noiseFloor * 0.98 + rms * 0.02);
      }
      if (this.speechSamples < this.minSpeech) return { started: false, audio: null };
      this.active = true;
      this.chunks = this.preRoll;
      this.recordedSamples = this.preRollSamples;
      this.preRoll = [];
      this.preRollSamples = 0;
      this.silenceSamples = 0;
      return { started: true, audio: null };
    }

    this.chunks.push(samples);
    this.recordedSamples += samples.length;
    this.silenceSamples = loud ? 0 : this.silenceSamples + samples.length;
    if (this.silenceSamples < this.endSilence && this.recordedSamples < this.maxDuration) {
      return { started: false, audio: null };
    }
    const audio = new Float32Array(this.recordedSamples);
    let offset = 0;
    for (const chunk of this.chunks) { audio.set(chunk, offset); offset += chunk.length; }
    this.reset();
    return { started: false, audio };
  }
}

export function wavBlob(samples, inputRate, outputRate = 16000) {
  const rate = Math.min(inputRate, outputRate);
  const ratio = inputRate / rate;
  const count = Math.floor(samples.length / ratio);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const label = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  label(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true);
  label(8, 'WAVE'); label(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let total = 0;
    for (let j = from; j < to && j < samples.length; j++) total += samples[j];
    const sample = Math.max(-1, Math.min(1, total / (to - from)));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
