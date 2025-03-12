import os from "os";
import vscode from "vscode";
import { DisposableComponent } from "./utils/base-component";
import { LineBreak, LocatorLocation, SingleLineEdit, FileEdits } from "./utils/base-types";
import { HighlightedLocation, LocationResultDecoration } from "./ui/location-decoration";
import { globalLocationViewManager, globalRefactorPreviewTreeViewManager } from "./views/location-tree-view";
import { findFirstDiffPos } from "./utils/utils";
import { getLineInfoInDocument } from "./utils/file-utils";
import { diffWords } from "diff";
import { CodeRangesInFile } from "./editor-state-monitor";
import { ResponseEditLocationWithLabels, ResponseNavEditLocator } from "./services/backend-requests";

// TODO consider using/transfering to `async-lock` for this
class EditLock {
    isLocked: boolean = false;

    async tryWithLock(asyncCallback: (...args: any[]) => any) {
        if (this.isLocked) return undefined;
        this.isLocked = true;
        try {
            return await Promise.resolve(asyncCallback());
        } catch (err: any) {
            console.error(`Error occured when running in edit lock (async): \n${err.stack}`);
            // throw err;
        } finally {
            this.isLocked = false;
        }
    }
}

class QuerySettings {
    private commitMessage?: string;

    async requireCommitMessage() {
        if (this.commitMessage) {
            return this.commitMessage;
        }

        return await this.inputCommitMessage();
    }

    async inputCommitMessage() {
        const userInput = await vscode.window.showInputBox({
            prompt: 'Enter a description of edits you want to make.',
            placeHolder: 'Add a feature...',
            ignoreFocusOut: true,
            value: this.commitMessage ?? '',
            title: "Edit Description"
        });
        
        if (userInput) {
            this.commitMessage = userInput;
        }
        return userInput;   // returns undefined if canceled
    }
}

/**
 * This class manages an successfully produced location result,
 * i.e., its data, ui, and lifecycle
 */
class LocationResult {
    private readonly locations: LocatorLocation[] = [];
    
    private decoration: LocationResultDecoration;

    constructor(locations: LocatorLocation[]) {
        this.locations = locations;
        this.decoration = new LocationResultDecoration({
            type: 'original-locator-request',
            locations: this.locations
        });
        this.decoration.show();
        globalLocationViewManager.reloadLocations(this.locations);
    }

    getLocations() {
        return this.locations;
    }

    dispose() {
        this.decoration.dispose();
        // TODO there could be multiple sets of locations existing at the same time
        // use a manager class for each
        globalLocationViewManager.reloadLocations([]);
    }
}

/**
 * NavEdit predicted locations with labels on each line,
 * which could contain a set of edits.
 */
class NavEditLocationResult {
    /** Indexed as [URI String] -> [Location Results] */
    private readonly locations: Map<string, ResponseEditLocationWithLabels[]>;
    
    private decoration: LocationResultDecoration;

    constructor(locations: [vscode.Uri, ResponseEditLocationWithLabels[]][]) {
        this.locations = new Map(locations.map(([uri, loc]) => [uri.toString(), loc]));

        const highlightedLocations: HighlightedLocation[] = Array.from(locations.entries()).reduce((acc, [i, [uri, locs]]) => {
            locs.forEach(loc => {
                const editType = loc.inline_labels.every((loc) => loc === 'add') ? 'add' : 'replace';
                    
                // push the first continuous non-keep sequence of lines
                let startLine = loc.code_window_start_line;
                let endLine = startLine;
                for (let i = 0; i < loc.inline_labels.length; i++) {
                    if (loc.inline_labels[i] !== '<keep>') {
                        endLine = startLine + i;
                    } else {
                        if (startLine !== endLine) {
                            break;
                        }
                        startLine = startLine + i + 1;
                    }
                }

                acc.push({
                    location: new vscode.Location(
                        uri,
                        new vscode.Range(
                            startLine,
                            0,
                            endLine,
                            Number.MAX_SAFE_INTEGER
                        )
                    ),
                    type: editType
                });
            });

            return acc;
        }, [] as HighlightedLocation[]);
        
        // FIXME This type of decoration is unused. The decoration is delegated to a traditional LocationResult
        this.decoration = new LocationResultDecoration({
            type: 'plain-location',
            locations: []
        });

        // FIXME This has no effect on the tree view, and is delegated to a traditional LocationResult
        // this.convertHighlightedLocationsToTraditionalLocation(highlightedLocations)
        //     .then(convertedLocations => globalLocationViewManager.reloadLocations(Array.from(convertedLocations)));
    }

