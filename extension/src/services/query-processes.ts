import * as vscode from 'vscode';
import { CodeRangesInFile } from '../editor-state-monitor';
import { createFullEditRenameRefactor, createRenameRefactor, globalQueryContext, Refactor } from '../global-result-context';
import { statusBarItem } from '../ui/progress-indicator';
import { RequestEdit, SimpleEdit } from '../utils/base-types';
import { getActiveFilePath, getLineInfoInDocument, toAbsPath, toRelPath } from '../utils/file-utils';
import { modelServerProcess, postRequestToDiscriminator, postRequestToGenerator, postRequestToLocator, postRequestToTRACEInvoker, postRequestToTRACELocator, PreJudgedLspType, RequestGenerator, RequestLspFoundLocation, RequestTRACEInvoker, ResponseEditLocationWithLabels, ResponseGenerator, ResponseTRACEDefRefInfo, ResponseTRACEInvoker, ResponseTRACELocator } from './backend-requests';

/* 
    The following is experimental code for wrapping backend request
    into a cancellable object. Try replacing the JSON validation with
    libraries like io-ts or arkType.
*/

// cancellable, request process
type RequestStatus = {
    status: 'not-started' | 'started' | 'cancelled' | 'succeeded' | 'failed';
    result?: any;
}
type RequestOptions = {
    cancelPath?: string;
    cancelData?: object;
}

type indicatedResult<T> = {
    desc: string,
    success: boolean,
    data: T
};
function isIndicatedResult<T>(value: any, typeCheck: (value: any) => value is T): value is indicatedResult<T> {
    return value
        && typeof value.desc === 'string'
        && typeof value.success === 'boolean'
        && typeCheck(value.data);
}
function indicatedPromise<T>(desc: string, promise: Promise<T>): Promise<indicatedResult<T>> {
    return promise.then(
        (result) => ({ desc: desc, success: true, data: result }),
        (error) => ({ desc: desc, success: false, data: error })
    );
}

type Condition<T> = {
    promise: Promise<T>;
    allowedStatus?: boolean;
};
function expectCondition<T>(promise: Promise<any> | undefined, allowedStatus?: boolean): Condition<T> | undefined {
    if (promise === undefined) {
        return undefined;
    }

    const condition: Condition<T> = { promise };
    if (allowedStatus !== undefined) {
        condition.allowedStatus = allowedStatus;
    }
    return condition;
}
function wrapCondition<T>(condition: Condition<T>) {
    const acceptResolve = condition.allowedStatus !== false;
    const accpetReject = condition.allowedStatus !== true;

    return new Promise((res: (value: T) => void, rej: (value: T | Error) => void) => {
        condition.promise.then(
            (result) => acceptResolve ? res(result) : rej(result),
            (error) => accpetReject ? res(error) : rej(error)
        );
    });
}
class ConditionFilter<T> {
    private conditionStack: Condition<T>[][] = [];
    private defaultResult: T | undefined = undefined;

    wait(condition: Condition<T> | undefined) {
        const newLayer: Condition<T>[] = [];
        if (condition !== undefined) {
            newLayer.push(condition);
        }
        this.conditionStack.push(newLayer);

        return this;
    }

    or(condition: Condition<T> | undefined) {
        if (this.conditionStack.length === 0) {
            throw new RangeError('No previous condition to perform `or`');
        }

        const lastLayer = this.conditionStack.at(-1);
        if (lastLayer && condition !== undefined) {
            lastLayer.push(condition);
        }

        return this;
    }

    else(defaultResult: T) {
        this.defaultResult = defaultResult;
        return this;
    }

    // resolve a result, not throwing error but just pass it when a promise is required to fail
    async result(): Promise<T | Error | undefined> {
        for (const layer of this.conditionStack) {
            try {
                const expectedResultOrError = await Promise.any(layer.map(condition => wrapCondition(condition)));
                return expectedResultOrError;
            } catch { }
        }
        return this.defaultResult;
    }
}

