import * as vscode from 'vscode';
import { globalEditorState } from './global-workspace-context';
import { statusBarItem } from './ui/progress-indicator';
import { Change, diffLines } from 'diff';
import { RequestEdit, EditWithTimestamp, FileAsHunks } from "./utils/base-types";
import { DisposableComponent } from "./utils/base-component";
import { getOpenedFilePaths, getOpenedFileUris, getStagedFile, readMostRelatedFiles } from './utils/file-utils';
import { globalQueryContext } from './global-result-context';
import { extractBlock, splitLines } from './utils/utils';
import { PreJudgedLspType, RequestLspFoundLocation } from './services/backend-requests';
import { CachedRenameOperation } from './services/query-processes';
import { search } from 'fast-fuzzy';

class WorkspaceEditInfoCollector implements vscode.Disposable {
    private editWatcher: EditWatcher;

    constructor() {
        this.editWatcher = new EditWatcher();
    }

    dispose() {
        this.editWatcher.dispose();
    }

    watch(uri: vscode.Uri) {
        // console.log(`√ InfoCollector watching ${uri.toString()}`);
        this.editWatcher.watch(uri);
    }
    
    unwatch(uri: vscode.Uri) {
        // console.log(`× InfoCollector unwatching ${uri.toString()}`);
        this.editWatcher.unwatch(uri);
    }

    watchAllOpened() {
        const openedDocumentUris = getOpenedFileUris();
        for (const uri of openedDocumentUris) {
            this.watch(uri);
        }
    }

    clearHistory() {
        this.editWatcher.clearHistory();
        this.watchAllOpened();
    }

    /** We often use this on AFTER-EDIT VERSION to determine what bugs should be fixed in current document */
    getAllDiagnosticInfo() {
        const allDiagnostics = vscode.languages.getDiagnostics();
        return allDiagnostics;
    }

    /** We often use this on BEFORE-EDIT VERSION to determine what locations should be changed together */
    async getAllClones(snippet: string, originalStartLine: number) {
        const allClones: Map<string, vscode.Location[]> = new Map();

        if (snippet.length === 0) {
            return allClones;
        }

        const allDocuments = await readMostRelatedFiles();
        // Use fast-fuzzy for fuzzy matching clones

        for (const [filePath, content] of allDocuments) {
            const uri = vscode.Uri.file(filePath);
            const lines = splitLines(content, false);
            
            // Search through each line of the file
            const matches = search(snippet, lines, {
                returnMatchData: true,
                threshold: 0.8 // Adjust threshold as needed (0.0 to 1.0)
            });

            const locations: vscode.Location[] = [];
            
            for (const match of matches) {
            const lineIndex = lines.indexOf(match.item);
            if (lineIndex !== originalStartLine) { // Skip the original line
                const foundPos = new vscode.Position(lineIndex, 0);
                locations.push(
                new vscode.Location(
                    uri,
                    new vscode.Range(
                    foundPos,
                    new vscode.Position(lineIndex, match.item.length)
                    )
                )
                );
            }
            }

            if (locations.length > 0) {
            allClones.set(uri.toString(), locations);
            }
        }
        return allClones;
    }

    async exportEdits() {
        return this.editWatcher.collectEditsWithMatchedSyntaxInfo(false);
    }

    async exportEditsWithMatchedSyntaxInfo(lastOnly: boolean = false)  {
        return this.editWatcher.collectEditsWithMatchedSyntaxInfo(true, lastOnly);
    }

    async exportLspFoundLocationsForSymbolRange(symbolLspQuery: {
        type: 'def' | 'ref',
        fileUri: vscode.Uri,
        symbolName: string,
        symbolRange: vscode.Range
    }): Promise<RequestLspFoundLocation[]> {
        const lspFoundLocations: RequestLspFoundLocation[] = [];

        // const commandIdDefOrRef = symbolLspQuery.type === 'def' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider';
        // const allLspResults = await vscode.commands.executeCommand<vscode.Location[]>(
        //     commandIdDefOrRef,
        //     symbolLspQuery.fileUri,
        //     symbolLspQuery.symbolRange.end
        // );

        for (const queryType of ['def', 'ref']) {
            const queryCommand = queryType === 'def' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider';

            const lspResults = await vscode.commands.executeCommand<vscode.Location[]>(
                queryCommand,
                symbolLspQuery.fileUri,
                symbolLspQuery.symbolRange.end
            );
            if (!lspResults) continue;

            for (const lspResult of lspResults) {
                const foundLocation: RequestLspFoundLocation = {
                    file_path: lspResult.uri.fsPath,
                    start: {
                        line: lspResult.range.start.line,
                        col: lspResult.range.start.character
                    },
                    end: {
                        line: lspResult.range.end.line,
                        col: lspResult.range.end.character
                    },
                    type: queryType
                };
                lspFoundLocations.push(foundLocation);
            }
        }

        return lspFoundLocations;
    }

