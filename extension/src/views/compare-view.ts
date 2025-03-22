import vscode from 'vscode';
import crypto from 'crypto';
import util from 'util';
import path from 'path';
import { DisposableComponent } from '../utils/base-component';
import { defaultLineBreak, globalQueryContext } from '../global-result-context';
import { globalEditorState } from '../global-workspace-context';
import { statisticsCollector } from '../statistics';

class BaseTempFileProvider extends DisposableComponent implements vscode.FileSystemProvider {
    private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;
    onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
    
    constructor() {
        super();
        this._onDidChangeFile = new vscode.EventEmitter();
        this.onDidChangeFile = this._onDidChangeFile.event;
    }
    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        throw new Error('Method not implemented.');
    }
    createDirectory(uri: vscode.Uri): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
        throw new Error('Method not implemented.');
    }
    writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    delete(uri: vscode.Uri, options: { readonly recursive: boolean; }): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    copy?(source: vscode.Uri, destination: vscode.Uri, options: { readonly overwrite: boolean; }): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        return { dispose: () => { } };
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        return {
            type: vscode.FileType.File,
            ctime: Date.now(),
            mtime: Date.now(),
            size: 0
        };
    }
}

class CompareTempFileProvider extends BaseTempFileProvider {
    tempFiles: Map<string, Uint8Array>;
    