class BackendRequest {
    private path: string;
    private requestData: object;
    private options: RequestOptions = {};

    private processes: { [key: string]: Promise<undefined | object>; } = {};
    private resolvedStatus: RequestStatus;

    constructor (path: string, requestData: object, options?: RequestOptions) {
        this.path = path;
        this.requestData = requestData;
        
        if (options) {
            this.updateOptions(options);
        }
        
        // set default values
        this.resolvedStatus = { status: 'not-started' };
    }

    private cancelPath() {
        return (`/cancel${this.path}`);
    }

    private defaultFailedResult(error?: any): RequestStatus {
        return { status: 'failed', result: error };
    }

    private startProcess(key: string, promise: Promise<undefined | object>) {
        this.processes[key] = promise;
    }
    
    private expectProcess(desc: string, allowedStatus?: boolean): Condition<RequestStatus> | undefined {
        return expectCondition(
            indicatedPromise(desc, this.processes[desc]),
            allowedStatus
        );
    }

    private async getRequestOrCancelled(): Promise<RequestStatus> {
        // if it is cancelled or failed, the result or error will immediately be returned
        try {
            const result = await new ConditionFilter<RequestStatus>()
                .wait(this.expectProcess('request', true)).or(this.expectProcess('cancel', true))
                .wait(this.expectProcess('cancel', false))
                .wait(this.expectProcess('request', false))
                .else({ status: 'failed' })
                .result();
            if (result === undefined) {
                return this.defaultFailedResult();
            } else if (result instanceof Error) {
                return this.defaultFailedResult(result);
            } else {
                return result;
            }
        } catch (error) {
            return this.defaultFailedResult(error);
        }
    }

    private async getRequestOrCancelledResult(): Promise<RequestStatus> {
        if (this.status === 'started') {
            this.resolvedStatus = await this.getRequestOrCancelled();
        }
        return this.resolvedStatus;
    }

    private tryStartRequest() {
        if (this.status === 'not-started') {
            const promise = modelServerProcess.request(this.path, this.requestData);
            this.startProcess('request', promise);
            this.resolvedStatus = { status: 'started' };
            return true;
        }
        return false;
    }

    private tryCancelRequest() {
        if (this.status === 'started' && !('cancel' in this.processes)) {
            const promise = modelServerProcess.request(this.cancelPath(), this.options.cancelData || {});
            this.startProcess('cancel', promise);
            return true;
        }
        return false;
    }

    get status() {
        return this.resolvedStatus.status;
    }

    updateOptions(options: RequestOptions) {
        this.options = { ...this.options, ...options };
    }

    async getResponse(): Promise<RequestStatus> {
        this.tryStartRequest();
        return await this.getRequestOrCancelledResult();
    }
    
    async cancel() {
        this.tryCancelRequest();
        return await this.getRequestOrCancelled();
    }
}

/*
    Request processes for different backend API
*/