    async exportLspFoundLocationsForEdit(editWithSyntaxInfo: EditWithSyntaxInfo): Promise<CategorizedLspFoundLocations> {
        const lspFoundLocations: CategorizedLspFoundLocations = {
            def: [],
            ref: [],
            rename: [],
            clone: []
        };

        // Process def, ref and rename syntax info
        const syntaxInfoTypes = ['beforeSyntaxInfo', 'afterSyntaxInfo'] as const;
        for (const syntaxInfoType of syntaxInfoTypes) {
            const syntaxInfo = editWithSyntaxInfo[syntaxInfoType];
            if (!syntaxInfo) continue;

            for (const infoType of ['def', 'ref', 'rename'] as const) {
                const info = syntaxInfo[infoType];
                if (!info) continue;
                for (const [header, record] of info) {
                    let locations: CodeLocationInFile[] = [];
                    if ('allDefs' in record) {
                        locations = record.allDefs;
                    } else if ('allRefs' in record) {
                        locations = record.allRefs;
                    } else if ('allRenameRanges' in record) {
                        locations = record.allRenameRanges.flatMap(r => r.ranges.map(range => ({ uri: r.uri, range })));
                    }
                    for (const location of locations) {
                        const foundLocation: RequestLspFoundLocation = {
                            file_path: location.uri.fsPath,
                            start: {
                                line: location.range.start.line,
                                col: location.range.start.character
                            },
                            end: {
                                line: location.range.end.line,
                                col: location.range.end.character
                            },
                            type: infoType
                        };
                        lspFoundLocations[infoType].push(foundLocation);
                    }
                }
            }
        }

        // Process code clones
        const edit = editWithSyntaxInfo.edit;

        const blockWithContext = [edit.codeAbove, edit.rmText, edit.codeBelow].flat();
        const targetBlockToFindClone = extractBlock(blockWithContext);

        const foundClones = await this.getAllClones(targetBlockToFindClone.join(''), edit.line);
        for (const [uriString, locations] of foundClones) {
            const uri = vscode.Uri.parse(uriString);
            for (const location of locations) {
                const foundLocation: RequestLspFoundLocation = {
                    file_path: uri.fsPath,
                    start: {
                        line: location.range.start.line,
                        col: location.range.start.character
                    },
                    end: {
                        line: location.range.end.line,
                        col: location.range.end.character
                    },
                    type: 'clone'
                };
                lspFoundLocations.clone.push(foundLocation);
            }
        }

        return lspFoundLocations;
    }

    async exportLspFoundLocationsForDiagnose(sinceTimestamp?: number, onlyOnFile?: string): Promise<RequestLspFoundLocation[]> {
        const lspFoundLocations: RequestLspFoundLocation[] = [];

        // Process real-time diagnostic
        const latestAllDiagnosticInfo = this.getAllDiagnosticInfo();

        let diagnosticInfo = sinceTimestamp !== undefined
            ? this.editWatcher.findNewDiagnoseInfo(
                    sinceTimestamp,
                    Date.now(),
                    latestAllDiagnosticInfo
                )
            : latestAllDiagnosticInfo;

        for (const [uri, diagnostics] of diagnosticInfo) {
            if (onlyOnFile && uri.fsPath !== onlyOnFile) {
                continue;
            }
            for (const diagnostic of diagnostics) {
                const foundLocation: RequestLspFoundLocation = {
                    file_path: uri.fsPath,
                    start: {
                        line: diagnostic.range.start.line,
                        col: diagnostic.range.start.character
                    },
                    end: {
                        line: diagnostic.range.end.line,
                        col: diagnostic.range.end.character
                    },
                    type: 'diagnose'
                };
                lspFoundLocations.push(foundLocation);
            }
        }

        return lspFoundLocations;
    }

    async exportAnalyzedEdits() {
        // Only collect the last previous edit
        const currentPrevEditsInfo = await this.exportEditsWithMatchedSyntaxInfo(true);

        let cachedRenameOperation: CachedRenameOperation | undefined;

        let lspType: PreJudgedLspType = 'normal';
        if (currentPrevEditsInfo.length > 0) {
            // TODO 'rename' is detect by backend invoker, why not detect it here?
            for (const lspInfoTypeToDetect of ['def', 'ref'] as const) {
                for (const syntaxInfoType of ['beforeSyntaxInfo', 'afterSyntaxInfo'] as const) {
                    const detected = currentPrevEditsInfo[0][syntaxInfoType]?.[lspInfoTypeToDetect];
                    if (detected && detected.length > 0) {
                        switch (lspInfoTypeToDetect) {
                            case 'def':
                            case 'ref':
                                lspType = 'def&ref';
                                break;
                        }
                    }
                }
            }

            const renameInfo = currentPrevEditsInfo[0]['beforeSyntaxInfo']?.rename;
            if (renameInfo && renameInfo.length > 0) {
                const firstRenameInfo = renameInfo[0];
                cachedRenameOperation = {
                    identifier: firstRenameInfo[0].identifier,
                    ranges: firstRenameInfo[1].allRenameRanges
                };
            }
        }

        const fullLspFoundLocations: RequestLspFoundLocation[] = [];

        if (currentPrevEditsInfo.length > 0) {
            const lspFoundLocationsForEdit = await globalEditInfoCollector.exportLspFoundLocationsForEdit(currentPrevEditsInfo[0]);

            if (lspFoundLocationsForEdit.clone.length > 0 && lspType === 'normal') {
                lspType = 'clone';
            }

            fullLspFoundLocations.push(...[
                lspFoundLocationsForEdit.def,
                lspFoundLocationsForEdit.ref,
                lspFoundLocationsForEdit.rename,
                lspFoundLocationsForEdit.clone
            ].flat());
        }

        // FIXME diagnose is not enabled now

        // const lspFoundLocationsForDiagnose = await globalEditInfoCollector.exportLspFoundLocationsForDiagnose();
        // if (lspFoundLocationsForDiagnose.length > 0 && lspType === 'normal') {
        //     lspType = 'diagnose';
        // }
        // fullLspFoundLocations.push(...lspFoundLocationsForDiagnose);

        const requestEdits: RequestEdit[] = currentPrevEditsInfo.map(({ edit: editWithTimestamp }) => convertToRequestEdit(editWithTimestamp));

        return {
            requestEdits,
            lspType,
            fullLspFoundLocations,
            cachedRenameOperation
        };
    }
}

export type EditSyntaxInfo = {
    def: [SyntaxInfoEntryHeader, DefInfo][];
    ref: [SyntaxInfoEntryHeader, RefInfo][];
    rename: [SyntaxInfoEntryHeader, RenameInfo][];
    diagnostics?: DiagnosticInfo;
}