    constructor() {
        super();
        this.tempFiles = new Map();

        this.register(
            vscode.workspace.registerFileSystemProvider("temp", this, { isReadonly: false })
        );
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; } = { create: true, overwrite: true }) {
        this.tempFiles.set(uri.path, content);
    }

    async readFile(uri: vscode.Uri) {
        const content = this.tempFiles.get(uri.path);
        if (content !== undefined) {
            return content;
        } else {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    getAsyncWriter() {
        return (async (path: string, str: string) => {
            const encoder = new util.TextEncoder();
            const tempUri = vscode.Uri.parse(`temp:${path}`);
            await this.writeFile(tempUri, encoder.encode(str));
            return tempUri;
        }).bind(this);
    }
}

const compareTempFileSystemProvider = new CompareTempFileProvider();
const tempWrite = compareTempFileSystemProvider.getAsyncWriter();
const diffTabSelectors: Map<string, EditSelector> = new Map();

export async function createVirtualModifiedFileUri(originalUri: vscode.Uri, text: string) {
   return await tempWrite(originalUri.fsPath, text);
}

/**
 * Use a series of suggested edits to generate a live editable diff view for the user to make the decision
 */
class EditSelector {
    /** Absolute path in the local file system */
    path: string;
    fromLine: number;
    toLine: number;
    edits: string[];
    tempWrite: (path: string, str: string) => Promise<vscode.Uri>;
    isAdd: boolean;
    originalContent: string;
    modAt: number;
    modifiedUri: vscode.Uri;

    tempUri?: vscode.Uri;
    document?: vscode.TextDocument;
    id?: string;
    pathId?: string;

    private _editCounterLensDisposable: vscode.Disposable | undefined;
    private _compareViewOnCloseDisposable: vscode.Disposable | undefined;

    constructor(
        path: string,
        fromLine: number,
        toLine: number,
        edits: string[],
        tempWrite: (path: string, str: string) => Promise<vscode.Uri>,
        isAdd: boolean = false
    ) {
        this.path = path;
        this.fromLine = fromLine;
        this.toLine = toLine; // toLine is exclusive
        this.edits = edits;
        this.tempWrite = tempWrite;
        this.isAdd = isAdd;

        this.originalContent = "";
        this.modifiedUri = vscode.Uri.file(this.path);

        this.modAt = 0;
        this.setSelectedModification(0);
    }

    async init() {
        // Save the original content
        this.document = await vscode.workspace.openTextDocument(this.path);
        this.originalContent = this.document.getText();

        // Store the originalContent in a temporary readonly file system
        this.id = this._getPathId();
        this.tempUri = await this.tempWrite(
            `/${this.id}`,
            this.originalContent
        );

        // Register code lens to show which edit we're on
        // this._editCounterLensDisposable = vscode.languages.registerCodeLensProvider(
        //     [
        //         {
        //             scheme: this.tempUri?.scheme ?? 'temp',
        //             pattern: this.tempUri?.path ?? ''
        //         },
        //         {
        //             scheme: this.modifiedUri.scheme,
        //             pattern: this.modifiedUri.path
        //         }
        //     ],
        //     {
        //         provideCodeLenses: (_) => {
        //             return [
        //                 new vscode.CodeLens(
        //                     new vscode.Range(0, 0, 0, 0),
        //                     {
        //                         title: `Edit ${this.modAt + 1}/${this.edits.length}`,
        //                         command: 'workbench.action.closeActiveEditor'
        //                     }
        //                 )
        //             ];
        //         }
        //     }
        // );

        // Register a listener to reset the edit when the compare view is closed
        this._compareViewOnCloseDisposable = vscode.window.tabGroups.onDidChangeTabs((e) => {
            if (e.closed.some(tab => this.matchTab(tab))) {
                statisticsCollector.addLog("action", "Edit is closed without accepted");

                this.clearEdit();
                this.dispose();
            }
        });
    }
    
    dispose() {
        this._compareViewOnCloseDisposable?.dispose();

        if (this._editCounterLensDisposable) {
            this._editCounterLensDisposable.dispose();
            this._editCounterLensDisposable = undefined;
        }
        
        diffTabSelectors.delete(this.modifiedUri.toString());
        // FIXME not cleaning tempWrite could lead to memory leak
    }

    /**
     * Find the editor where the document is open then change its 
     * @param {*} replacement 
     */
    async _performMod(replacement: string) {
        const x = this.originalContent.match(/\r?\n|\n/);
        const lineBreak = x?.at(0) ?? defaultLineBreak;
        
        const _lines = this.originalContent.split(lineBreak);
        const isAdd = this.isAdd || _lines.some(line => line.startsWith('<add>'));
        const lines = _lines.map(line => line.replace(/^<add>/, ''));
        
        const numLines = _lines.length + 1;
        const fromLine = Math.max(0, this.fromLine);
        // If change type is "add", simply insert replacement content at the first line 
        const toLine = isAdd ? fromLine : Math.min(this.toLine, numLines);
        
        const modifiedText = (lines.slice(0, fromLine)).join(lineBreak)
            + (fromLine > 0 ? lineBreak : '')
            + replacement
            // + (toLine < numLines ? lineBreak : '')   // there is already a linebreak at the end of the replacement now
            + (lines.slice(toLine, numLines)).join(lineBreak);
        
        // FIXME don't replace the whole document. Use a partial replacement method.
        this._replaceDocument(modifiedText);
    }

    async _replaceDocument(fullText: string, useOpenedDocument: boolean = false) {
        if (!this.document) {
            return;
        }

        // NOTE When there are multiple editors pointing to this document
        // and the one of them selected here is closing, the replacement could possibly be invalidated
        // and other editors could remain unchanged!

        // And tested, the visibleTextEditors could be the editor closing
        // While only after calling openTextDocument manually could the activeTextEditor be correctly redirected to the original code file

        let editor: vscode.TextEditor | undefined;

        if (useOpenedDocument) {
            // if (vscode.window.activeTextEditor?.document.uri.toString() === vscode.Uri.file(this.path).toString()) {
            
            // const openedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(this.path));

            // https://stackoverflow.com/questions/71990370/vscode-api-editor-edit-editbuilder-replace-fails-without-reason-possibly-due-t
            // If we must use the "switched to original" document, try after small delay, strange failure on Windows
            // (vscode edit document api is so awkward and inconsistent..)
            await new Promise(resolve => setTimeout(resolve, 200));
            
            if (vscode.window.activeTextEditor?.document?.uri.toString() === vscode.Uri.file(this.path).toString()) {
                editor = vscode.window.activeTextEditor;
            }
        } else {
            editor = vscode.window.visibleTextEditors.find(
                (editor) => editor.document === this.document
            );
        }

        if (!editor) {
            return;
        }
        
        const fullRange = new vscode.Range(
            this.document.positionAt(0),
            this.document.positionAt(this.document.getText().length)
        );
        
        await editor.edit(editBuilder => {
            editBuilder.replace(fullRange, fullText);
        }, { undoStopBefore: false, undoStopAfter: false });
    }

    async _showDiffView() {
        // Open a diff view to compare the original and the modified document
        // TODO no longer show index of suggestion here, but as a CodeLens over the line of edit
        await vscode.commands.executeCommand('vscode.diff',
            this.tempUri,
            this.modifiedUri,
            `EDIT: ${path.basename(this.path)}`
        );

        // const tabGroups = vscode.window.tabGroups;
        // const activeTab = tabGroups.activeTabGroup.activeTab;
        diffTabSelectors.set(this.modifiedUri.toString(), this);
        // let removeSelectorEvent = null;

        // const tabMatch = (tab: vscode.Tab) => {
        //     const input = tab.input;
        //     return input instanceof vscode.TabInputTextDiff
        //         && input.original.toString() == this.tempUri.toString()
        //         && input.modified.toString() == this.modifiedUri.toString();
        // }
        // const event = tabGroups.onDidChangeTabs((e) => {
        //     if (e.closed.some(tabMatch) && !e.opened.some(tabMatch)) {
        //         diffTabSelectors.delete(activeTab);
        //         removeSelectorEvent.dispose();
        //     }
        // });
        // removeSelectorEvent = event;
    }

    async editDocumentAndShowDiff() {
        await this._performMod(this.edits[this.modAt]);
        // if (globalEditorState.inDiffEditor) {     // refresh existed diff editor
        //     await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        // }
        await this._showDiffView();
    }

    async switchEdit(offset = 1) {
        const modAt = (this.modAt + offset + this.edits.length) % this.edits.length;
        this.setSelectedModification(modAt);
        await this.editDocumentAndShowDiff();
    }

    async clearEdit() {
        // await vscode.commands.executeCommand('undo');
        await this.safeClose();
        await this._replaceDocument(this.originalContent, true);
        // await this.clearRelatedLocation();
    }

    async clearRelatedLocation() {
        const locations = globalQueryContext.getLocations();
        if (locations) {
            const _locs = locations.slice();
            _locs.forEach((loc, i) => {
                const offset = loc.editType === "add" ? 1 : 0;
                // TODO this detection of "applied edit" could be buggy？Especially when the URI is different
                if (loc.atLines
                && loc.atLines[0] + offset < this.toLine
                && loc.atLines[loc.atLines.length - 1] + 1 + offset > this.fromLine) {
                    _locs.splice(i, 1);
                }
            });
            globalQueryContext.updateLocations(_locs);
        }
    }

    async acceptEdit() {
        await this.clearRelatedLocation();
        await this.safeClose();
        await vscode.workspace.save(vscode.Uri.file(this.path));
        
        let e;
        if (e = vscode.window.activeTextEditor) {
            e.selection = new vscode.Selection(e.selection.start, e.selection.start);
        }
    }

    _getPathId() {
        this.pathId = crypto.createHash('sha256').update(this.path).digest('hex') + path.extname(this.path);
        return this.pathId;
    }

    matchActiveEditor() {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;

        return this.matchTab(activeTab);
    }

    matchTab(tab: vscode.Tab | undefined) {
        return tab
            && tab.input instanceof vscode.TabInputTextDiff
            && tab.input.original.toString() === this.tempUri?.toString()
            && tab.input.modified.toString() === this.modifiedUri.toString();
    }

    async safeClose() {
        this.dispose();
        if (this.matchActiveEditor()) {
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        }
    }

    private setSelectedModification(i: number) {
        this.modAt = i;

        const hasPrevious = i > 0;
        const hasNext = i < this.edits.length - 1;
        vscode.commands.executeCommand('setContext', 'trace:hasPreviousSuggestion', hasPrevious);
        vscode.commands.executeCommand('setContext', 'trace:hasNextSuggestion', hasNext);
    }
}

// class DiffTabCodelensProvider extends BaseComponent {
//     constructor() {
//         super();
//         this.originalContentLabel = "Original";
//         this.modifiedContentLabel = "Modified";
//         this._onDidChangeCodeLenses = new vscode.EventEmitter();
// 	    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
//         this.register(
//             // vscode.languages.registerCodeLensProvider("*", this),
//             vscode.window.onDidChangeActiveTextEditor(() => {
//                 console.log("+++ firing code lenses");
//                 this._onDidChangeCodeLenses.fire();
//             })
//         );
//     }
    
//     provideCodeLenses(document, token) {
//         this.codelenses = [];
//         if (document.uri.scheme === 'temp') {
//             this.codelenses.push(this.codelenseAtTop(this.originalContentLabel));
//         }
//         else if (document.uri.scheme === 'file') {
//             for (const [tab, selector] of diffTabSelectors) {
//                 if (selector.path == toPosixPath(document.path)) {
//                     this.codelenses.push(this.codelenseAtTop(this.modifiedContentLabel));
//                     break;
//                 }
//             }
//         }
//         return this.codelenses;
//     }

//     resolveCodeLens(codeLens, token) {
//         return codeLens;
//     }

//     codelenseAtTop(title) {
//         return new vscode.CodeLens(
//             new vscode.Range(0, 0, 0, 0),
//             {
//                 title: title
//             }
//         )
//     }
// }

export {
    EditSelector,
    CompareTempFileProvider,
    diffTabSelectors,
    compareTempFileSystemProvider,
    tempWrite,
    // DiffTabCodelensProvider
};
