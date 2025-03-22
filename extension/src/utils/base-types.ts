import vscode from 'vscode';

export type EditType = "add" | "replace" | "remove";

export type LineBreak = "\r" | "\n" | "\r\n";

export type SimpleEdit = {
    afterEdit: string[], // string list, can be empty list if no code added
    beforeEdit: string[] // string list, can be empty list if no code added
}

export type LocatorLocation = {
    targetFilePath: string;
    editType: EditType;
    lineBreak: LineBreak;
    atLines: number[];
    lineInfo: {
        range: vscode.Range,
        text: string
    }
};

export type ApiRequestGenerator = {
    atLines: number[],
    editType: EditType,
    endPos: number,
    lineBreak: LineBreak,
    prevEdits: SimpleEdit[],
    startPos: number,
    targetFilePath: string,
    toBeReplaced: string,
    lineInfo: {
        range: vscode.Range,
        text: string
    }
};

export type SingleLineEdit = {
    location: vscode.Location,  // always the beginning of the line
    beforeContent: string, 
    afterContent: string
};

export type FileEdits = [vscode.Uri, vscode.TextEdit[]];

export type RequestEdit = {
    path: string; // the file path
    line: number; // starting line
    rmLine: number; // number of removed lines
    rmText: string[]; // removed text, if no text removed, then empty list
    addLine: number; // number of added lines
    addText: string[]; // added text, if no text added, then empty list
    codeAbove: string[],
    codeBelow: string[]
}

export type EditWithTimestamp = {
    uriString: string; // the file path
    line: number;                   // starting line of the before version
    currentStartLine: number;    // starting line of the after version, for alignment to current document
    rmLine: number; // number of removed lines
    rmText: string[]; // removed text, if no text removed, then empty list
    addLine: number; // number of added lines
    addText: string[]; // added text, if no text added, then empty list
    codeAbove: string[],
    codeBelow: string[],
    timestamp: number
}

export const supportedLanguages = [
    "go",
    "python",
    "typescript",
    "javascript",
    "java"
];

export type FileAsHunks = (string[] | SimpleEdit)[];

export function isLanguageSupported(lang: string) {
    return supportedLanguages.includes(lang);
}

