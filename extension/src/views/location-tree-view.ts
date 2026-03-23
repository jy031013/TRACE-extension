import path from 'path';
import vscode, { TreeItem, TreeItemCollapsibleState } from 'vscode';
import { UniqueRefactorEditsSet } from '../comands';
import { DisposableComponent } from '../utils/base-component';
import { EditType, FileEdits, LocatorLocation } from '../utils/base-types';
import { getRootPath, toRelPath } from '../utils/file-utils';
import { generateTimeSpecificId } from '../utils/utils';

export class LocationTreeDataProvider implements vscode.TreeDataProvider<FileItem | ModItem>  {
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined> = new vscode.EventEmitter<FileItem | undefined>();
    onDidChangeTreeData: vscode.Event<FileItem | undefined> = this._onDidChangeTreeData.event;
    private _onDidChangeLocationNumber: vscode.EventEmitter<number> = new vscode.EventEmitter<number>();
    onDidChangeLocationNumber: vscode.Event<number> = this._onDidChangeLocationNumber.event;

    modTree: FileItem[];
    pinnedItems: ModItem[];

    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._onDidChangeLocationNumber = new vscode.EventEmitter();
        this.onDidChangeLocationNumber = this._onDidChangeLocationNumber.event;
        this.modTree = [];
        this.pinnedItems = [];
    }

    pinItem(item: ModItem) {
        if (!item.isPinned) {
            item.isPinned = true;
            item.contextValue = 'pinnedMod';
            this.pinnedItems.push(item);
            this.notifyChangeOfTree();
        }
    }

    unpinItem(item: ModItem) {
        if (item.isPinned) {
            item.isPinned = false;
            item.contextValue = 'mod';
            const index = this.pinnedItems.indexOf(item);
            if (index > -1) {
                this.pinnedItems.splice(index, 1);
            }
            this.notifyChangeOfTree();
        }
    }

    empty() {
        this.modTree = [];
        this.notifyChangeOfTree();
    }

    reloadData(modList: LocatorLocation[]) {
        const newModTree = this.buildModTree(modList);
        this.modTree = this.mergePinnedItemsWithNewData(newModTree);
        this.notifyChangeOfTree();
    }

    // TODO reimplement this in another provider class
    async reloadRefactorData(editList: FileEdits[]) {
        const workspaceFolderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolderPath) {
            return [];
        }

        this.modTree = this.buildRefactorTree(editList);
        this.notifyChangeOfTree();
    }

    notifyChangeOfTree() {
        this._onDidChangeTreeData.fire(undefined);
        this._onDidChangeLocationNumber.fire(this.numOfLocation());
    }

    numOfLocation() {
        if (this.modTree === null) return 0;

        let num = 0;
        for (const fileItem of this.modTree) {
            num += fileItem?.mods?.length ?? 0;
        }

        return num;
    }

    getTreeItem(element: FileItem | ModItem) {
        return element;
    }

    /**
     * Structure of modList should be like
     * {
     *     "atLines": [
     *         11
     *     ],
     *     "editType": "add",
     *     "endPos": 386,
     *     "lineBreak": "\r\n",
     *     "prevEdits": [
     *         {
     *             "afterEdit": "export { BaseComponent as Component } from './component';",
     *             "beforeEdit": "export { Component } from './component';"
     *         }
     *     ],
     *     "startPos": 334,
     *     "targetFilePath": "c:/Users/aaa/Desktop/page.js/compat/src/PureComponent.js",
     *     "toBeReplaced": "PureComponent.prototype.isPureReactComponent = true;"
     * },
     * 
     * Construct Mod Tree:
     * {
     *     "files": [
     *         {
     *             "fileName": "",
     *             "filePath": "",
     *             "mods": [
     *                 {
     *                     "atLines": 0,
     *                     "start": 0,
     *                     "end": 0,
     *                     "toBeReplaced": ""
     *                 }
     *             ]
     *         }, ...
     *     ]
     * }
     */
    
    
    buildModTree(modList: LocatorLocation[]) {
        const categorizeByAttr = (arr: any[], attr: any) => 
            arr.reduce((acc, obj) => {
                const key = obj[attr];
                if (!acc[key]) acc[key] = [];
                acc[key].push(obj);
                return acc;
            }, {});

        const modListCategorizedByFilePath = categorizeByAttr(modList, 'targetFilePath');

        var modTree = [];
        for (const filePath in modListCategorizedByFilePath) {  
            modTree.push(this.getFileItem(filePath, modListCategorizedByFilePath[filePath]));
        }

        return modTree;
    }

    private mergePinnedItemsWithNewData(newModTree: FileItem[]): FileItem[] {
        if (this.pinnedItems.length === 0) {
            return newModTree;
        }

        // Group pinned items by file path
        const pinnedByFilePath = new Map<string, ModItem[]>();
        for (const pinnedItem of this.pinnedItems) {
            const filePath = pinnedItem.fileItem.filePath;
            if (!pinnedByFilePath.has(filePath)) {
                pinnedByFilePath.set(filePath, []);
            }
            pinnedByFilePath.get(filePath)!.push(pinnedItem);
        }

        const mergedTree: FileItem[] = [];
        const processedFiles = new Set<string>();

        // Process new files and merge with pinned items
        for (const newFileItem of newModTree) {
            const filePath = newFileItem.filePath;
            const pinnedItemsForFile = pinnedByFilePath.get(filePath) || [];
            
            // Merge new and pinned items for this file
            const allItems = [...pinnedItemsForFile, ...newFileItem.mods];
            
            // Remove duplicates based on line number (keep pinned items priority)
            const uniqueItems = new Map<number, ModItem>();
            for (const item of allItems) {
                if (!uniqueItems.has(item.fromLine) || item.isPinned) {
                    uniqueItems.set(item.fromLine, item);
                }
            }

            // Sort by line number
            const sortedItems = Array.from(uniqueItems.values()).sort((a, b) => a.fromLine - b.fromLine);
            
            // Update file item with merged mods
            newFileItem.mods = sortedItems;
            mergedTree.push(newFileItem);
            processedFiles.add(filePath);
        }

        // Add files that only have pinned items (no new predictions)
        for (const [filePath, pinnedItems] of pinnedByFilePath) {
            if (!processedFiles.has(filePath)) {
                const fileName = pinnedItems[0].fileItem.fileName;
                const fileItem = new FileItem(
                    fileName,
                    vscode.TreeItemCollapsibleState.Expanded,
                    fileName,
                    filePath,
                    pinnedItems.sort((a, b) => a.fromLine - b.fromLine)
                );
                
                // Update fileItem reference in pinned items
                for (const item of pinnedItems) {
                    item.fileItem = fileItem;
                }
                
                mergedTree.push(fileItem);
            }
        }

        return mergedTree;
    }

    buildRefactorTree(editList: FileEdits[]) {
        var modTree = [];
        const refactorEditsSet: UniqueRefactorEditsSet = {
            id: generateTimeSpecificId(),
            edits: editList
        };
        for (const [uri, edits] of editList) {
            // TODO The conversion here is lossy, see implementation below. Use a data->resolve way for this, rewriting getTreeItem method.
            modTree.push(this.getRefactorFileItem(uri, edits, refactorEditsSet));
        }

        return modTree;
    }

    getChildren(element?: FileItem) {
        if (element) {
            return element.mods;
        } else {
            return this.modTree;
        }
    }

    getParent(element: ModItem) {
        if (element.fileItem) {
            return element.fileItem;
        } else {
            return undefined;
        }
    }

    getFileItem(filePath: string, fileMods: LocatorLocation[]) {
        const modListOnPath = fileMods;
        const fileName = path.basename(filePath); 
        var fileItem = new FileItem(
            fileName,
            vscode.TreeItemCollapsibleState.Expanded,
            fileName,
            filePath,
            []
        );

        for (const loc of modListOnPath) {
            let fromLine = loc.atLines[0];
            let toLine = loc.editType === "add" ? loc.atLines[0] : loc.atLines[loc.atLines.length - 1] + 1;
            fileItem.mods.push(
                new ModItem(
                    `Line ${fromLine + 1}`,
                    vscode.TreeItemCollapsibleState.None,
                    fileItem,
                    fromLine,
                    toLine,
                    loc.lineInfo.text,
                    loc.editType
                )
            );
        }

        return fileItem;
    }

    // TODO use another tree view implementation
    // All ModItems of the refactor tree points to one (single) refactor review command
    getRefactorFileItem(fileUri: vscode.Uri, inFileEdits: vscode.TextEdit[], refactorEditsSet: UniqueRefactorEditsSet) {
        const fileName = path.basename(fileUri.fsPath);
        // TODO the relPath could be incorrect if there are multiple workspace folders
        const relPath = path.relative(vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '', fileUri.fsPath);
        var fileItem = new FileItem(
            fileName,
            vscode.TreeItemCollapsibleState.Expanded,
            fileName,
            relPath,
            []
        );

        for (const edit of inFileEdits) {
            // TODO don't use fromLine toLine, use range. Though it is no impact here
            let fromLine = edit.range.start.line;
            let toLine = edit.range.end.line;
            fileItem.mods.push(
                new ModItem(
                    `Line ${fromLine + 1}`,
                    vscode.TreeItemCollapsibleState.None,
                    fileItem,
                    fromLine,
                    toLine,
                    edit.newText.split('\n')[0],     // this is inefficient, should be readLine
                    'replace',
                    true,
                    refactorEditsSet
                )
            );
        }

        return fileItem;
    }
}

