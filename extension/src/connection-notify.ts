import * as vscode from 'vscode';
import axios from 'axios';

let first_success = true;

export function connection_notiy(context: vscode.ExtensionContext) {
    async function validateBackendConnection(queryURL: string, showMessage: boolean = true): Promise<void> {
        try {
            const response = await axios.get(queryURL + "/check");
            if (response.status === 200) {
                if (showMessage || first_success) {
                    vscode.window.showInformationMessage('✅ Connected to backend successfully! 🎉');
                }
                first_success = false;
            } else {
                first_success = true;
                vscode.window.showErrorMessage('❌ Backend connection failed: Invalid response.');
            }
        } catch (error: any) {
            first_success = true;
            vscode.window.showErrorMessage(`❌ Backend connection failed: ${error.message}`);
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            const queryURL = vscode.workspace.getConfiguration('trace').get<string>('queryURL');
            if (queryURL) {
                validateBackendConnection(queryURL);
            } else {
                vscode.window.showWarningMessage('⚠️ Query URL is not set in settings.');
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
            if (event.affectsConfiguration('trace.queryURL')) {
                const queryURL = vscode.workspace.getConfiguration('trace').get<string>('queryURL');
                if (queryURL) {
                    validateBackendConnection(queryURL);
                } else {
                    vscode.window.showWarningMessage('⚠️ Query URL is not set in settings.');
                }
            }
        })
    );

    const interval = setInterval(() => {
        const queryURL = vscode.workspace.getConfiguration('trace').get<string>('queryURL');
        if (queryURL) {
            validateBackendConnection(queryURL, false);
        } else {
            vscode.window.showWarningMessage('⚠️ Query URL is not set in settings.');
        }
    }, 5000);

    context.subscriptions.push({
        dispose: () => clearInterval(interval),
    });

    const initialQueryUrl = vscode.workspace.getConfiguration('trace').get<string>('queryURL');
    if (initialQueryUrl) {
        validateBackendConnection(initialQueryUrl);
    } else {
        vscode.window.showWarningMessage('⚠️ Query URL is not set in settings.');
    }
}

export function deactivate(): void {}