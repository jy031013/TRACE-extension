import vscode from 'vscode';
import { convertToRequestEdit, globalEditInfoCollector } from '../editor-state-monitor';
import { globalEditLock, globalQueryContext } from '../global-result-context';
import { globalEditorState } from '../global-workspace-context';
import { statisticsCollector } from '../statistics';
import { statusBarItem } from '../ui/progress-indicator';
import { DisposableComponent } from '../utils/base-component';
import { EditType, SimpleEdit } from '../utils/base-types';
import { getOpenedFilePaths, getRootPath, getStagedFile, readMostRelatedFilesWithIndex, toDriveLetterLowerCasePath, toPosixPath, updatePrevEdits } from '../utils/file-utils';
import { splitLines } from '../utils/utils';
import { EditSelector, diffTabSelectors, globalTempFileManager, tempWrite } from '../views/compare-view';
import { requestAndUpdateLocation, requestEdit, requestInvokerAndLocationByTRACE, requestTRACELocator } from './query-processes';

/**
 * @deprecated This function is obsolete. Fetching previous edits in the new way is not implemented yet;
 */
async function predictLocation() {
    // if (!globalEditorState.isActiveEditorLanguageSupported()) {
    //     vscode.window.showInformationMessage(`Predicting location canceled: language ${globalEditorState.language} not supported yet.`);
    //     return;
    // }
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

async function predictLocationByTRACE() {
    // if (!globalEditorState.isActiveEditorLanguageSupported()) {
    //     vscode.window.showInformationMessage(`Predicting location canceled: language ${globalEditorState.language} not supported yet.`);
    //     return;
    // }
    statisticsCollector.addLog("command", "trace.predictLocations");

    return await globalEditLock.tryWithLock(async () => {
        // FIXME this withProgress will get inputMessage stuck
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyzing...' }, async () => {
            return await _predictLocationByTRACE();
        });
    });
}