export type EditWithSyntaxInfo = {
    edit: EditWithTimestamp,
    beforeSyntaxInfo?: EditSyntaxInfo;
    afterSyntaxInfo?: EditSyntaxInfo;
}

/**
 * A one-stop class to collect and pre-process edits for query
 * with relevant syntax, diagnose and code-clone information
 */
class EditWatcher implements vscode.Disposable {
    private languageSyntaxRecorder: LanguageSyntaxRecorder;
    private editReducer: EditReducer;

    constructor() {
        this.languageSyntaxRecorder = new LanguageSyntaxRecorder();
        this.editReducer = new EditReducer();
    }

    dispose() {
        this.languageSyntaxRecorder.dispose();
        this.editReducer.clearEditsAndSnapshots();
    }

    watch(uri: vscode.Uri) {
        this.languageSyntaxRecorder.watch(uri);
        getStagedFile(getOpenedFilePaths(), uri.fsPath)
            .then((text) => {
                this.editReducer.addSnapshot(uri.toString(), text);
            })
            .catch((err) => {
                console.debug(`Cannot update snapshot on ${uri.fsPath}`);
            });
    }

    unwatch(uri: vscode.Uri) {
        this.languageSyntaxRecorder.unwatch(uri);
    }

    clearHistory() {        
        this.editReducer.clearEditsAndSnapshots();
    }

    /** 
     * Take a snapshot, compute, update and return the new edits 
     * 
     * @param withSyntaxInfo the URI string of the file to be updated
     * @param lastOnly if true, only the last edit will have its syntax information collected
     * @returns  each edit with its before and after syntax information
     */
    async collectEditsWithMatchedSyntaxInfo(withSyntaxInfo: boolean = true, lastOnly: boolean = false): Promise<EditWithSyntaxInfo[]> {
        await this.editReducer.updateEdits();
        let edits = await this.editReducer.getEditList();

        const defInfoMap = this.languageSyntaxRecorder.getDefInfoMap();
        const refInfoMap = this.languageSyntaxRecorder.getRefInfoMap();
        const renameInfoMap = this.languageSyntaxRecorder.getRenameInfoMap();
        
        // Take the best-match syntax info for the before and after version of each edit
        
        let changes: EditWithSyntaxInfo[] = edits.map(edit => ({
            edit: edit
        }));
        if (withSyntaxInfo) {
            const collectMatchedSyntaxInfo = (edit: EditWithTimestamp) => {
                const lastSnapshotTimestamp = this.editReducer.latestUpdateTimestamp.get(edit.uriString) ?? 0;   // if there has not recorded a timestamp, use the earliest info ever matched
    
                // NOTE for technical reason, we can only know the timestamp when the edit took place, not the timestamp of the version before edit
                // so how can we try out best to guarantee the consistency of `lastSnapshotTimestamp` with of the version before edit?
    
                const beforeEditInfo = {
                    def: this.findEditMatchedSyntaxInfo(edit.uriString, edit.line, edit.rmText[0] ?? '', lastSnapshotTimestamp, defInfoMap),
                    ref: this.findEditMatchedSyntaxInfo(edit.uriString, edit.line, edit.rmText[0] ?? '', lastSnapshotTimestamp, refInfoMap),
                    rename: this.findEditMatchedSyntaxInfo(edit.uriString, edit.line, edit.rmText[0] ?? '', lastSnapshotTimestamp, renameInfoMap)
                };
                
                const afterEditInfo = {
                    def: this.findEditMatchedSyntaxInfo(edit.uriString, edit.line, edit.addText[0] ?? '', edit.timestamp, defInfoMap),
                    ref: this.findEditMatchedSyntaxInfo(edit.uriString, edit.line, edit.addText[0] ?? '', edit.timestamp, refInfoMap),
                    rename: this.findEditMatchedSyntaxInfo(edit.uriString, edit.line, edit.addText[0] ?? '', edit.timestamp, renameInfoMap)
                };
    
                return {
                    edit: edit,
                    beforeSyntaxInfo: beforeEditInfo,
                    afterSyntaxInfo: afterEditInfo
                };
            };

            if (lastOnly && changes.length > 0) {
                changes.splice(-1, 1, collectMatchedSyntaxInfo(changes[changes.length - 1].edit));
            } else {
                changes = changes.map(change => collectMatchedSyntaxInfo(change.edit));
            }
        }
        
        return changes;
    }

    private findEditMatchedSyntaxInfo<T>(uri: string, line: number, lineText: string, timestamp: number, map: SyntaxInfoMap<T>): [SyntaxInfoEntryHeader, T][] {
        const matchedRecords: [SyntaxInfoEntryHeader, T][] = [];

        const uriEntry = map.map.get(uri);
        if (!uriEntry) return matchedRecords;

        const lineEntry = uriEntry.get(line);
        if (!lineEntry) return matchedRecords;

        for (const recordEntrySet of lineEntry.values()) {
            // Find first record that is right after the edit timestamp
            // If we can't find, we use the latest one

            // Maybe we needn't sort here? ... If we assume, by nature, that the recordEntrySet is in insertion order
            const ascTimeRecords = Array.from(recordEntrySet).sort((a, b) => a[0].timestamp - b[0].timestamp);

            let latestMatchedRecord: [SyntaxInfoEntryHeader, T] | undefined;
            for (const [header, record] of ascTimeRecords) {
                if (header.identifierRange.start.line === line && header.lineSnapshot === lineText) {
                    latestMatchedRecord = [header, record];
                    if (header.timestamp >= timestamp) {
                        break;
                    }
                }
            }

            if (latestMatchedRecord) {
                matchedRecords.push(latestMatchedRecord);
            }
        }

        return matchedRecords;
    }

