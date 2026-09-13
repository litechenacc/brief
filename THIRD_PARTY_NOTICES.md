# 第三方授權

## Lobe Icons

`webview/provider-icon.ts` 的 Claude、OpenAI、OpenCode、DeepSeek、Kimi、Qwen 與 NVIDIA 圖示採用 [Lobe Icons](https://github.com/lobehub/lobe-icons) 的單色 SVG paths。圖示隨 webview bundle 打包，不會在執行時下載。

- Commit: [`a94750e3f5f8fc33757b839d85030e742284e43a`](https://github.com/lobehub/lobe-icons/commit/a94750e3f5f8fc33757b839d85030e742284e43a)
- 授權：[MIT LICENSE](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/LICENSE)
- 調整：保留原始 paths、24 × 24 viewBox 與 evenodd fill rule；透過既有 DOM helpers 設定尺寸、`currentColor` 與裝飾性無障礙屬性，移除原始 title 與 inline style。
- 品牌與商標屬於各自權利人；MIT 授權不代表品牌背書或提供商標使用權。

### 原始檔案

- [`claude.svg`](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/claude.svg)
- [`openai.svg`](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/openai.svg)
- [`opencode.svg`](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/opencode.svg)
- [`deepseek.svg`](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/deepseek.svg)
- [`kimi.svg`](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/kimi.svg)
- [`qwen.svg`](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/qwen.svg)
- [`nvidia.svg`](https://github.com/lobehub/lobe-icons/blob/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons/nvidia.svg)

### MIT License

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
