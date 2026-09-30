class PcmTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(2048);
        this.used = 0;
    }

    process(inputs) {
        const channels = inputs[0];
        if (!channels?.length) return true;
        for (let i = 0; i < channels[0].length; i++) {
            let value = 0;
            for (const channel of channels) value += channel[i] / channels.length;
            this.buffer[this.used++] = value;
            if (this.used === this.buffer.length) {
                this.port.postMessage(this.buffer, [this.buffer.buffer]);
                this.buffer = new Float32Array(2048);
                this.used = 0;
            }
        }
        return true;
    }
}
registerProcessor('pcm-tap', PcmTap);
