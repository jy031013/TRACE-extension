import vscode from 'vscode';
import { getRootPath, updatePrevEdits, toPosixPath, readFilesDefaultCollected, getOpenedFilePaths, getStagedFile, toDriveLetterLowerCasePath } from '../utils/file-utils';
import { globalQueryContext, globalEditLock } from '../global-result-context';
import { globalEditorState } from '../global-workspace-context';
import { CachedRenameOperation, requestAndUpdateLocation, requestEdit, requestLocationByNavEdit } from './query-processes';
import { DisposableComponent } from '../utils/base-component';
import { EditSelector, diffTabSelectors, tempWrite } from '../views/compare-view';
import { statusBarItem } from '../ui/progress-indicator';
import { EditType, EditWithTimestamp, FileAsHunks, RequestEdit, SimpleEdit } from '../utils/base-types';
import { splitLines } from '../utils/utils';
import { globalEditInfoCollector } from '../editor-state-monitor';
import { PreJudgedLspType, RequestLspFoundLocation } from './backend-requests';

/**
 * @deprecated This function is obsolete. Fetching previous edits in the new way is not implemented yet;
 */
async function predictLocation() {
    if (!globalEditorState.isActiveEditorLanguageSupported()) {
        vscode.window.showInformationMessage(`Predicting location canceled: language ${globalEditorState.language} not supported yet.`);
        return;
    }
    return await globalEditLock.tryWithLock(async () => {
        const commitMessage = await globalQueryContext.querySettings.requireCommitMessage();
        if (commitMessage === undefined) return;

        statusBarItem.setStatusLoadingFiles();
        const rootPath = getRootPath();
        // wait 1 second
        await new Promise((resolve) => setTimeout(resolve, 300));
        const files: [string, string][] = [];
        try {
            const currentPrevEdits: SimpleEdit[] = [];
            statusBarItem.setStatusQuerying("locator");
            // TODO depart this step, because it is not parallel to other steps
            await requestAndUpdateLocation(rootPath, files, currentPrevEdits, commitMessage, globalEditorState.language);
            statusBarItem.setStatusDefault();
        } catch (err) {
            vscode.window.showErrorMessage("Oops! Something went wrong with the query request 😦");
            statusBarItem.setStatusProblem("Some error occured when predicting locations");
            throw err;
        }
    });
}

async function predictLocationByNavEdit() {
    if (!globalEditorState.isActiveEditorLanguageSupported()) {
        vscode.window.showInformationMessage(`Predicting location canceled: language ${globalEditorState.language} not supported yet.`);
        return;
    }
    return await globalEditLock.tryWithLock(async () => {
        const commitMessage = await globalQueryContext.querySettings.requireCommitMessage();
        if (commitMessage === undefined) return;

        statusBarItem.setStatusLoadingFiles();
        const rootPath = getRootPath();
        const fileContents = await readFilesDefaultCollected() as [string, string][];

        // Split the file content into lines
        const files: [string, string[]][] = [];
        for (const pathAndContent of fileContents) {
            const content = pathAndContent[1];
            const lines = splitLines(content, false);
            files.push([pathAndContent[0], lines]);
        }

        const filesAtPath: { [key: string]: string[] } = {};
        for (const file of files) {
            filesAtPath[file[0]] = file[1];
        }

        const {
            requestEdits,
            lspType,
            fullLspFoundLocations,
            cachedRenameOperation
        } = await globalEditInfoCollector.exportAnalyzedEdits();

        try {
            statusBarItem.setStatusQuerying("locator");
            // TODO depart this step, because it is not parallel to other steps
            
            const invokerResult = await requestLocationByNavEdit(
                filesAtPath,
                requestEdits,
                commitMessage,
                globalEditorState.language,
                lspType,
                fullLspFoundLocations,
                cachedRenameOperation
            );
            if (invokerResult) {
                if (invokerResult[0] === 'rename') {
                    globalQueryContext.updateRefactor(invokerResult[1]);
                } else if (invokerResult[0] === 'location') {
                    globalQueryContext.updateLocations(invokerResult[1]);
                }
            }
            
            statusBarItem.setStatusDefault();
        } catch (err) {
            vscode.window.showErrorMessage("Oops! Something went wrong with the query request...", err instanceof Error ? err.message : "Unknown error");
            statusBarItem.setStatusProblem("Some error occurred when predicting locations");
            throw err;
        }
    });
}