async function _predictLocationByTRACE() {
    const commitMessage = await globalQueryContext.querySettings.requireCommitMessage();
    if (commitMessage === undefined) {
        statisticsCollector.addLog("action", "trace.predictLocations quited for disposing commit message input");
        return;
    }

    statisticsCollector.addLog("action", "trace.predictLocations accepted commit message");

    statusBarItem.setStatusLoadingFiles();

    const {
        editsWithTimestamp,
        lspType,
        fullLspFoundLocations,
        cachedRenameOperation
    } = await globalEditInfoCollector.exportAnalyzedEdits();

    const requestEdits = editsWithTimestamp.map(e => convertToRequestEdit(e));

    let queryText = '';
    const lastEdit = editsWithTimestamp.at(-1);
    const joinLines = (lines: string[]) => lines.map(x => x.trim()).join(' ');
    if (lastEdit) {
        queryText += joinLines(lastEdit.rmText) + ' ' + joinLines(lastEdit.addText);
    }

    const fileContents = await readMostRelatedFilesWithIndex(queryText);
    const currentFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;

    // Split the file content into lines
    const files: [string, string[]][] = [];
    for (const [filePath, content] of fileContents) {
        const lines = splitLines(content, false);

        // limit lines except for current file
        if (filePath !== currentFilePath) {
            const maxLines = 500;
            if (lines.length > maxLines) {
                lines.splice(maxLines);
            }
        }

        files.push([filePath, lines]);
    }

    const filesAtPath: { [key: string]: string[] } = {};
    for (const file of files) {
        filesAtPath[file[0]] = file[1];
    }

    try {
        statisticsCollector.addLog("action", "trace.predictLocations invoker <-");

        statusBarItem.setStatusQuerying("locator");
        // TODO depart this step, because it is not parallel to other steps
        
        const invokerResult = await requestInvokerAndLocationByTRACE(
            filesAtPath,
            requestEdits,
            commitMessage,
            globalEditorState.language,
            lspType,
            fullLspFoundLocations,
            cachedRenameOperation
        );
        if (invokerResult) {
            if (invokerResult instanceof Array) {
                if (invokerResult[0] === 'rename') {
                    statisticsCollector.addLog("action", "trace.predictLocations invoker -> rename");
                    globalQueryContext.updateRefactor(invokerResult[1]);
                } else if (invokerResult[0] === 'location') {
                    globalQueryContext.updateTRACELocations(invokerResult[1]);
                    statisticsCollector.addLog("action", "trace.predictLocations invoker -> direct locator");
                } else if (invokerResult[0] === 'def&ref') {
                    statisticsCollector.addLog("action", "trace.predictLocations invoker -> def&ref");
                    const symbolInfo = invokerResult[1];

                    const correspondingInfoType = symbolInfo.type === 'def' ? 'ref' : 'def';

                    // Always take the end position as name range, cause some result will look like this
                    // [2025-03-22 09:11:33,507][__main__][DEBUG] trace-invoker output: 
                    // {
                    //     "type": "def&ref",
                    //     "info": {
                    //         "type": "ref",
                    //         "name": "input_pipeline.create_classifier_dataset",
                    //         "name_range_start": [

                    const lastEdit = editsWithTimestamp[editsWithTimestamp.length - 1];
                    const focusedLspFoundLocation = await globalEditInfoCollector.exportLspFoundLocationsForSymbolRange({
                        type: correspondingInfoType,
                        fileUri: vscode.Uri.parse(editsWithTimestamp[editsWithTimestamp.length - 1].uriString),
                        symbolName: symbolInfo.name,
                        symbolRange: new vscode.Range(
                            new vscode.Position(symbolInfo.name_range_end[0] + lastEdit.currentStartLine, symbolInfo.name_range_end[1]),
                            new vscode.Position(symbolInfo.name_range_end[0] + lastEdit.line, symbolInfo.name_range_end[1])
                        )
                    });

                    if (focusedLspFoundLocation.length > 0) {
                        statisticsCollector.addLog("action", "trace.predictLocations locator <- some def&ref");
                    } else {
                        statisticsCollector.addLog("action", "trace.predictLocations locator <- no def&ref");
                    }

                    const locatorResult = focusedLspFoundLocation.length > 0
                        ? await requestTRACELocator(
                            filesAtPath,
                            requestEdits,
                            commitMessage,
                            globalEditorState.language,
                            'def&ref',
                            focusedLspFoundLocation,
                            cachedRenameOperation
                        )
                        : await requestTRACELocator(
                            filesAtPath,
                            requestEdits,
                            commitMessage,
                            globalEditorState.language,
                            'normal',
                            fullLspFoundLocations,
                            cachedRenameOperation
                        );

                    if (locatorResult) {
                        globalQueryContext.updateTRACELocations(locatorResult.files);
                    }
                }
            } else {
                const locatorResult = await requestTRACELocator(
                    filesAtPath,
                    requestEdits,
                    commitMessage,
                    globalEditorState.language,
                    'normal',
                    fullLspFoundLocations,
                    cachedRenameOperation
                );

                statisticsCollector.addLog("action", "trace.predictLocations locator <- normal");
                
                if (locatorResult) {
                    globalQueryContext.updateTRACELocations(locatorResult.files);
                }
            }
        }
        
        statusBarItem.setStatusDefault();
    } catch (err) {
        vscode.window.showErrorMessage(`Oops! Something went wrong with the query request...: ${err instanceof Error ? err.message : 'Unknown error'}`);
        statusBarItem.setStatusProblem("Some error occurred when predicting locations");
        throw err;
    }
}

async function predictLocationIfHasEditAtSelectedLine(event: vscode.TextEditorSelectionChangeEvent) {
    const hasNewEdits = updatePrevEdits(event.selections[0].active.line);
    if (hasNewEdits) {
        await predictLocation();
    }
}