    findNewDiagnoseInfo(timestamp1: number, timestamp2: number, useLatestDiagnostic: [vscode.Uri, vscode.Diagnostic[]][] | undefined): [vscode.Uri, vscode.Diagnostic[]][] {
        const map = this.languageSyntaxRecorder.getDiagnosticTimeMap();
        
        // Find first record that is right after the timestamp
        // If we can't find, we use the latest one
        let diagnostic1: [vscode.Uri, vscode.Diagnostic[]][] = [];
        for (const [timestamp, info] of map) {
            diagnostic1 = info.allDiagnostics;
            if (timestamp >= timestamp1) {
                break;
            }
        }
        
        let diagnostic2: [vscode.Uri, vscode.Diagnostic[]][] = [];
        if (useLatestDiagnostic) {
            diagnostic2 = useLatestDiagnostic;
        } else {
            for (const [timestamp, info] of map) {
                diagnostic2 = info.allDiagnostics;
                if (timestamp >= timestamp2) {
                    break;
                }
            }
        }

        // Extract diagnostic2 - diagnostic1 by uri
        const matchedRecords: [vscode.Uri, vscode.Diagnostic[]][] = [];
        for (const [uri, diags] of diagnostic2) {
            const diags1 = diagnostic1.find((_uri, _diags) => _uri.toString() === uri.toString());

            if (!diags1) {
                matchedRecords.push([uri, diags]);
            } else {
                const newDiags = diags.filter(diag => !diags1[1].some(
                    _diag => this.diagnosticEntryEqual(_diag, diag)
                ));
                if (newDiags.length > 0) {
                    matchedRecords.push([uri, newDiags]);
                }
            }
        }
        
        return matchedRecords;
    }

    private diagnosticEntryEqual(diag1: vscode.Diagnostic, diag2: vscode.Diagnostic) {
        return diag1.message === diag2.message && diag1.range.isEqual(diag2.range) && diag1.severity === diag2.severity;
    }
}

interface CategorizedLspFoundLocations {
    def: RequestLspFoundLocation[];
    ref: RequestLspFoundLocation[];
    rename: RequestLspFoundLocation[];
    clone: RequestLspFoundLocation[];
}

interface SyntaxInfoEntryHeader {
    /** The word range of the identifier when recorded */
    identifierRange: vscode.Range;
    /** The identifier text */
    identifier: string;
    /** The snapshot of the line at the beginning of the range */
    lineSnapshot: string;
    /** Unix timestamp */
    timestamp: number;
}

export interface CodeLocationInFile {
    uri: vscode.Uri;
    range: vscode.Range;
}

export interface CodeRangesInFile {
    uri: vscode.Uri;
    ranges: vscode.Range[];
}

interface DefInfo {
    allDefs: CodeLocationInFile[]
}

interface RefInfo {
    allRefs: CodeLocationInFile[]
}

interface RenameInfo {
    allRenameRanges: CodeRangesInFile[]
}

interface DiagnosticInfo {
    allDiagnostics: [vscode.Uri, vscode.Diagnostic[]][];
}

// This is substituted with the type [Uri, Diagnose][] in VS Code API 
// interface DiagnoseInfo {
//     severity: string,
//     message: string,
//     range: {
//         line: number,
//         character: number
//     }[],
//     source: string,
//     code: {
//         value: string,
//         target: vscode.Uri
//     }
// }

interface DocumentSymbolInfo {
    name: string;
    selectionRange: vscode.Range;
    range: vscode.Range;
    children: DocumentSymbolInfo[];
}

class SyntaxInfoMap<T> {
    map: Map<string, Map<number, Map<string, Set<[SyntaxInfoEntryHeader, T]>>>>;

    constructor() {
        this.map = new Map();
    }

    addRecord(uri: string, line: number, header: SyntaxInfoEntryHeader, record: T) {
        let uriEntry = this.map.get(uri);
        if (!uriEntry) {
            uriEntry = new Map();
            this.map.set(uri, uriEntry);
        }

        let lineEntry = uriEntry.get(line);
        if (!lineEntry) {
            lineEntry = new Map();
            uriEntry.set(line, lineEntry);
        }

        const identifier = header.identifier;
        let recordEntry = lineEntry.get(identifier);
        if (!recordEntry) {
            recordEntry = new Set();
            lineEntry.set(identifier, recordEntry);
            
        }
        for (const entry of recordEntry) {
            if (entry[0].identifierRange.isEqual(header.identifierRange) && entry[0].lineSnapshot === header.lineSnapshot) {
                recordEntry.delete(entry);
            }
        }

        recordEntry.add([header, record]);
    }

    clear() {
        this.map.clear();
    }
}

/**
 * Record syntax information used for inference by polling,
 * because current design of the LSP interface of VS Code API
 * does not support an "undo" to inspect the symbol before change.
 * 
 * We take records of the following information:
 * + Definition
 * + Reference
 * + Rename
 * 
 * Details on the contents of each entry:
 * + For consistency with the previous edit, we only check if the line contents at
 * the same line number are the same. That is, for each entry,
 * we also record the line snapshot, i.e. the content and position of the line.
 * + For deduplication, we keep one copy for each identical line snapshot.
 * This may require more memory but provide more flexibility when matching together
 * with used edits.
 * 
 * NOTE There are certainly some limitations on the mechanism of selection change detection:
 * + We only record the first selection range at selection change.
 * + We cannot detect selection change when keying `delete`, but we
 * assume that for most time it doesn't matter.
 * + We only use `selection.start` to and `getWordAtPosition` to determine the identifier.
 * 
 * NOTE Other known limitations:
 * + We only export the first def/ref/rename result, although we record all results of them.
 */