async function predictLocationIfHasEditAtSelectedLine(event: vscode.TextEditorSelectionChangeEvent) {
    const hasNewEdits = updatePrevEdits(event.selections[0].active.line);
    if (hasNewEdits) {
        await predictLocation();
    }
}

async function predictEdit() {
    if (!globalEditorState.isActiveEditorLanguageSupported()) {
        vscode.window.showInformationMessage(`Predicting edit canceled: language ${globalEditorState.language} not supported yet.`);
        return;
    }
    
    const commitMessage = await globalQueryContext.querySettings.requireCommitMessage();
    if (commitMessage === undefined) return;
    
    const activeEditor = vscode.window.activeTextEditor;
    const activeDocument = activeEditor?.document;
    if (!(activeEditor && activeDocument)) return;
    if (activeDocument.uri.scheme !== "file") return;

    statusBarItem.setStatusLoadingFiles();

    // extract uri
    const uri = activeDocument.uri;

    // extract selected line numbers
    const atLines: number[] = [];
    const selectedRange = activeEditor.selection;
    
    const fromLine = selectedRange.start.line;
    let toLine = selectedRange.end.line;
    let editType: EditType;

    if (selectedRange.isEmpty) {
        editType = "add";
        atLines.push(fromLine);
    } else {
        editType = "replace";
        // If only the beginning of the last line is included, exclude the last line
        if (selectedRange.end.character === 0) {
            toLine -= 1;
        }
        for (let i = fromLine; i <= toLine; ++i) {
            atLines.push(i);
        }
    }
    
    const targetFileContent = activeDocument.getText();
    const selectedContent = activeDocument.getText(
        new vscode.Range(
            activeDocument.lineAt(fromLine).range.start,
            activeDocument.lineAt(toLine).range.end
        )
    );
    
    statusBarItem.setStatusQuerying("generator");

    try {
        let codeWindow: string[] = [];
        let inlineLabels: string[] = [];
        let interLabels: string[] = [];
        let startLine: number = 0;
        let endLine: number = 0;

        let shouldUseOriginalCodeWindow = true;

        // TODO functions of getting file content and getting lines should be wrap elsewhere as utils

        const openedPaths = getOpenedFilePaths();
        const fileContent = await getStagedFile(openedPaths, toDriveLetterLowerCasePath(uri.fsPath));
        const fileLines = splitLines(fileContent, true);

        const selectedNavEditResult = globalQueryContext.activeNavEditLocationResult;
        if (selectedNavEditResult) {
            const locationsInFile = selectedNavEditResult.getLocations().get(uri.toString());
            const coveredInLocation = locationsInFile?.find((location) => {
                const startLine = location.code_window_start_line;
                const endLine = location.code_window_start_line + location.inline_labels.length;
                return atLines.every((line) => line >= startLine && line < endLine);
            });

            if (coveredInLocation) {
                startLine = coveredInLocation.code_window_start_line;
                endLine = startLine + coveredInLocation.inline_labels.length;

                codeWindow = fileLines.slice(startLine, endLine);
                inlineLabels = coveredInLocation.inline_labels;
                interLabels = coveredInLocation.inter_labels;

                shouldUseOriginalCodeWindow = false;
            }
        }

        if (shouldUseOriginalCodeWindow) {
            startLine = fromLine;
            endLine = toLine + 1;

            codeWindow = fileLines.slice(startLine, endLine);
            interLabels = new Array(endLine - startLine + 1).fill('<null>');
            if (editType === 'add') {
                inlineLabels = new Array(endLine - startLine).fill('<add>');
            } else {
                inlineLabels = new Array(endLine - startLine).fill('<replace>');
            }
        }

        const codeWindowContextBefore = fileLines.slice(Math.max(startLine, 0), startLine);
        const codeWindowContextAfter = fileLines.slice(endLine, Math.min(endLine + 1, fileLines.length));
        codeWindow = [codeWindowContextBefore, codeWindow, codeWindowContextAfter].flat();

        const {
            requestEdits,
            lspType,
            fullLspFoundLocations,
            cachedRenameOperation
        } = await globalEditInfoCollector.exportAnalyzedEdits();

        let replacementStrings = await requestEdit(
            globalEditorState.language,
            activeDocument.uri.fsPath,
            atLines[0] ?? 0,
            codeWindow,
            interLabels,
            inlineLabels,
            commitMessage,
            requestEdits,
            lspType,
            lspType
        );

        if (!replacementStrings) { return; }
        
        // Remove syntax-level unchanged replacements
        // TODO specify this step to a function
        replacementStrings = replacementStrings.filter((snippet: string) => snippet.trim() !== selectedContent.trim());

        const selector = new EditSelector(
            toPosixPath(uri.fsPath),
            fromLine,
            toLine+1,
            replacementStrings,
            tempWrite,
            false
        );
        await selector.init();
        await selector.editDocumentAndShowDiff();
        statusBarItem.setStatusDefault();
    } catch (err) {
        // TODO add a error logging channel to "Outputs"
        vscode.window.showErrorMessage("Oops! Something went wrong with the query request 😦");
        statusBarItem.setStatusProblem("Some error occurred when predicting edits");
        throw err;
    }
}

