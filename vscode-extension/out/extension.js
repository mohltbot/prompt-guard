"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const prompt_guard_1 = require("prompt-guard");
let outputChannel;
let statusBarItem;
function activate(context) {
    // Create output channel
    outputChannel = vscode.window.createOutputChannel('Prompt Guard');
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'promptGuard.showOutput';
    updateStatusBar('idle');
    statusBarItem.show();
    // Register commands
    const checkCommand = vscode.commands.registerCommand('promptGuard.check', checkPrompt);
    const checkSelectionCommand = vscode.commands.registerCommand('promptGuard.checkSelection', checkSelection);
    const enhanceCommand = vscode.commands.registerCommand('promptGuard.enhance', enhancePrompt);
    const showOutputCommand = vscode.commands.registerCommand('promptGuard.showOutput', () => {
        outputChannel.show();
    });
    // Register on-save listener
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        const config = vscode.workspace.getConfiguration('promptGuard');
        if (config.get('checkOnSave', false)) {
            checkDocument(document);
        }
    });
    context.subscriptions.push(checkCommand, checkSelectionCommand, enhanceCommand, showOutputCommand, saveListener, statusBarItem, outputChannel);
    vscode.window.showInformationMessage('Prompt Guard activated!');
}
exports.activate = activate;
async function checkPrompt() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }
    const text = editor.document.getText();
    await analyzePrompt(text, editor.document.fileName);
}
async function checkSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }
    const selection = editor.selection;
    const text = editor.document.getText(selection);
    if (!text) {
        vscode.window.showWarningMessage('No text selected');
        return;
    }
    await analyzePrompt(text, 'selection');
}
async function enhancePrompt() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }
    const text = editor.document.getText();
    const guard = new prompt_guard_1.PromptGuard();
    try {
        updateStatusBar('loading');
        const enhanced = await guard.enhance(text);
        // Copy to clipboard
        await vscode.env.clipboard.writeText(enhanced);
        // Show in output
        outputChannel.clear();
        outputChannel.appendLine('=== ENHANCED PROMPT ===');
        outputChannel.appendLine(enhanced);
        outputChannel.show();
        vscode.window.showInformationMessage('Enhanced prompt copied to clipboard!');
        updateStatusBar('success');
    }
    catch (error) {
        vscode.window.showErrorMessage(`Error: ${error}`);
        updateStatusBar('error');
    }
}
async function analyzePrompt(text, source) {
    const guard = new prompt_guard_1.PromptGuard();
    try {
        updateStatusBar('loading');
        const results = await guard.check(text);
        // Clear and show results
        outputChannel.clear();
        outputChannel.appendLine(`=== PROMPT GUARD ANALYSIS: ${source} ===`);
        outputChannel.appendLine('');
        let hasErrors = false;
        let hasWarnings = false;
        for (const result of results) {
            const icon = result.type === 'error' ? '✗' : result.type === 'warning' ? '⚠' : 'ℹ';
            outputChannel.appendLine(`${icon} ${result.message}`);
            if (result.suggestion) {
                outputChannel.appendLine(`  → ${result.suggestion}`);
            }
            outputChannel.appendLine('');
            if (result.type === 'error')
                hasErrors = true;
            if (result.type === 'warning')
                hasWarnings = true;
        }
        if (results.length === 0) {
            outputChannel.appendLine('✓ All checks passed!');
            updateStatusBar('success');
        }
        else if (hasErrors) {
            updateStatusBar('error');
        }
        else if (hasWarnings) {
            updateStatusBar('warning');
        }
        else {
            updateStatusBar('idle');
        }
        outputChannel.show();
        // Show summary notification
        if (hasErrors) {
            vscode.window.showErrorMessage(`Prompt Guard: ${results.length} issues found`);
        }
        else if (hasWarnings) {
            vscode.window.showWarningMessage(`Prompt Guard: ${results.length} warnings`);
        }
        else {
            vscode.window.showInformationMessage('Prompt Guard: All checks passed!');
        }
    }
    catch (error) {
        vscode.window.showErrorMessage(`Prompt Guard error: ${error}`);
        updateStatusBar('error');
    }
}
async function checkDocument(document) {
    // Only check markdown and text files
    if (!['markdown', 'plaintext'].includes(document.languageId)) {
        return;
    }
    const text = document.getText();
    // Only check if it looks like a prompt (contains certain keywords)
    const promptKeywords = ['refactor', 'add', 'fix', 'implement', 'create', 'update', 'build'];
    const looksLikePrompt = promptKeywords.some(kw => text.toLowerCase().includes(kw));
    if (!looksLikePrompt) {
        return;
    }
    await analyzePrompt(text, document.fileName);
}
function updateStatusBar(status) {
    const config = vscode.workspace.getConfiguration('promptGuard');
    if (!config.get('showStatusBar', true)) {
        statusBarItem.hide();
        return;
    }
    switch (status) {
        case 'idle':
            statusBarItem.text = '$(shield) Prompt Guard';
            statusBarItem.tooltip = 'Click to check prompt';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'loading':
            statusBarItem.text = '$(sync~spin) Checking...';
            statusBarItem.tooltip = 'Analyzing prompt...';
            break;
        case 'success':
            statusBarItem.text = '$(check) Prompt Guard';
            statusBarItem.tooltip = 'All checks passed!';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.successBackground');
            break;
        case 'warning':
            statusBarItem.text = '$(warning) Prompt Guard';
            statusBarItem.tooltip = 'Warnings found - click to see details';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
        case 'error':
            statusBarItem.text = '$(error) Prompt Guard';
            statusBarItem.tooltip = 'Errors found - click to see details';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            break;
    }
    statusBarItem.show();
}
function deactivate() {
    // Cleanup
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map