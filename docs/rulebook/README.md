# ルール説明書

このフォルダには、A4両面ルール説明書の元画像を置きます。

- 元画像: `assets/whale-mouth-rulebook.png`
- 生成スクリプト: `scripts/build_rulebook.py`
- 生成先: `output/rules/`

Word版を生成する場合は、プロジェクトルートで次を実行します。

```powershell
python scripts/build_rulebook.py
```

`output/rules/into-the-mouth-rules-ja.docx` が生成されます。PDFはWordまたは互換ソフトで書き出してください。
