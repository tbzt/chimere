// Model pinned to a Hugging Face commit so the bytes never change under us.
// HTDemucs 4 stems exported by demucs-web: waveform + spectrogram in,
// time branch + frequency branch out (STFT/iSTFT done in JS by demucs-web).
// Note: StemSplitio/htdemucs-onnx (waveform-only graph) fails to load in
// onnxruntime-web 1.31 with std::bad_alloc, fp16 and fp32 alike.
export const MODEL = {
  repo: 'timcsy/demucs-web-onnx',
  revision: '92e33df61cfc9eb820272aaa62d2ef6dcf4d950d',
  file: 'htdemucs_embedded.onnx',
  sizeBytes: 180534758,
  get url() {
    return `https://huggingface.co/${this.repo}/resolve/${this.revision}/${this.file}`;
  },
};

export const MODEL_CACHE = 'chimere-model-v1';

export const SAMPLE_RATE = 44100;
export const SEGMENT = 343980; // 7.8 s, fixed by the exported graph
export const OVERLAP = 0.25;

// Output order of the model.
export const STEMS = ['drums', 'bass', 'other', 'vocals'];

export const STEM_LABELS = {
  vocals: 'Voix',
  drums: 'Batterie',
  bass: 'Basse',
  other: 'Reste',
};
