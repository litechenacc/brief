# Mixed layout — 綜合排版

## 清單

- 一般項目
- **粗體項目**，包含 [連結](https://www.primeintellect.ai/) 與 `inline code`
  - 第二層項目
    - 第三層項目
- 最後一個項目

1. 選擇 `vscode` theme。
2. 切換至 `prime-current`。
3. 使用 `prime` 並指定 `brief.primeTheme`。

## Task list

- [x] 標題與一般文字
- [x] 粗體、斜體與引用
- [ ] 比較不同 theme
- [ ] 放大及縮小字體

## 表格

| Element | 範例 | 觀察重點 |
| :--- | :---: | ---: |
| Bold | **粗體** | 字重 |
| Italic | *斜體* | 字型 |
| Inline code | `fontSize: 16` | 文字與背景 |
| Link | [Prime](https://www.primeintellect.ai/) | 連結顏色 |

## 混合內容

> ### 引用中的標題
>
> 一般文字、**重點** 與 `code`。
>
> - 引用中的清單
> - 第二個項目

1. 設定範例：

   ```json
   {
     "brief.fontSize": 18,
     "brief.markdownTheme": "prime-current"
   }
   ```

2. 觀察 code block 與清單縮排。

---

## 手動比較

依序開啟這三份文件，在各種 theme 下比較標題、連結、引用與程式碼顏色。使用放大／縮小指令，觀察段落、表格與長程式碼行的排版。