class LanguageSyntaxRecorder implements vscode.Disposable {
    /** Identified with URI string */
    private watchedFiles: Set<string>;
    /** Identified with URI string, indexed as [URI String] -> [Line Number] -> [Identifier] */
    private defInfoMap: SyntaxInfoMap<DefInfo>;     // assume that "JS set iterator is in insertion order" is true
    /** Identified with URI string, indexed as [URI String] -> [Line Number] -> [Identifier] */
    private refInfoMap: SyntaxInfoMap<RefInfo>;
    /** Identified with URI string, indexed as [URI String] -> [Line Number] -> [Identifier] */
    private renameInfoMap: SyntaxInfoMap<RenameInfo>;
    /** Entire diagnostic info at each timestamp */
    private diagnosticInfoMap: Map<number, DiagnosticInfo>;

    private _watchSelectionChangeDisposable: vscode.Disposable | undefined;

    constructor() {
        this.watchedFiles = new Set();
        this.defInfoMap = new SyntaxInfoMap<DefInfo>();
        this.refInfoMap = new SyntaxInfoMap<RefInfo>();
        this.renameInfoMap = new SyntaxInfoMap<RenameInfo>();
        this.diagnosticInfoMap = new Map<number, DiagnosticInfo>();

        this._watchSelectionChangeDisposable =
            vscode.window.onDidChangeTextEditorSelection(async e => {
                const uriString = e.textEditor.document.uri.toString();

                if (this.watchedFiles.has(uriString)) {
                    const selection = e.textEditor.selection;
                    await this.fetchSyntaxInfo(e.textEditor.document, e.textEditor.document.uri, selection);
                }
            });
    }

    dispose() {
        this.defInfoMap.clear();
        this.refInfoMap.clear();
        this.renameInfoMap.clear();

        this.watchedFiles.clear();
        this._watchSelectionChangeDisposable?.dispose();
    }

    watch(uri: vscode.Uri) {
        this.watchedFiles.add(uri.toString());
    }

    unwatch(uri: vscode.Uri) {
        this.watchedFiles.delete(uri.toString());
    }

    /** Identified with URI string, indexed as [URI String] -> [Line Number] -> [Identifier] */
    getDefInfoMap() {
        return this.defInfoMap;
    }

    /** Identified with URI string, indexed as [URI String] -> [Line Number] -> [Identifier] */
    getRefInfoMap() {
        return this.refInfoMap;
    }

    /** Identified with URI string, indexed as [URI String] -> [Line Number] -> [Identifier] */
    getRenameInfoMap() {
        return this.renameInfoMap;
    }

    /** Entire diagnostic info at each timestamp */
    getDiagnosticTimeMap() {
        return this.diagnosticInfoMap;
    }

    private async fetchSyntaxInfo(doc: vscode.TextDocument, uri: vscode.Uri, selection: vscode.Selection) {
        const uriString = uri.toString();

        const line = selection.start.line;
        // FIXME Will some language use '-' in an identifier? By default this the word got here will be separated by '-'.
        const identifierRange = doc.getWordRangeAtPosition(selection.start) ?? new vscode.Range(selection.start, selection.end);
        const identifier = doc.getText(doc.getWordRangeAtPosition(selection.start));

        const header: SyntaxInfoEntryHeader = {
            identifierRange: identifierRange,
            identifier: identifier,
            lineSnapshot: getLineTextWithLineEnding(doc, line),
            timestamp: Date.now()
        };

        // do each type of collection in parallel

        (async () => {
            const def = await this.debounceDefQuery(uri, identifierRange.start) as CodeLocationInFile[];
            if (def.length > 0) {
                const fullDefRanges = await this.expandToFullDefinitionRanges(identifier, def);

                const entry = {
                    allDefs: fullDefRanges
                } as DefInfo;
                this.defInfoMap.addRecord(uriString, line, header, entry);
            }
        })();
        
        
        (async () => {
            const ref = await this.debounceRefQuery(uri, identifierRange.start) as CodeLocationInFile[];
            if (ref.length > 0) {
                const entry = {
                    allRefs: ref
                } as RefInfo;
                this.refInfoMap.addRecord(uriString, line, header, entry);
            }
        })();
  
        (async () => {
            // Rename provider may throw an error from the promise
            try {
                const rename = await this.debounceRenameQuery(uri, identifierRange.start);
                if (rename && Array.isArray(rename) && rename.length > 0) {
                    const entry = {
                        allRenameRanges: rename as CodeRangesInFile[]
                    } as RenameInfo;
                    this.renameInfoMap.addRecord(uriString, line, header, entry);
                }
            } catch (err) {
                console.debug('Failed to find rename locations:', err instanceof Error ? err.message : String(err));
            }
        })();

        (async () => {
            const diagnostics = await this.debounceDiagnosticQuery(uri);
            if (diagnostics.length > 0) {
                const entry = {
                    allDiagnostics: diagnostics[1]
                } as DiagnosticInfo;
                this.diagnosticInfoMap.set(diagnostics[0], entry);
            }
        })();
    }

    private async expandToFullDefinitionRanges(identifier: string, locations: CodeLocationInFile[]): Promise<CodeLocationInFile[]> {
        const matchedLocations: CodeLocationInFile[] = [];
        for (const location of locations) {
            const rootInfoArray = await this.fetchDocumentSymbolInfo(location.uri);
            const matchedInfo = this.findRecursivelyMatchedDocumentSymbolInfo(rootInfoArray, identifier, location.range);
            if (matchedInfo) {
                // NOTE only the first line is extracted from definition
                const firstLineRangeInfo = new vscode.Range(
                    new vscode.Position(matchedInfo.range.start.line, 0),
                    new vscode.Position(matchedInfo.range.start.line, Number.MAX_SAFE_INTEGER)
                );

                matchedLocations.push({
                    uri: location.uri,
                    range: firstLineRangeInfo
                });
            }
        }
        
        return matchedLocations;
    }

    private findRecursivelyMatchedDocumentSymbolInfo(infoArray: DocumentSymbolInfo[], identifier: string, range: vscode.Range): DocumentSymbolInfo | undefined {
        for (const rootInfo of infoArray) {
            if (rootInfo.name === identifier && rootInfo.selectionRange.isEqual(range)) {
                return rootInfo;
            }
            const matchedChild = this.findRecursivelyMatchedDocumentSymbolInfo(rootInfo.children, identifier, range);
            if (matchedChild) {
                return matchedChild;
            }
        }
        return undefined;
    }

