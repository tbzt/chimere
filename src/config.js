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

// Input-normalisation prologue of the graph (mean/std of the spectrogram and
// of the waveform: large reductions + sqrt). Pinned to CPU on WebGPU, as
// monteslu/htdemucs-web-onnx advises for the same graph (NaN in fp16 there).
// Not proven necessary for this fp32 model: the all-zero stems seen on Linux
// came from Chrome launch flags. Node names read from the ONNX file at the
// revision above.
export const CPU_NODES = [
  'node_mean', 'node_Sub_4', 'node_Mul_5', 'node_ReduceMean_6', 'node_Mul_11', 'node_var',
  'node_Reshape_22', 'node_sqrt', 'node_add', 'node_div',
  'node_mean_1', 'node_Sub_29', 'node_Mul_30', 'node_ReduceMean_31', 'node_Mul_36', 'node_var_1',
  'node_Reshape_45', 'node_sqrt_1', 'node_add_1', 'node_div_1',
];

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
