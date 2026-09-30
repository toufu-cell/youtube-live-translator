# ライセンス表示

実行時に同梱する依存と、取得するモデルの出典を示します。

| 対象 | ライセンス | 出典 |
| --- | --- | --- |
| `@huggingface/transformers@3.8.1` | Apache-2.0 | [パッケージ](https://www.npmjs.com/package/@huggingface/transformers/v/3.8.1)、同梱の`licenses/transformers-APACHE-2.0.txt` |
| `onnxruntime-web` | MIT | [Microsoft ONNX Runtime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)、同梱の`licenses/onnxruntime-MIT.txt` |
| Whisperのコード | MIT | [OpenAI Whisper](https://github.com/openai/whisper/blob/main/LICENSE) |
| `openai/whisper-tiny.en`のモデル重み | Apache-2.0 | [元モデルカード](https://huggingface.co/openai/whisper-tiny.en) |
| `Xenova/nllb-200-distilled-600M`のモデル重み | CC-BY-NC-4.0 | [変換モデル](https://huggingface.co/Xenova/nllb-200-distilled-600M)、[元モデルカード](https://huggingface.co/facebook/nllb-200-distilled-600M) |

WhisperのコードのMITと元モデル重みのApache-2.0は別の対象です。変換済みONNXモデルは、[Whisper](https://huggingface.co/onnx-community/whisper-tiny.en)と[NLLB](https://huggingface.co/Xenova/nllb-200-distilled-600M)を固定revisionで取得します。NLLBの[CC-BY-NC-4.0](https://creativecommons.org/licenses/by-nc/4.0/)は非商用利用に限られます。公開・商用利用前に配布条件とモデル選定を確認してください。