    private async fetchDocumentSymbolInfo(uri: vscode.Uri): Promise<DocumentSymbolInfo[]> {
        const symbolInfo: DocumentSymbolInfo[] = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        return symbolInfo;
    }

    private static readonly debounceTimeout = 200;

    private debounceDefQuery = debounced(async (uri: vscode.Uri, position: vscode.Position) => {
        return await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
    }, LanguageSyntaxRecorder.debounceTimeout);

    private debounceRefQuery = debounced(async (uri: vscode.Uri, position: vscode.Position) => {
        return await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position);
    }, LanguageSyntaxRecorder.debounceTimeout);

    private debounceRenameQuery = debounced(async (uri: vscode.Uri, position: vscode.Position) => {
        try {
            return await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', uri, position, 'placeholder');
        } catch (err) {
            // console.debug('Failed to execute rename provider:', err instanceof Error ? err.message : String(err));
            return undefined;
        } 
    }, LanguageSyntaxRecorder.debounceTimeout);

    private debounceDiagnosticQuery = debounced(async (uri: vscode.Uri): Promise<[number, [vscode.Uri, vscode.Diagnostic[]][]]> => {
        const timestamp = Date.now();
        const diagnostics = vscode.languages.getDiagnostics();
        return [timestamp, diagnostics];
    }, LanguageSyntaxRecorder.debounceTimeout);
}

// class EditRecorder implements vscode.Disposable {
//     /** Identified with URI string */
//     private watchedFiles: Set<string>;
//     private _watchDisposable: vscode.Disposable | undefined;

//     constructor() {
//         this.watchedFiles = new Set();
//     }

//     dispose() {
//     }

//     watch(uri: vscode.Uri) {
//         this.watchedFiles.add(uri.toString());
//     }

//     unwatch(uri: vscode.Uri) {
//         this.watchedFiles.delete(uri.toString());
//     }
    
// }

// TODO add tests for this
class EditReducer {
    /** Limit of atomic edits that are kept */
    editLimit: number;
    /** Snapshots of previous editions of each file (indexed with URI string) which editList is APPLIED AFTER, i.e. BEFORE EDIT APPLIED */
    textBaseSnapshots: Map<string, string>;
    /** Timestamp of the latest update to the textBaseSnapshots */    
    latestUpdateTimestamp: Map<string, number>;
    /** Edits that have taken place since textBaseSnapshots */
    editList: EditWithTimestamp[];
    
    constructor() {
        this.editLimit = 10;
        this.textBaseSnapshots = new Map();
        this.latestUpdateTimestamp = new Map();
        this.editList = [];
    }
    
    clearEditsAndSnapshots() {
        this.textBaseSnapshots = new Map();
        this.latestUpdateTimestamp = new Map();
        this.editList = [];
    }

    hasSnapshot(path: string) {
        return this.textBaseSnapshots.has(path);
    }

    addSnapshot(path: string, text: string) {
        if (!this.hasSnapshot(path)) {
            this.textBaseSnapshots.set(path, text);
            this.latestUpdateTimestamp.set(path, Date.now());
        }
    }

    async updateAllDocumentSnapshots() {
        const openedDocuments = getOpenedFilePaths();

        // need to fetch text from opened editors
        for (const [uriString,] of this.textBaseSnapshots) {
            try {
                const text = await getStagedFile(openedDocuments, vscode.Uri.parse(uriString).fsPath);
                this.updateEditsOnFile(uriString, text);
            } catch (err) {
                console.warn(`Using saved version: cannot update snapshot on ${uriString}`);
            }
        }
        this.shiftEdits();
    }