async function requestAndUpdateLocation(
    rootPath: string, 
    files: [string, string][],
    prevEdits: SimpleEdit[],
    commitMessage: string, 
    language: string
) {
    /* 
        Discriminator:
        input:
        {
            "rootPath":         str, rootPath,
            "files":            list, [[filePath, fileContent], ...],
            "targetFilePath":   str, filePath
        }
        output:
        {
            "data": list, [filePath, ...]
        }
	
        Locator:
        input:
        {
            "files":            list, [[filePath, fileContent], ...],
            "targetFilePath":   str, filePath,
            "commitMessage":    str, edit description,
            "prevEdits":        list, of previous edits, each in format: {"beforeEdit":"", "afterEdit":""}
        }
        output:
        {
            "data": 
            [ 
                { 
                    "targetFilePath":   str, filePath,
                    "toBeReplaced":     str, the content to be replaced, 
                    "editType":         str, the type of edit, add or remove,
                    "lineBreak":        str, '\n', '\r' or '\r\n',
                    "atLines":           number, line number (beginning from 1) of the location
                }, ...
            ]
        }
     */
    const activeFileAbsPath = getActiveFilePath();
    if (!activeFileAbsPath) {
        return;
    }
    
    const activeFilePath = toRelPath(
        rootPath,
        activeFileAbsPath
    );

    // convert all paths to relative paths
    for (const file_info of files) {
        file_info[0] = toRelPath(
            rootPath,
            file_info[0]
        );
    }

    // Send to the discriminator model for analysis
    const disc_input = {
        rootPath: rootPath,
        files: files,
        targetFilePath: activeFilePath,
        commitMessage: commitMessage,
        prevEdits: prevEdits,
        language: language
    };
    const discriminatorOutput = await postRequestToDiscriminator(disc_input);

    // Send the selected files to the locator model for location prediction
    const filteredFiles = files.filter(([filename, _]) => discriminatorOutput.data.includes(filename));

    const loc_input = {
        files: filteredFiles,
        targetFilePath: activeFilePath,
        commitMessage: commitMessage,
        prevEdits: prevEdits,
        language: language
    };
    statusBarItem.setStatusQuerying("locator");
    
    const locatorOutput = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyzing...' }, async () => {
        return await postRequestToLocator(loc_input);
    });
    // const locatorOutput = await postRequestToLocator(loc_input);

    // TODO add strict format check for each "valid type" of locatorOutput
    if (locatorOutput?.type === 'rename' && locatorOutput?.data?.length) {
        const refactorInfo = locatorOutput.data[0];
        const renameRefactor = await createRenameRefactor(
            refactorInfo.file,
            refactorInfo.line,
            refactorInfo.beforeText,
            refactorInfo.afterText
        );
        if (renameRefactor) {
            globalQueryContext.updateRefactor(renameRefactor);
        }
        return renameRefactor;
    } else {
        // convert all paths back to absolute paths
        let rawLocations = locatorOutput.data;
        for (const loc of rawLocations) {
            loc.targetFilePath = toAbsPath(rootPath, loc.targetFilePath);
            loc.lineInfo = await getLineInfoInDocument(loc.targetFilePath, loc.atLines[0]);
        }
        // TODO add failure processing if there are no locations in response
        globalQueryContext.updateLocations(rawLocations);
        return rawLocations;
    }
}

export interface CachedRenameOperation {
    identifier: string;
    ranges: CodeRangesInFile[];
}

/**
 * Determine and suggest where should the next edit(s)
 * be made based on current workspace state.
 * 
 * @param files In the format of `[relativePath, fileRepresentation]`.
 * Files those were not changed should be
 * passed in as `string`, and those were changed should be `FileAsHunks`.
 * 
 * This is a representation that contains any necessary files used to judge potential
 * new edits, with the information of the last edit.
 * We assume the input only imply **a current** and **a previous**
 * file state, then the last edit is the two-snapshot difference between 
 * the current and previous files. 
 * 
 * @param prevEdits The previous edits, in the format of `Edit[]`. Although the edits were
 * implied in `files` parameter, we use this another parameter for requesting the invoker model.
 * @param commitMessage A message that describes the intention of the edit.
 * @param language The language identifier based on VS Code of the current file.
 * @returns An array, containing suggested locations with their extra info.
 */
