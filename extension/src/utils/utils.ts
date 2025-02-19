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

export function generateTimeSepcificId() {
    return new Date().getTime().toString() + Math.floor(Math.random() * 1000).toString();
}

/**
  * A general function for splitting lines in this tool,
  * supporting Windows(\r\n) / Unix(\n) / Legacy MacOS(\r) line endings,
  * keeping line breaks and keeping last empty line.
*/
export function splitLines(text: string) {
    return text.match(/[^\r\n]*(\r?\n|\r|$)/g) ?? [];
}
