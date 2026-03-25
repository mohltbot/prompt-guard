#!/bin/bash
# Cursor wrapper for prompt-guard
# Usage: cursor-guard "your prompt"

# Check if prompt-guard is installed
if ! command -v prompt-guard &> /dev/null; then
    echo "Error: prompt-guard not found. Install with: npm install -g prompt-guard"
    exit 1
fi

# Get the prompt
PROMPT="$*"

if [ -z "$PROMPT" ]; then
    echo "Usage: cursor-guard \"your prompt here\""
    exit 1
fi

# Run prompt-guard check
echo "🔍 Checking prompt..."
prompt-guard check "$PROMPT"

# Ask if user wants to proceed
echo ""
read -p "Proceed with Cursor? [Y/n] " -n 1 -r
echo

if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Cancelled."
    exit 0
fi

# Enhance and send to Cursor
echo "✨ Enhancing prompt..."
ENHANCED=$(prompt-guard enhance "$PROMPT")

# Copy to clipboard (macOS)
echo "$ENHANCED" | pbcopy

echo "Enhanced prompt copied to clipboard!"
echo "Paste into Cursor with Cmd+V"
echo ""
echo "--- Enhanced Preview ---"
echo "$ENHANCED" | head -20