class FileItem extends vscode.TreeItem {
    fileName: string;
    filePath: string;   // TODO don't use relative path here. Resolve absolute path, i.e., use a relative path with context linked to specific workspace folder
    mods: ModItem[];

    constructor(label: string, collapsibleState: TreeItemCollapsibleState, fileName: string, filePath: string, mods: ModItem[]) {
        super(label, collapsibleState);
        this.fileName = fileName;
        this.filePath = filePath;
        this.mods = mods;
        this.tooltip = this.fileName;
        this.description = `   ${toRelPath(getRootPath(), this.filePath)}`;
        this.resourceUri = vscode.Uri.file(this.filePath);
    }
    
    iconPath = vscode.ThemeIcon.File;

    contextValue = 'file';
}

export class ModItem extends vscode.TreeItem {
    fileItem: FileItem;
    fromLine: number;
    toLine: number;
    lineContent: string;
    editType: EditType;
    text: string;
    isPinned: boolean;

    constructor(
        label: string,
        collapsibleState: TreeItemCollapsibleState,
        fileItem: FileItem,
        fromLine: number,
        toLine: number,
        lineContent: string,
        editType: EditType,
        isRefactor: boolean = true,
        refactorEdits: UniqueRefactorEditsSet | undefined = undefined,
        isPinned: boolean = false
    ) {
        super(label, collapsibleState);
        this.collapsibleState = collapsibleState;
        this.fileItem = fileItem;
        this.fromLine = fromLine;
        this.toLine = toLine;
        this.lineContent = lineContent;
        this.editType = editType;
        this.text = `    ${this.lineContent.trim()}`;
        this.isPinned = isPinned;

        this.tooltip = `Line ${this.fromLine + 1} - Click to open file, right-click to ${this.isPinned ? 'unpin' : 'pin'}`; // match real line numbers in the gutter
        
        // Display pin status icon in description for constant visibility
        const pinIcon = this.isPinned ? '📌' : '⚪';
        const spacing = '        '; // Spacing to push icon to the right
        this.description = `${this.text}${spacing}${pinIcon}`;

        if (isRefactor && refactorEdits) {
            this.command = {
                command: 'trace.openRefactorPreview',
                title: 'Open Refactor View',
                arguments: [refactorEdits, fromLine]
            };
        } else {
            // Restore original behavior: click to open file and generate edits
            this.command = {
                command: 'trace.openFileAndGenerateEdits',
                title: '',
                arguments: [
                    this.fileItem.filePath,
                    this.fromLine,
                    this.toLine
                ]
            };
        }
        
        // Always use edit type icons on the left, pin status shown on the right
        // FIXME there should exist a more elegant way to get assets
        const iconFile = path.join(__filename, '..', '..', '..', 'assets', this.getIconFileName());
        this.iconPath = {
            light: vscode.Uri.file(iconFile),
            dark: vscode.Uri.file(iconFile),
        };
        this.label = this.getLabel();
        this.contextValue = this.isPinned ? 'pinnedMod' : 'mod';
    }

