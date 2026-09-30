---
type: "decision"
status: "proposed"
status_reason: "対象Windowsでの性能と発表イベントの品質が未確認"
scope: "src/inference.worker.js の翻訳モデル選定"
created_at: "2026-09-29"
last_reviewed: "2026-09-29"
review_after: ""
verification: "execution"
evidence: ["src/inference.worker.js", "README.md", "docs/local-validation.md", "execution:2026-09-29"]
supersedes: []
superseded_by: ""
---

# ローカル翻訳モデルの暫定候補

## Context

無料・拡張単体・内容の外部送信なしという条件で、英語発言を日本語字幕へ変換する。
小さい翻訳モデルを選ぶだけでは、発表内容の意味を保てなかった。

## Decision

試作にはNLLBの量子化モデルを使用し、Windowsで速度と品質を評価してから採用を判断する。
この記録は未確認の候補であり、採用済みの方針ではない。

## Rationale

最初に試したOPUSの英日モデルは、短文でも不適切な訳を返した。
NLLBは比較した数値・否定の短文を保てたため、次の評価候補とした。
一方、音声認識を含む取得容量は約1.07GBになり、Macでの公開音声の試験では推論だけで約4.1秒かかった。
訳抜けも残るため、小容量候補より良い例があったことを品質合格や3秒達成とは扱えない。

## Revisit when

対象Windowsの同じ音声・再生条件で、認識から字幕表示までの速度と品質を比較できたときに再検討する。
モデルを変更する場合は、取得量とライセンスの記載も更新する。