async function requestInvokerAndLocationByTRACE(
    files: { [key: string]: string[] },
    prevEdits: RequestEdit[],
    commitMessage: string, 
    language: string,
    lspServiceName: PreJudgedLspType,
    lspFoundLocations: RequestLspFoundLocation[],
    cachedRenameOperation: CachedRenameOperation | undefined
): Promise<ResponseTRACEInvoker | ['rename', Refactor] | ['def&ref', ResponseTRACEDefRefInfo] | ['location', { [key: string]: ResponseEditLocationWithLabels[] }] | undefined> {

    const invokerInput: RequestTRACEInvoker = {
        language: language,
        commitMsg: commitMessage,
        prevEdits: prevEdits,
        files: files,
        lspServiceName: lspServiceName,
        lspFoundLocations: lspFoundLocations
    };
    statusBarItem.setStatusQuerying("locator");
    
    const invokerOutput = await postRequestToTRACEInvoker(invokerInput);

    if (!invokerOutput) return undefined;

    // TODO add strict format check for each "valid type" of locatorOutput
    if ('type' in invokerOutput) {
        if (invokerOutput.type === 'rename') {

            // Old-fashion way, by intentional renaming twice to trigger rename provider
            const refactorInfo = invokerOutput.info as any;
            const renameRefactor = await createFullEditRenameRefactor(
                prevEdits[0],
                refactorInfo.added_identifiers[0].start[0],
                refactorInfo.added_identifiers[0].start[1],
                refactorInfo.deleted_identifiers[0].name,
                refactorInfo.added_identifiers[0].name
            );
            if (renameRefactor) {
                return ['rename', renameRefactor];
            }
            
            // if (cachedRenameOperation) {
            //     if (prevEdits.length === 0) {
            //         return;
            //     }
            //     const lastEditUri = vscode.Uri.file(prevEdits[prevEdits.length - 1].path);
            //     const lastEditLine = prevEdits[prevEdits.length - 1].line;
                
            //     const filteringRenameInfo = invokerOutput.info as ResponseTRACEInvokerRenameInfo;
                
            //     if (filteringRenameInfo.added_identifiers.length > 0) {
            //         const primaryInfo = filteringRenameInfo.added_identifiers[0];
            //         const renameRefactor = createDeterminedRenameRefactor(primaryInfo.name, cachedRenameOperation.ranges);
            //         renameRefactor.removeOriginalRename(lastEditUri,
            //             new vscode.Position(
            //                 primaryInfo.start[0] + lastEditLine,
            //                 primaryInfo.start[1]
            //             )
            //         );

            //         return ['rename', renameRefactor];
            //     }

            // } else {
            //     console.trace('no cached rename operation found, nothing is done');
            // }
        } else if (invokerOutput.type === 'def&ref') {
            return ['def&ref', invokerOutput.info as ResponseTRACEDefRefInfo];
        }
    } else if ('files' in invokerOutput) {
        return ['location', invokerOutput.files]; 
    } else {
        return invokerOutput;
    }
}

export async function requestTRACELocator(
    files: { [key: string]: string[] },
    prevEdits: RequestEdit[],
    commitMessage: string,
    language: string,
    lspServiceName: PreJudgedLspType,
    lspFoundLocations: RequestLspFoundLocation[],
    cachedRenameOperation: CachedRenameOperation | undefined
): Promise<ResponseTRACELocator | undefined> {

    const locatorInput: RequestTRACEInvoker = {
        language: language,
        commitMsg: commitMessage,
        prevEdits: prevEdits,
        files: files,
        lspServiceName: lspServiceName,
        lspFoundLocations: lspFoundLocations
    };
    statusBarItem.setStatusQuerying("locator");

    const locatorOutput = await postRequestToTRACELocator(locatorInput);

    return locatorOutput;
}

async function requestEdit(
    language: string,
    filePath: string,
    atLine: number,
    codeWindow: string[],
    interLabels: string[],
    inlineLabels: string[],
    commitMessage: string,
    prevEdits: RequestEdit[],
    prevEditType: PreJudgedLspType,
    lspServiceName: PreJudgedLspType
): Promise<ResponseGenerator | undefined> {

    const generatorInput: RequestGenerator = {
        language: language,
        filePath: filePath,
        atLine: atLine,
        codeWindow: codeWindow,
        interLabels: interLabels,
        inlineLabels: inlineLabels,
        commitMessage: commitMessage,
        prevEdits: prevEdits,
        prevEditType: prevEditType,
        lspServiceName: lspServiceName
    };

    const generatorOutput = await postRequestToGenerator(generatorInput);
    
    return generatorOutput;
}

export {
    requestAndUpdateLocation,
    requestEdit,
    requestInvokerAndLocationByTRACE
};