    updateEditsOnFile(uriString: string, text: string) {
        const snapshot = this.textBaseSnapshots.get(uriString);
        if (snapshot === undefined) return;

        // Compare old `editList` with new diff on a document
        // All new diffs should be added to edit list, but merge the overlapped/adjoined to the old ones of them
        // Merge "-" (removed) diff into an overlapped/adjoined old edit
        // Merge "+" (added) diff into an old edit only if its precedent "-" hunk (a zero-line "-" hunk if there's no) wraps the old edit's "-" hunk
        // By default, there could only be zero or one "+" hunk following a "-" hunk
        
        // Prepare all the old edits on the path
        const oldEditsWithIdx: { idx: number, edit: EditWithTimestamp }[] = [];
        const oldEditIndices = new Set();
        this.editList.forEach((edit, idx) => {
            if (edit.uriString === uriString) {
                oldEditsWithIdx.push({
                    idx: idx,
                    edit: edit
                });
                oldEditIndices.add(idx);
            }
        });
        oldEditsWithIdx.sort((edit1, edit2) => edit1.edit.line - edit2.edit.line);	// sort in starting line order
        
        // Maintain a new list about old edits that are kept
        const oldAdjustedEditsWithIdx = new Map();

        // Compute new edits from the snapshot after old edits
        const newDiffs = diffLines(
            snapshot,
            text
        );
        const newEdits: EditWithTimestamp[] = [];

        const lines = text.split('\n');

        let lastLine = 0;
        let oldEditIdx = 0;

        function createEdit(rmDiff?: Change, addDiff?: Change) {
            // construct new edit
            const newEdit: EditWithTimestamp = {
                uriString: uriString,
                line: lastLine,
                rmLine: rmDiff?.count ?? 0,
                rmText: splitLines(rmDiff?.value ?? "", false),
                addLine: addDiff?.count ?? 0,
                addText: splitLines(addDiff?.value ?? "", false),
                codeAbove: [] as string[],
                codeBelow: [] as string[],
                timestamp: Date.now()
            };

            // Validation
            // if (newEdit.addLine !== newEdit.addText.length || newEdit.rmLine !== newEdit.rmText.length) {
            //     console.error("Error encountered at constructing edit.");
            // }
                
            // Find context
            const fromLine = lastLine;
            const toLine = lastLine + (addDiff?.count ?? 0);
            const startAbove = Math.max(0, fromLine - 4);
            const endAbove = Math.max(0, fromLine - 1);
            const startBelow = toLine;
            const endBelow = Math.min(lines.length, toLine + 3);
    
            newEdit.codeAbove = lines.slice(startAbove, endAbove);
            newEdit.codeBelow = lines.slice(startBelow, endBelow);

            return newEdit;
        }

        function pushOldEditMerge(newEdit: EditWithTimestamp) {
            const newEditFromLine = newEdit.line;
            const newEditToLine = newEdit.line + newEdit.rmLine;

            // skip to the first old edit that is probably involved
            while (
                oldEditIdx < oldEditsWithIdx.length &&
                oldEditsWithIdx[oldEditIdx].edit.line + oldEditsWithIdx[oldEditIdx].edit.rmLine <= newEditFromLine
            ) {
                oldAdjustedEditsWithIdx.set(oldEditsWithIdx[oldEditIdx].idx, oldEditsWithIdx[oldEditIdx].edit);
                ++oldEditIdx;
            }
    
            // if the first involved old edit is overlapped/adjoined with this diff
            // replace all the overlapped/adjoined old edits with the new edit
            const fromIdx = oldEditIdx;
            while (
                oldEditIdx < oldEditsWithIdx.length &&
                oldEditsWithIdx[oldEditIdx].edit.line <= newEditToLine
            ) {
                ++oldEditIdx;
            }

            if (oldEditIdx > fromIdx) {
                const minIdx = Math.max.apply(
                    null,
                    oldEditsWithIdx.slice(fromIdx, oldEditIdx).map((edit) => edit.idx)
                );
                newEdit.timestamp = Math.min(
                    ...oldEditsWithIdx.slice(fromIdx, oldEditIdx).map((edit) => edit.edit.timestamp),
                );
                oldAdjustedEditsWithIdx.set(minIdx, newEdit);
            } else {
                newEdits.push(newEdit);
            }
        }

        for (let i = 0; i < newDiffs.length; ++i) {
            const diff = newDiffs[i];

            let edit: EditWithTimestamp | undefined;
            if (diff.removed) {
                // unite the following "+" (added) diff
                if (i + 1 < newDiffs.length && newDiffs[i + 1].added) {
                    edit = createEdit(diff, newDiffs[i + 1]);
                    if (!(newDiffs[i + 1].removed)) {
                        lastLine += newDiffs[i + 1].count ?? 0;
                    }
                    
                    ++i;
                } else {
                    edit = createEdit(diff, undefined);
                }
            } else if (diff.added) {
                // deal with a "+" diff not following a "-" diff
                edit = createEdit(undefined, diff);
            }

            if (edit) {
                pushOldEditMerge(edit);
            }

            // now lastLine represents after-edit snapshot line number
			if (!(diff.removed)) {
				lastLine += diff.count ?? 0;
			}
        }

        // Rearrange the whole edit list,
        // only modifying those affected in the old adjusted edits of that path
        const oldAdjustedEdits: EditWithTimestamp[] = [];
        this.editList.forEach((edit, idx) => {
            if (oldEditIndices.has(idx)) {
                if (oldAdjustedEditsWithIdx.has(idx)) {
                    oldAdjustedEdits.push(oldAdjustedEditsWithIdx.get(idx));
                }
			} else {
				oldAdjustedEdits.push(edit);
			}
		});

		this.editList = oldAdjustedEdits.concat(newEdits);
    }

    // Shift editList if out of capacity
    // For every overflown edit, apply it and update the document snapshots on which the edits base
    shiftEdits(numShifted?: number) {
        // filter all removed edits
        const numRemovedEdits = numShifted ?? this.editList.length - this.editLimit;
        if (numRemovedEdits <= 0) {
            return;
        }
        const removedEdits = new Set(this.editList.slice(
            0,
            numRemovedEdits
        ));
		
		
		// for each file involved in the removed edits
        const affectedUriSet = new Set(
			[...removedEdits].map((edit) => edit.uriString)
			);
		for (const uriString of affectedUriSet) {
            const snapshot = this.textBaseSnapshots.get(uriString);
            if (!snapshot) continue;

			const editsOnPath = this.editList
				.filter((edit) => edit.uriString === uriString)
				.sort((edit1, edit2) => edit1.line - edit2.line);
				
			// execute removed edits
			const removedEditsOnPath = editsOnPath.filter((edit) => removedEdits.has(edit));
            this.performEdits(uriString, snapshot, removedEditsOnPath);
			
			// rebase other edits in file
			let offsetLines = 0;
			for (let edit of editsOnPath) {
				if (removedEdits.has(edit)) {
					offsetLines = offsetLines - edit.rmLine + edit.addLine;
				} else {
					edit.line += offsetLines;
				}
			}
        }

        this.editList.splice(0, numRemovedEdits);
    }

    async updateEdits() {
        await this.updateAllDocumentSnapshots();
    }

    /**
     * Return edit list in such format:
     * [
     * 		{
     * 			"beforeEdit": string, the deleted hunk, could be null;
     * 			"afterEdit": string, the added hunk, could be null;
     * 		},
     * 		...
     * ]
     */
    async getSimpleEditList() {
        return this.editList.map((edit) => ({
			"beforeEdit": edit.rmText,
            "afterEdit": edit.addText,
        }));
    }

    async getEditList() {
        return this.editList.sort((edit1, edit2) => edit1.timestamp - edit2.timestamp);
    }

    // Obsolete: old style edit fetcher