    /** Indexed as [URI String] -> [Location Results] */
    getLocations() {
        return this.locations;
    }

    dispose() {
        this.decoration.dispose();
        // TODO there could be multiple sets of locations existing at the same time
        // use a manager class for each

        // FIXME This has no effect on the tree view, and is delegated to a traditional LocationResult
        // globalLocationViewManager.reloadLocations([]);
    }

    private async convertHighlightedLocationsToTraditionalLocation(highlightedLocations: HighlightedLocation[]): Promise<LocatorLocation[]> {
        const locations: LocatorLocation[] = await Promise.all(highlightedLocations.map(async (hl) => {
            const uri = hl.location.uri.fsPath;
            const startLine = hl.location.range.start.line;
            const endLine = hl.location.range.end.line - (hl.location.range.end.character === 0 ? 1 : 0);
            const editType = hl.type === 'add' ? 'add' : 'replace';

            // TODO should we let the tree view compute the text?
            return {
                targetFilePath: uri,
                atLines: [startLine, endLine],  // FIXME this is so unstable using only the first and last line
                editType,
                lineBreak: defaultLineBreak,
                lineInfo: {
                    range: hl.location.range,
                    text: await this.fetchTextFromLocation(hl.location.uri, startLine, endLine)
                }
            };
        }));
        return locations;
    }

    private async fetchTextFromLocation(uri: vscode.Uri, startLine: number, endLine: number): Promise<string> {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (!doc) return '';
        const lines = doc.getText(new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER));
        return lines;
    }
}

class SingleRefactorResult {
    private readonly refactorOperation: Refactor;
    
    private fileEdits: FileEdits[] = [];

    constructor(refactorOperation: Refactor) {
        this.refactorOperation = refactorOperation;
    }

    async openRefactorPreview() {

    }

    async apply() {
        for (const fileEdit of this.fileEdits) {
            // TODO how to perform refactor in background in VS Code
            const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileEdit[0]), { preserveFocus: true });
            editor.edit((editBuilder) => {
                fileEdit[1].forEach((edit) => {
                    editBuilder.replace(edit.range, edit.newText);
                });
            });
        }
    }

    async closeRefactorPreview() {
        // close the tab that is displaying the multi-diff preview
        for (const fileEdit of this.fileEdits) {
            const editors = vscode.window.visibleTextEditors;
            for (const e of editors) {
                console.log(e.document.uri.toString());
            }
            const editor = editors.find((editor) => editor.document.uri.fsPath === fileEdit[0].fsPath);
            if (editor) {
                editor.hide();
            }
        }
    }
    
    async resolve() {
        this.fileEdits = await this.refactorOperation.resolveLocations();
        globalRefactorPreviewTreeViewManager.reloadLocations(this.fileEdits);
    }

    dispose() {
        globalRefactorPreviewTreeViewManager.reloadLocations([]);
    }
}

// abstract class RefactorType {
//     resolve() { };
// }

export async function createRenameRefactor(file: string, line: number, beforeText: string, afterText: string): Promise<RenameRefactor | undefined> {
    const currentWorkspaceFolderUri = vscode.workspace.workspaceFolders?.[0].uri;
    if (!currentWorkspaceFolderUri) return undefined;
    const fileUri = vscode.Uri.joinPath(currentWorkspaceFolderUri, file);

    // TODO this location does not contain line break
    const location = new vscode.Location(fileUri, (await getLineInfoInDocument(fileUri.fsPath, line)).range);
    return new RenameRefactor({
        location,
        beforeContent: beforeText,
        afterContent: afterText
    });
}

export function createDeterminedRenameRefactor(newName: string, renameRangesInFiles: CodeRangesInFile[]) {
    const fileEdits: FileEdits[] = [];
    for (const rangesInFile of renameRangesInFiles) {
        const renameUri = rangesInFile.uri;
        const fileEdit: FileEdits = [renameUri, []];

        for (const range of rangesInFile.ranges) {
            const textEdit = new vscode.TextEdit(range, newName);
            fileEdit[1].push(textEdit);
        }
        fileEdits.push(fileEdit);
    }
    return new DeterminedRenameRefactor(fileEdits);
}

