import vscode from 'vscode';
import { registerBasicCommands, registerTopTaskCommands } from './comands';
import { connection_notify } from './connection-notify';
import { FileStateMonitor, initializeGlobalBM25Index, updateEditorState } from './editor-state-monitor';
import { globalEditorState } from './global-workspace-context';
import { modelServerProcess } from './services/backend-requests';
import { statusBarItem } from './ui/progress-indicator';
import { compareTempFileSystemProvider } from './views/compare-view';
import { globalLocationViewManager } from './views/location-tree-view';

function activate(context: vscode.ExtensionContext) {
	console.log('Extension activated with arguments:', process.argv);

	context.subscriptions.push(
		globalEditorState,
		compareTempFileSystemProvider,
		statusBarItem,
		globalLocationViewManager,
		modelServerProcess
		);
		
	context.subscriptions.push(
		registerBasicCommands(),
		registerTopTaskCommands(),
		);
			
	context.subscriptions.push(
		new FileStateMonitor(),
	);
	
	context.subscriptions.push(
		initializeGlobalBM25Index(vscode.workspace.workspaceFolders?.[0].uri.fsPath || "", {
			validSuffixes: [".ts", ".js", ".tsx", ".jsx", ".py", ".java", ".go", ".cpp", ".c", ".cs", ".rb", ".rs", ".php", ".html", ".css", ".scss", ".json", ".yaml", ".yml", ".xml", ".md"]
		})
	);
	
	connection_notify(context);	

	updateEditorState(vscode.window.activeTextEditor);
}

function deactivate() {
}

export {
	activate,
	deactivate
};