    getIconFileName() {
        switch (this.editType) {
            case 'add':
                return 'add-green.svg';
            case 'remove':
                return 'remove.svg';
            default:
                return 'edit-red.svg';
        }
    }

    getLabel() {
        // switch (this.editType) {
        //     case 'add':
        //         return `Adding at line ${this.atLine}`;
        //     case 'remove':
        //         return `Removing line ${this.atLine}`;
        //     default:
        //         return `Modifying line ${this.atLine}`;
        // }
        return `Line ${this.fromLine + 1}`;
    }
}

class EditLocationViewManager extends DisposableComponent {
    provider: LocationTreeDataProvider;
    treeView: vscode.TreeView<FileItem | TreeItem>;

    constructor() {
        super();
        this.provider = new LocationTreeDataProvider();
        
        const treeViewOptions: vscode.TreeViewOptions<FileItem | ModItem> = {
            treeDataProvider: this.provider,
            showCollapseAll: true
        };
        // TODO do not always display the treeview, but only when there are locations
        const treeView = vscode.window.createTreeView('editLocations', treeViewOptions);
        this.treeView = treeView;

        this.register(
            treeView
        );
    }

    setUpBadge(numOfLocation: number) {
        this.treeView.badge = {
            tooltip: `${numOfLocation} possible edit locations`,
            value: numOfLocation
        };
    }