    // async updateAndGetSimpleEditList() {
    //     await this.updateEdits();
    //     return await this.getSimpleEditList();
    // }

    // async updateAndGetEditList() {
    //     await this.updateEdits();
    //     return await this.getEditList();
    // }

    computeEditedHunks(path: string): FileAsHunks | null {
        if (!this.textBaseSnapshots.has(path)) {
            return null;
        }
        
        const hunks: FileAsHunks = [];
        
        const fileLastSnapshot = this.textBaseSnapshots.get(path) as string;
        const fileLastEdit = this.editList
            .filter((edit) => edit.uriString === path)
            .sort((edit1, edit2) => edit1.line - edit2.line);
        
        const lines = splitLines(fileLastSnapshot);
        
        let lastEditLine = 1;
        const flush = (untilLine: number) => {
            if (untilLine > lastEditLine) {
                // For unchanged lines, in String[] instead of String
                const keepLines = lines.slice(lastEditLine - 1, untilLine - 1);
                hunks.push(keepLines);
                lastEditLine = untilLine;
            }
        };
        for (const edit of fileLastEdit) {
            if (lastEditLine > lines.length) break;
            
            flush(edit.line);

            const toLine = lastEditLine + (edit.rmLine ?? 0);
            const rmText = edit.rmText ?? "";
            const addText = edit.addText ?? "";
            hunks.push({
                "beforeEdit": rmText,
                "afterEdit": addText
            });
            lastEditLine = toLine;
        }

        flush(lines.length + 1);

        return hunks;
    }

    private performEdits(filePath: string, doc: string, edits: EditWithTimestamp[]) {
        const lines = doc.match(/[^\r\n]*(\r?\n|\r\n|$)/g);
        if (!lines) return;

        const addedLines = Array(lines.length).fill("");
        let latestEditTimestamp = 0;

        for (const edit of edits) {
            const s = edit.line - 1;  // zero-based starting line
            for (let i = s; i < s + edit.rmLine; ++i) {
                lines[i] = "";
            }
            addedLines[s] = edit.addText ?? "";
            latestEditTimestamp = Math.max(latestEditTimestamp, edit.timestamp);           
        }
        
        const afterText = lines
            .map((x, i) => addedLines[i] + x)
            .join("");

        this.textBaseSnapshots.set(filePath, afterText);
    }
}

// Obsolete: old style edit fetcher
// export const globalEditDetector = new EditReducer();

export const globalEditInfoCollector = new WorkspaceEditInfoCollector();

export function updateEditorState(editor: vscode.TextEditor | undefined) {
    if (!editor) globalEditorState.inDiffEditor = false;
    else globalEditorState.inDiffEditor = (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
    
    globalEditorState.language = vscode.window.activeTextEditor?.document?.languageId.toLowerCase() ?? "unknown";
    
    statusBarItem.setStatusDefault(true);

    // update file snapshot
    const currUri = editor?.document?.uri;
    if (currUri && currUri.scheme === "file" && currUri) {
        globalEditInfoCollector.watch(currUri);
    }

    let isEditDiff = false;
    if (globalEditorState.inDiffEditor) {
        const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as any;
        isEditDiff = ((input instanceof vscode.TabInputTextDiff)
            && input.original.scheme === 'temp'
            && input.modified.scheme === 'file') || (input.textDiffs ? true : false);
    }

    if (vscode.workspace.getConfiguration("navEdit").get("predictLocationOnEditAccept") && globalEditorState.toPredictLocation) {
        setTimeout(() => {
            vscode.commands.executeCommand("navEdit.predictLocations");
            globalEditorState.toPredictLocation = false;
        }, 600);
    }
    vscode.commands.executeCommand('setContext', 'navEdit:isEditDiff', isEditDiff);
    vscode.commands.executeCommand('setContext', 'navEdit:isLanguageSupported', globalEditorState.isActiveEditorLanguageSupported());
}

export class FileStateMonitor extends DisposableComponent {
    constructor() {
        super();

        // TODO globalEditInfoCollector should belong to the FileStateMonitor

        // Watch all opened text documents at creation of this monitor
        globalEditInfoCollector.watchAllOpened();

        this.register(
            vscode.window.onDidChangeActiveTextEditor(updateEditorState),
            vscode.workspace.onDidOpenTextDocument((textDocument) => {
                if (textDocument.uri.scheme === "file") {
                    globalEditInfoCollector.watch(textDocument.uri);
                }
            }),
            vscode.workspace.onDidCloseTextDocument((textDocument) => {
                if (textDocument.uri.scheme === "file") {
                    globalEditInfoCollector.unwatch(textDocument.uri);
                }
            }),
        );
    }
}

export function convertToRequestEdit(editWithTimestamp: EditWithTimestamp): RequestEdit {
    const {
        line,
        rmLine,
        rmText,
        addLine,
        addText,
        codeAbove,
        codeBelow
    } = editWithTimestamp;

    const requestEdit: RequestEdit = {
        line,
        rmLine,
        rmText,
        addLine,
        addText,
        codeAbove,
        codeBelow,
        path: vscode.Uri.parse(editWithTimestamp.uriString).fsPath
    };

    return requestEdit;
}

function debounced<T extends (...args: any[]) => Promise<any>>(func: T, wait: number): T {
    let timeout: NodeJS.Timeout;
    return function (this: any, ...args: any[]): Promise<any> {
        return new Promise((resolve) => {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(async () => {
                const result = await func.apply(context, args);
                resolve(result);
            }, wait);
        });
    } as T;
}

function getLineTextWithLineEnding(doc: vscode.TextDocument, line: number) {
    const rangeStart = doc.lineAt(line).range.start;
    const rangeEnd = line >= doc.lineCount - 1
        ? doc.lineAt(line).range.end
        : doc.lineAt(line + 1).range.start;
    return doc.getText(new vscode.Range(rangeStart, rangeEnd));
}