export interface Refactor {
    resolveLocations(): Promise<FileEdits[]>;
}

export class RenameRefactor implements Refactor {
    private readonly firstRename: SingleLineEdit;
    private resolvedEdits: FileEdits[] = [];

    constructor(firstRename: SingleLineEdit) {
        this.firstRename = firstRename;
    }

    async resolveLocations(): Promise<FileEdits[]> {
        // simulate an edit to find the reference
        const { location: loc, beforeContent: bc, afterContent: ac } = this.firstRename;

        const editor = await vscode.window.showTextDocument(loc.uri);
        if (!editor) return [];

        const lineNum = loc.range.start.line;
        const line = editor.document.lineAt(lineNum);

        const firstDiffPos = findFirstDiffPos(bc, ac);
        if (firstDiffPos > line.range.end.character) return [];

        const diffs = diffWords(bc, ac);
        const firstReplacedWord = diffs.find(d => d.added)?.value;
        if (!firstReplacedWord) return [];
        
        // TODO Due to writing this as async/await, setting a promise seems to be unnecessary
        let getEditsResolve: any;
        const getEditsPromise = new Promise((res) => {
            getEditsResolve = res;
        }).then((editEntries: any) => {
            // TODO filtering the first as "edited rename" is not accurate, need check
            const refactorEdits: FileEdits[] = editEntries;
            const firstFileEdits = refactorEdits[0];
            if (firstFileEdits) {
                firstFileEdits[1] = firstFileEdits[1].slice(1);
            }
            return editEntries;
        });

        // show a progress message
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Analyzing rename..." }, async () => {

            await editor.edit((editBuilder) => {
                editBuilder.replace(line.range, bc);
            }, {
                undoStopBefore: false,
                undoStopAfter: false
            });

            // const linePattern = /.*?(\r\n?|\n|$)/g;  // empty new line at end when it ends with line break
            // const virtualDoc = editor.document.getText().match(linePattern) ?? [];  // this is not possible to be null / empty array, just a prevention
            // virtualDoc[loc.range.start.line] = bc;
            // const virtualDocText = virtualDoc.join('');
            // const modifiedProxyFileUri = await createVirtualModifiedFileUri(loc.uri, virtualDocText);
            // console.log(`text: ${(await vscode.workspace.openTextDocument(modifiedProxyFileUri)).getText()}`);

            // find that it returns WorkspaceEdit here, we use it instead of our own RangeEdit
            const targetWorkspaceEdit: vscode.WorkspaceEdit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider',
                loc.uri, line.range.start.translate(0, firstDiffPos), firstReplacedWord
            );
            getEditsResolve(targetWorkspaceEdit.entries());

            await editor.edit((editBuilder) => {
                editBuilder.replace(line.range, ac);
            }, {
                undoStopBefore: false,
                undoStopAfter: false
            });
        });

        this.resolvedEdits = await getEditsPromise;
        return this.resolvedEdits;
        // const doc = vscode.workspace.
    }
}

export class DeterminedRenameRefactor implements Refactor {
    private determinedEdits: FileEdits[];

    constructor(determinedEdits: FileEdits[]) {
        this.determinedEdits = determinedEdits;
    }
    async resolveLocations(): Promise<FileEdits[]> {
        return this.determinedEdits;
    }
}

class QueryContext extends DisposableComponent {
    readonly querySettings: QuerySettings = new QuerySettings();
    activeLocationResult?: LocationResult;
    activeNavEditLocationResult?: NavEditLocationResult;
    activeRefactorResult?: SingleRefactorResult;

    constructor() {
        super();
        this.register(
            vscode.commands.registerCommand('navEdit.inputMessage', () => {
                this.querySettings.inputCommitMessage();
            })
        );
    }

    clearResults() {
        this.activeLocationResult?.dispose();
        this.activeRefactorResult?.dispose();
        this.activeLocationResult = undefined,
        this.activeRefactorResult = undefined;
    }

    getLocations() {
        return this.activeLocationResult?.getLocations();
    }

    updateLocations(locations: LocatorLocation[]) {
        // cannot use destructor() here due to JavaScript nature
        this.clearResults();
        this.activeLocationResult = new LocationResult(locations);
    }

