# Cursor Integration

Wrapper scripts for using prompt-guard with Cursor IDE.

## Installation

```bash
# Make executable
chmod +x cursor-guard.sh

# Optional: Add to PATH
ln -s $(pwd)/cursor-guard.sh /usr/local/bin/cursor-guard
```

## Usage

```bash
cursor-guard "refactor the auth system"
```

This will:
1. Check your prompt for missing context
2. Show warnings/errors
3. Ask if you want to proceed
4. Enhance the prompt with project context
5. Copy to clipboard
6. You paste into Cursor

## Alias (Recommended)

Add to your `.zshrc` or `.bashrc`:

```bash
alias cursor='cursor-guard'
```

Now `cursor "your prompt"` will check before opening Cursor.

## How It Works

Since Cursor doesn't have a public API for extensions, we:
1. Check the prompt before sending
2. Enhance it with context
3. Copy to clipboard
4. You paste into Cursor's chat

This gives you the benefits of prompt-guard without native integration.

## Future

If Cursor opens their extension API, we can build native integration.

## License

MIT