class VocodeVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const input = channels[0];
    for (let i = 0; i < input.length; i++) {
      this.samples[this.offset++] = input[i];
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('vocode-voice-capture', VocodeVoiceCapture);