class PredictLocationCommand extends DisposableComponent {
	constructor() {
		super();
		this.register(
            vscode.commands.registerCommand("navEdit.predictLocations", predictLocationByNavEdit),
            vscode.commands.registerCommand("navEdit.clearLocations", async () => {
                globalQueryContext.clearResults();
            })
		);
	}
}

class GenerateEditCommand extends DisposableComponent {
	constructor() {
		super();
        this.register(
            this.registerEditSelectionCommands(),
            vscode.commands.registerCommand("navEdit.generateEdits", predictEdit)
		);
    }
    
    registerEditSelectionCommands() {
        function getSelectorOfCurrentTab() {
            const currTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
            if (currTab && currTab.input instanceof vscode.TabInputTextDiff) {
                const selector = diffTabSelectors.get(currTab.input.modified.toString());
                if (selector) {
                    selector.manuallyEdited = false;
                }
                return selector;
            }
            return undefined;
        }
        async function switchEdit(offset: number) {
            const selector = getSelectorOfCurrentTab();
            selector && await selector.switchEdit(offset);
        }
        async function closeTab() {
            const tabGroups = vscode.window.tabGroups;
            const activeTab = tabGroups.activeTabGroup.activeTab;
            if (activeTab) {
                await tabGroups.close(tabGroups.activeTabGroup.activeTab, true);
            }
        }
        async function clearEdit() {
            const selector = getSelectorOfCurrentTab();
            selector && await selector.clearEdit();
        }
        async function acceptEdit() {
            const selector = getSelectorOfCurrentTab();
            if (selector) {
                await selector.acceptEdit();
            } else {
                globalQueryContext.applyRefactor();
            }
        }
        return vscode.Disposable.from(
            vscode.commands.registerCommand("navEdit.lastSuggestion", async () => {
                await switchEdit(-1);
            }),
            vscode.commands.registerCommand("navEdit.nextSuggestion", async () => {
                await switchEdit(1);
            }),
            vscode.commands.registerCommand("navEdit.acceptEdit", async () => {
                globalEditorState.toPredictLocation = true;
                await acceptEdit();
                await closeTab();
            }),
            vscode.commands.registerCommand("navEdit.dismissEdit", async () => {
                await clearEdit();
                await closeTab();
            })
        );
    }
}

export {
    predictLocation,
    predictLocationIfHasEditAtSelectedLine,
    PredictLocationCommand,
    GenerateEditCommand
};
