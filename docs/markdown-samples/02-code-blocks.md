# Code blocks — 程式碼

比較 inline `const theme = "prime-current"` 與下方不同語言的 code block。

## TypeScript

```typescript
interface ThemeOptions {
  fontSize: number;
  markdownTheme: "vscode" | "prime-current" | "prime";
}

// 註解：比較 keyword、string、number 的顏色
const options: ThemeOptions = {
  fontSize: 16,
  markdownTheme: "prime-current",
};

function describeTheme(options: ThemeOptions): string {
  return `${options.markdownTheme}: ${options.fontSize}px`;
}
```

## Python

```python
from pathlib import Path

# 中文註解與 Unicode
name = "Brief 主題"
font_size = 16

def describe_theme(name: str, size: int) -> str:
    return f"{name}: {size}px"

print(describe_theme(name, font_size))
```

## JSON

```json
{
  "brief.fontSize": 16,
  "brief.markdownTheme": "prime",
  "brief.primeTheme": "prime"
}
```

## Shell

```bash
# 僅供顯示，不需要執行
printf '%s\n' "Hello, Brief"
npm run compile
```

## 無語言標記

```
Plain code block
  Indented text
中文、symbols: < > & " ' `
A long line to inspect horizontal overflow: abcdefghijklmnopqrstuvwxyz 0123456789 abcdefghijklmnopqrstuvwxyz 0123456789 abcdefghijklmnopqrstuvwxyz 0123456789
```

> 引用內的程式碼：
>
> ```typescript
> const message = "Code inside a quote";
> ```
