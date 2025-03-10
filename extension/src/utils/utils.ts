export function limitNum(x: number, lower: number, upper: number) {
    if (x <= lower)
        x = lower;
    if (x >= upper)
        x = upper;
    return x;
}

// <https://stackoverflow.com/questions/32858626/detect-position-of-first-difference-in-2-strings>
export function findFirstDiffPos(a: string, b: string) {
    let i = 0;
    if (a === b) return -1;
    while (a[i] === b[i]) i++;
    return i;
}

export function generateTimeSpecificId() {
    return new Date().getTime().toString() + Math.floor(Math.random() * 1000).toString();
}

/**
 * A general function for splitting lines in this tool,
 * supporting Windows(\r\n), Unix(\n), and Legacy MacOS(\r) line endings,
 * keeping line breaks, and optionally keeping the last empty line.
 * 
 * @param text - The input string to split.
 * @param keepLastEmptyLine - A boolean flag to indicate if the last empty line should be kept.
 * @returns An array of strings split by line breaks, with the option to keep the last empty line.
 */
export function splitLines(text: string, keepLastEmptyLine: boolean = true): string[] {
    // Split the text into lines with line breaks preserved
    const lines = text.match(/[^\r\n]*(\r?\n|\r|$)/g) ?? [];
    
    // If keepLastEmptyLine is false, remove the last element if it's an empty string
    if (!keepLastEmptyLine && lines[lines.length - 1] === "") {
        lines.pop();
    }
    
    return lines;
}

/**
 * In an array representing several lines,
 * based on some line, extract its block bounded by empty lines.
 * @param lines Lines in a block/hunk.
 * @param lineNum The base line to extract the block.
 * @returns 
 */
export function extractBlock(lines: string[], lineNum: number): string[] {
    if (lineNum >= lines.length) {
        return [];
    }

    let start = lineNum;
    let end = lineNum;
    while (start > 0 && lines[start - 1].trim() !== "") {
        start--;
    }
    while (end < lines.length - 1 && lines[end + 1].trim() !== "") {
        end++;
    }
    return lines.slice(start, end + 1);
}