    async reloadLocations(locations: LocatorLocation[]) {
        this.provider.reloadData(locations);
        this.setUpBadge(locations.length);
        if (!this.treeView.visible) {
            await vscode.commands.executeCommand('editLocations.focus');
        }
        await this.treeView.reveal(this.provider.modTree[0], { expand: 2 });
    }
}

export const globalLocationViewManager = new EditLocationViewManager();

class RefactorPreviewViewManager implements vscode.Disposable {
    provider: LocationTreeDataProvider;
    treeView: vscode.TreeView<FileItem | TreeItem>;

    constructor() {
        this.provider = new LocationTreeDataProvider();
        
        const treeViewOptions: vscode.TreeViewOptions<FileItem | ModItem> = {
            treeDataProvider: this.provider,
            showCollapseAll: true
        };
        // TODO do not always display the treeview, but only when there are locations
        const treeView = vscode.window.createTreeView('Refactor', treeViewOptions);
        this.treeView = treeView;
    }

    setUpBadge(numOfLocation: number) {
        this.treeView.badge = {
            tooltip: `${numOfLocation} possible edit locations`,
            value: numOfLocation
        };
    }

    async reloadLocations(locations: FileEdits[]) {
        this.provider.reloadRefactorData(locations);
        this.setUpBadge(locations.length);
        if (!this.treeView.visible) {
            await vscode.commands.executeCommand('editLocations.focus');
        }
        await this.treeView.reveal(this.provider.modTree[0], { expand: 2 });
    }

    dispose() {
        this.treeView.dispose();
    }
}

export const globalRefactorPreviewTreeViewManager = new RefactorPreviewViewManager();