    updateNavEditLocations(locationsByFile: { [filePath: string]: ResponseEditLocationWithLabels[] }) {
        const confidenceThreshold = 0.0;

        // filter out non-keep inline label confidence < 80%, THIS IS IN-PLACE!
        for (const filePath in locationsByFile) {
            const fileLocations = locationsByFile[filePath];
            locationsByFile[filePath] = fileLocations.filter((loc) => {
                const inlineLabels = loc.inline_labels;
                const confidence = loc.inline_confidences;

                // filter out low confidence
                return inlineLabels.every((label, index) => {
                    if (label !== '<keep>' && confidence[index] < confidenceThreshold) {
                        return false;
                    }
                    return true;
                });
            });
        }


        // FIXME this is a temporary solution, reusing the old locations for conversion to old decoration
        (async () => {
            const convertedLocations: LocatorLocation[] = [];
            for (const filePath in locationsByFile) {
                const editLocationsInFile = locationsByFile[filePath];
                for (const editLocation of editLocationsInFile) {
                    const startLine = editLocation.code_window_start_line;
                    const labels: [string, number, number][] = [];

                    editLocation.inline_labels.forEach((label: string, index: number) => {
                        if (label !== '<keep>') {
                            if (labels.length === 0 || labels.at(-1)?.[0] !== label) {
                                labels.push([label, startLine + index, 0]);
                            }
                            const lastLabel = labels.at(-1);
                            if (lastLabel) {
                                lastLabel[2] += 1;
                            }
                        }
                        // deal with <insert> label in inter_line labels
                        if (editLocation.inter_labels[index] === '<insert>') {
                            labels.push(['<add>', startLine + index, 1]);
                        }
                    });

                    if (editLocation.inter_labels.length > editLocation.inline_labels.length) {
                        const index = editLocation.inter_labels.length - 1;
                        if (editLocation.inter_labels[index] === '<insert>') {
                            labels.push(['<add>', startLine + index, 1]);
                        }
                    }
        
                    for (const [label, start, lines] of labels) {
                        const _label = label.slice(1, -1);
        
                        convertedLocations.push({
                            targetFilePath: filePath,
                            // FIXME strip <delete> to delete should not use this way
                            editType: _label === 'delete' ? 'remove' :
                                _label === 'add' ? 'add' : 'replace',
                            lineBreak: '\n',
                            atLines: Array(lines).fill(0).map((_, i) => start + i),
                            lineInfo: await getLineInfoInDocument(filePath, start)
                        });
                    }
                }
            }

            // deduplication, remove all precedent overlapping locations
            const uniqueLocations: LocatorLocation[] = [];
            for (const loc of convertedLocations) {
                if (!uniqueLocations.some(
                    (l) => l.targetFilePath === loc.targetFilePath
                        && (l.atLines[0] <= loc.atLines[loc.atLines.length - 1] && l.atLines[l.atLines.length - 1] >= loc.atLines[0])
                )) {
                    uniqueLocations.push(loc);
                }
            }

            this.updateLocations(uniqueLocations);
        })();
        
        // On the other hand, update the real location
        this.clearResults();
        const locations: [vscode.Uri, ResponseEditLocationWithLabels[]][] = [];
        for (const filePath in locationsByFile) {
            const uri = vscode.Uri.file(filePath);
            const fileLocations = locationsByFile[filePath];

            locations.push([uri, fileLocations]);
        }
        this.activeNavEditLocationResult = new NavEditLocationResult(locations);
    }

    updateRefactor(refactor: Refactor) {
        this.clearResults();
        this.activeRefactorResult = new SingleRefactorResult(refactor);
        this.activeRefactorResult.resolve();
    }

    // TODO this is not a good entrance of accessing from refactor result from outside
    async applyRefactor() {
        await this.activeRefactorResult?.apply();
        await this.activeRefactorResult?.closeRefactorPreview();
    }
}

export const globalEditLock = new EditLock();
export const globalQueryContext = new QueryContext();

export const supportedOSTypes = ['Windows_NT', 'Darwin', 'Linux'];
export const osType = os.type();

if (!supportedOSTypes.includes(osType)) {
    throw RangeError(`Operating system (node detected: ${osType}) is not supported yet.`);
}

export const defaultLineBreaks: { [key: string]: LineBreak } = {
    'Windows_NT': '\r\n',
    'Darwin': '\r',
    'Linux': '\n'
};
export const defaultLineBreak: LineBreak = defaultLineBreaks[osType] ?? '\n';
