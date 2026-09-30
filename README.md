# YouTubeライブ英日字幕

WindowsのChromiumでYouTubeの英語発言を端末内で認識・翻訳し、動画上に日本語字幕を表示する個人用Manifest V3拡張の試作です。発言から表示まで3秒以内を優先します。対象Windows機での速度と翻訳品質は未測定です。

## 導入と更新

1. 開発環境でNode.js 20以降を用意し、`npm ci`と`npm run build`を実行します。
2. Chromiumの拡張機能画面でデベロッパーモードを有効にし、`dist`を「パッケージ化されていない拡張機能」として読み込みます。
3. YouTubeの動画ページを開き、拡張のポップアップで「モデルを事前準備」を選びます。
4. 準備完了後、「この動画で開始」を選びます。終了時は「翻訳を停止」を選びます。

更新時は新しいソースで`npm ci`と`npm run build`を再実行し、拡張機能画面で再読み込みします。再読み込み後は動画ごとに開始します。モデルの固定revisionを変更した場合は、新しいモデルを再取得します。

## 動作と保存

ポップアップには状態、開始・停止、モデルの事前準備、字幕の文字サイズ・位置を置いています。字幕は動画上に最大2行ずつ表示します。同じ区間の字幕更新は直ちに反映します。長い訳はページを送って末尾まで表示します。次の区間が待っている場合は次のページ切替で優先し、未表示部分を通知・計測します。シーク・一時停止・広告で古い結果を消し、同じ動画への復帰時に再同期します。別の動画やページへ移ると停止します。処理待ちが蓄積すると、字幕の省略を通知して現在の再生位置に合わせ直します。

設定は`chrome.storage.local`に保存します。モデルはTransformers.jsのブラウザーCache APIに保存されます。音声、英語認識、日本語字幕、計測値は永続保存しません。音声と文章は外部の翻訳APIへ送信せず、モデル取得だけにHugging Faceを利用します。実行するJavaScript、Worker、WASMは`dist`内に同梱します。元音声はAudioContextからタブの出力へ接続します。

## モデルと容量

`@huggingface/transformers@3.8.1`を固定しました。モデルと実行設定は次のとおりです。取得先はHugging Faceです。

| 用途 | モデル | 固定revision | 実行設定 |
| --- | --- | --- | --- |
| 英語認識 | `onnx-community/whisper-tiny.en` | `2575352d61be1bf7225cf8f8b268a4678025fc58` | WebGPU・fp32 |
| 英日翻訳 | `Xenova/nllb-200-distilled-600M` | `261c31d1a5732c67cdd16d80e8d6088507c7ccea` | WASM・q8、3 beams |

固定revisionのファイル一覧で、使用するONNX重みは次のとおりです。単位はbyteです。

| モデル | encoder | merged decoder | 重み合計 |
| --- | ---: | ---: | ---: |
| Whisper fp32 | 32,904,992 | 118,552,291 | 151,457,283 |
| NLLB q8 | 419,120,483 | 475,505,771 | 894,626,254 |

両モデルの重み合計は1,046,083,537 byteです。NodeのCPU環境で同じdtypeとrevisionを使い、次の設定・tokenizerファイルが実際に取得されることを確認しました。

| モデル | 取得ファイル | byte |
| --- | --- | ---: |
| Whisper | `config.json` | 2,197 |
| Whisper | `generation_config.json` | 1,646 |
| Whisper | `preprocessor_config.json` | 339 |
| Whisper | `tokenizer.json` | 2,405,679 |
| Whisper | `tokenizer_config.json` | 282,662 |
| NLLB | `config.json` | 873 |
| NLLB | `generation_config.json` | 189 |
| NLLB | `tokenizer.json` | 17,331,224 |
| NLLB | `tokenizer_config.json` | 544 |

重みと上記のファイルを含む合計は1,066,108,890 byteです。Windowsのブラウザーでも取得項目と転送量を確認します。

モデル一覧: [Whisper](https://huggingface.co/onnx-community/whisper-tiny.en/tree/2575352d61be1bf7225cf8f8b268a4678025fc58)、[翻訳](https://huggingface.co/Xenova/nllb-200-distilled-600M/tree/261c31d1a5732c67cdd16d80e8d6088507c7ccea)。ライセンスは[LICENSES.md](LICENSES.md)を参照してください。

## 制約

WebGPUが利用できない場合、モデル取得や推論に失敗した場合は原因を表示して停止します。推論待ちの上限による再同期が連続3回に達した場合も停止します。この回数はWindows実機で調整します。モデル準備中も音声出力を維持します。広告判定はYouTubeの表示状態に依存します。NLLBは短い文単位で翻訳します。NLLBのモデルライセンスは非商用利用に限られるため、公開・商用利用前にライセンスとモデル選定を確認してください。Windows実機のライブ視聴、長時間稼働、GPUメモリ、字幕の品質、3秒目標はこのMac環境では代用できません。YouTubeの利用条件と視聴対象の権利を確認して利用してください。

## 検証

`npm test`で状態と通信の代表的な契約を確認し、`npm run build`で拡張を生成します。Macでの初回字幕表示は約5.1秒でした。訳抜けもあり、3秒目標と品質の受入は残っています。[開発環境の確認記録](docs/local-validation.md)と[Windows受入手順](docs/windows-acceptance.md)を参照してください。

ポップアップの開発者ツールでは`await chrome.runtime.sendMessage({type:'GET_METRICS'})`で計測値を読めます。直近120件の処理記録と対象区間、累積件数だけをRAMに保持します。先頭PCMの到着から表示まで、収集・待ち・推論・転送を含めて記録します。発言や字幕の文章は含みません。
