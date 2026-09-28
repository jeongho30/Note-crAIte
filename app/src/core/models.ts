// 모델 URL·크기·sha256 목록. 파일은 데이터 폴더의 models/ 아래에 받는다.

export type ModelEntry = { file: string; url: string; size: number; sha256: string }

export const MODELS: { whisper: Record<string, ModelEntry>; vad: Record<string, ModelEntry> } = {
  whisper: {
    'small-q5_1': {
      file: 'ggml-small-q5_1.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
      size: 190085487,
      sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
    },
    'medium-q5_0': {
      file: 'ggml-medium-q5_0.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin',
      size: 539212467,
      sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f'
    },
    'large-v3-turbo-q5_0': {
      file: 'ggml-large-v3-turbo-q5_0.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
      size: 574041195,
      sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
    },
    'large-v3-turbo-q8_0': {
      file: 'ggml-large-v3-turbo-q8_0.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin',
      size: 874188075,
      sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1'
    },
    'large-v3-q5_0': {
      file: 'ggml-large-v3-q5_0.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin',
      size: 1081140203,
      sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1'
    }
  },
  vad: {
    'silero-v6.2.0': {
      file: 'ggml-silero-v6.2.0.bin',
      url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
      size: 885098,
      sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'
    }
  }
}
