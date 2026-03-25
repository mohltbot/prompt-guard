# Prompt Guard for VS Code

Context-aware prompt enhancement right in your editor.

## Features

- **Status Bar**: Quick access to prompt checking
- **Output Panel**: Detailed analysis results
- **Command Palette**: `Cmd+Shift+P` → "Prompt Guard"
- **Right-click Menu**: Check selected text
- **Auto-check on Save**: Optional automatic checking

## Commands

| Command | Description |
|---------|-------------|
| `Prompt Guard: Check Prompt` | Analyze entire file |
| `Prompt Guard: Check Selected Text` | Analyze selection |
| `Prompt Guard: Enhance Prompt` | Copy enhanced prompt to clipboard |
| `Prompt Guard: Show Output Panel` | View results |

## Configuration

```json
{
  "promptGuard.enabled": true,
  "promptGuard.checkOnSave": false,
  "promptGuard.showStatusBar": true
}
```

## Usage

1. Open a file with your prompt
2. Click the status bar button or run a command
3. View results in the output panel
4. Fix any warnings or errors
5. Use "Enhance Prompt" to copy the context-enhanced version

## Requirements

- VS Code 1.74.0+
- prompt-guard CLI installed globally or locally

## Installation

From VS Code marketplace (coming soon) or install from VSIX.

## License

MIT