async function predictEdit() {
    // if (!globalEditorState.isActiveEditorLanguageSupported()) {
    //     vscode.window.showInformationMessage(`Predicting edit canceled: language ${globalEditorState.language} not supported yet.`);
    //     return;
    // }
    statisticsCollector.addLog("command", "trace.generateEdits");
    
    return await globalEditLock.tryWithLock(async () => {
        // FIXME this withProgress will get inputMessage stuck
        return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Generating...' }, async () => {
            return await _predictEdit();
        });
    });
}

async function _predictEdit() {
    await globalTempFileManager.cleanupTempFileAndEditors();
    
    const commitMessage = await globalQueryContext.querySettings.requireCommitMessage();
    if (commitMessage === undefined) {
        statisticsCollector.addLog("action", "trace.generateEdits quited for disposing commit message input");
        return;
    }
    
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

        const selectedTRACEResult = globalQueryContext.activeTRACELocationResult;
        if (selectedTRACEResult) {
            editType = 'replace';

            const locationsInFile = selectedTRACEResult.getLocations().get(uri.toString());
            const coveredInLocation = locationsInFile?.find((location) => {
                const startLine = location.code_window_start_line;
                const endLine = location.code_window_start_line + location.inline_labels.length;
                return atLines.every((line) => line >= startLine && line < endLine + 1);        // + 1 to preserve <insert> at the end
            });

            if (coveredInLocation) {
                startLine = coveredInLocation.code_window_start_line;
                endLine = startLine + coveredInLocation.inline_labels.length;

                codeWindow = fileLines.slice(startLine, endLine);
                inlineLabels = coveredInLocation.inline_labels;
                interLabels = coveredInLocation.inter_labels;

                // interLabels.forEach((label, index) => {
                //     if (label === '<insert>') {
                //         inlineLabels[index] = '<add>';
                //     }
                // });

                // if (inlineLabels.length > codeWindow.length && endLine + inlineLabels.length - codeWindow.length < fileLines.length) {
                //     codeWindow.push(...fileLines.slice(endLine, endLine + inlineLabels.length - codeWindow.length));
                // }

                shouldUseOriginalCodeWindow = false;
            }
        }

        if (shouldUseOriginalCodeWindow) {
            statisticsCollector.addLog("action", "trace.generateEdits generator <- manual locations");

            startLine = fromLine;
            endLine = toLine + 1;

            codeWindow = fileLines.slice(startLine, endLine);
            interLabels = new Array(endLine - startLine + 1).fill('<null>');
            if (editType === 'add') {
                inlineLabels = new Array(endLine - startLine).fill('<add>');
            } else {
                inlineLabels = new Array(endLine - startLine).fill('<replace>');
            }
        } else {
            statisticsCollector.addLog("action", "trace.generateEdits generator <- suggested locations");
        }
        
        let contextStartLine = startLine;
        let contextEndLine = endLine;

        // Do we need to add more context beyond the locator response code window?
        // We need, if the code window is from user selection, not the locator

        const contextLinesBefore = 3;
        const contextLinesAfter = 3;

        contextStartLine = Math.max(startLine - contextLinesBefore, 0);
        contextEndLine = Math.min(endLine + contextLinesAfter, fileLines.length);

        const codeWindowContextBefore = fileLines.slice(contextStartLine, startLine);
        const codeWindowContextAfter = fileLines.slice(endLine, contextEndLine);
        codeWindow = [codeWindowContextBefore, codeWindow, codeWindowContextAfter].flat();
        
        const inlineLabelsBefore = new Array(codeWindowContextBefore.length).fill('<keep>');
        const inlineLabelsAfter = new Array(codeWindowContextAfter.length).fill('<keep>');
        inlineLabels = [inlineLabelsBefore, inlineLabels, inlineLabelsAfter].flat();

        const interLabelsBefore = new Array(codeWindowContextBefore.length).fill('<null>');
        const interLabelsAfter = new Array(codeWindowContextAfter.length).fill('<null>');
        interLabels = [interLabelsBefore, interLabels, interLabelsAfter].flat();


        const {
            editsWithTimestamp,
            lspType,
            fullLspFoundLocations,
            cachedRenameOperation
        } = await globalEditInfoCollector.exportAnalyzedEdits();

        const requestEdits = editsWithTimestamp.map(e => convertToRequestEdit(e));

        let replacementStringsOfEntireBlock = await requestEdit(
            globalEditorState.language,
            activeDocument.uri.fsPath,
            contextStartLine,
            codeWindow,
            interLabels,
            inlineLabels,
            commitMessage,
            requestEdits,
            lspType,
            lspType
        );

        if (!replacementStringsOfEntireBlock) { return; }

        statisticsCollector.addLog("action", "trace.generateEdits generator ->");
        
        // Remove syntax-level unchanged replacements
        // TODO specify this step to a function
        replacementStringsOfEntireBlock = replacementStringsOfEntireBlock.filter((snippet: string) => snippet.trim() !== codeWindow.join('').trim());

        // deduplication
        const uniqueReplacementStrings = new Set<string>();
        const filteredReplacementStrings = replacementStringsOfEntireBlock.filter((snippet: string) => {
            if (uniqueReplacementStrings.has(snippet)) {
                return false;
            } else {
                uniqueReplacementStrings.add(snippet);
                return true;
            }
        });
        replacementStringsOfEntireBlock = filteredReplacementStrings;

        // rank by length, note that the sorting is stable
        // replacementStringsOfEntireBlock.sort((a: string, b: string) => {
        //     const aLength = a.length;
        //     const bLength = b.length;
        //     if (aLength === bLength) return 0;
        //     return aLength < bLength ? -1 : 1;
        // });

        // limit number
        const maxEdits = 5;
        if (replacementStringsOfEntireBlock.length > maxEdits) {
            replacementStringsOfEntireBlock = replacementStringsOfEntireBlock.slice(0, maxEdits);
        }

        const selector = new EditSelector(
            toPosixPath(uri.fsPath),
            contextStartLine,
            contextEndLine,
            replacementStringsOfEntireBlock,
            tempWrite,
            editType === 'add'
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
            vscode.commands.registerCommand("trace.predictLocations", predictLocationByTRACE),
            vscode.commands.registerCommand("trace.clearLocations", async () => {
                statisticsCollector.addLog("command", "trace.clearLocations");

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
            vscode.commands.registerCommand("trace.generateEdits", predictEdit)
		);
    }
    
    registerEditSelectionCommands() {
        function getSelectorOfCurrentTab() {
            const currTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
            if (currTab && currTab.input instanceof vscode.TabInputTextDiff) {
                const selector = diffTabSelectors.get(currTab.input.modified.toString());
                // if (selector) {
                //     selector.manuallyEdited = false;
                // }
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
            if (selector) {
                await selector.clearEdit();
            } else {
                await globalQueryContext.dismissRefactor();
            }
        }
        async function acceptEdit() {
            const selector = getSelectorOfCurrentTab();
            if (selector) {
                await selector.acceptEdit();
            } else {
                await globalQueryContext.applyRefactor();
            }
        }
        return vscode.Disposable.from(
            vscode.commands.registerCommand("trace.lastSuggestion", async () => {
                statisticsCollector.addLog("command", "trace.lastSuggestion");

                await switchEdit(-1);
            }),
            vscode.commands.registerCommand("trace.nextSuggestion", async () => {
                statisticsCollector.addLog("command", "trace.nextSuggestion");

                await switchEdit(1);
            }),
            vscode.commands.registerCommand("trace.acceptEdit", async () => {
                statisticsCollector.addLog("command", "trace.acceptEdit");

                globalEditorState.toPredictLocation = true;
                await acceptEdit();
                globalQueryContext.clearResults();
                // await closeTab();
            }),
            vscode.commands.registerCommand("trace.dismissEdit", async () => {
                statisticsCollector.addLog("command", "trace.dismissEdit");

                await clearEdit();
                // await closeTab();
            })
        );
    }
}

export {
    GenerateEditCommand, PredictLocationCommand, predictLocation,
    predictLocationIfHasEditAtSelectedLine
};

