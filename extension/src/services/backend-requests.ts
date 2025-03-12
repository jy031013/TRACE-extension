import axios from 'axios';
import vscode from 'vscode';
import { DisposableComponent } from '../utils/base-component';
import { RequestEdit } from '../utils/base-types';

export type PreJudgedLspType = 'def&ref' | 'clone' | 'diagnose' | 'normal';
export type ResponseInvokerLspType = 'def&ref' | 'clone' | 'rename' | 'normal';

export interface RequestLspFoundLocation {
    file_path: string;
    start: {
        line: number;
        col: number;
    };
    end: {
        line: number;
        col: number;
    };
    type?: string;
    description?: string;
}

export type ResponseEditLocationWithLabels = {
    code_window_start_line: number;
    inline_labels: string[];
    inline_confidences: number[];
    inter_labels: string[];
    inter_confidences: number[];
    service_name: PreJudgedLspType;
}

type GeneralRequestForInvokerAndLocator = {
    language: string;
    commitMsg: string;
    prevEdits: RequestEdit[];
    files: {
        [key: string]: string[];
    };
    lspServiceName: PreJudgedLspType;
    lspFoundLocations: RequestLspFoundLocation[];
}

export type RequestNavEditInvoker = GeneralRequestForInvokerAndLocator;
export type RequestNavEditLocator = GeneralRequestForInvokerAndLocator;

export type RequestGenerator = {
    language: string;
    filePath: string;
    atLine: number;
    codeWindow: string[];
    interLabels: string[];
    inlineLabels: string[];
    commitMessage: string;
    prevEdits: RequestEdit[];
    prevEditType: PreJudgedLspType;
    lspServiceName: PreJudgedLspType;
};

export type ResponseNavEditDefRefInfo = {
    type: 'def' | 'ref',
    name: string;
    name_range_start: [number, number];
    name_range_end: [number, number];
    before_args?: string[];
    after_args?: string[];
    before_args_num?: number;
    after_args_num?: number;
}

export type ResponseNavEditInvoker = {
    type: ResponseInvokerLspType;
    info: object;
} | ResponseNavEditLocator;

export type ResponseNavEditLocator = {
    files: {
        [key: string]: ResponseEditLocationWithLabels[];
    }
};

export type ResponseGenerator = string[];   // TODO need confidence here

async function basicQuery(path: string, json_obj: any) {
    return await modelServerProcess.request(path, json_obj);
}

async function postRequestToDiscriminator(json_obj: any) {
    return await basicQuery("discriminator", json_obj);
}

async function postRequestToLocator(json_obj: any) {
    return await basicQuery("range", json_obj);
}

async function postRequestToNavEditInvoker(data: RequestNavEditInvoker): Promise<ResponseNavEditInvoker | undefined> {
    return await basicQuery("navedit/invoker", data);
}

async function postRequestToNavEditLocator(data: RequestNavEditLocator): Promise<ResponseNavEditLocator | undefined> {
    return await basicQuery("navedit/locator", data);
}

async function postRequestToGenerator(data: RequestGenerator): Promise<ResponseGenerator | undefined> {
    return await basicQuery("content", data);
}

export {
    postRequestToDiscriminator,
    postRequestToLocator,
    postRequestToGenerator,
    postRequestToNavEditInvoker,
    postRequestToNavEditLocator
};

class ModelServerProcess extends DisposableComponent {
    apiUrl: string;
    proxy: {host: string, port: number} | undefined;

    constructor() {
        super();
        this.apiUrl = this.getApiUrl();
        this.proxy = undefined;

        const vscodeProxyConfigValue = vscode.workspace.getConfiguration('http').get('proxy');
        const vscodeProxyConfig = typeof (vscodeProxyConfigValue) === 'string' ? vscodeProxyConfigValue : undefined;

        if (vscodeProxyConfig?.trim()) {
            const parseResult = parseProxyUrl(vscodeProxyConfig);
            if (parseResult) {
                this.proxy = parseResult;
            }
        }

        this.register(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("navEdit.queryURL")) {
                    this.apiUrl = this.getApiUrl();
                }
            })
        );
    }

    getApiUrl() {
        const apiUrlConfigValue = vscode.workspace.getConfiguration("navEdit").get("queryURL");
        const apiUrl = typeof(apiUrlConfigValue) === 'string' ? apiUrlConfigValue : "http://localhost:5000";
        return apiUrl;
    }

    toURL(path: string) {
        return (new URL(path, this.apiUrl)).href ;
    }

    async request(path: string, data: object) {
        const response = await axios.post(this.toURL(path), data, {
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 200000,
            proxy: this.proxy
        });
        if (response.statusText === 'OK') {
            return response.data;
        } else {
            throw new axios.AxiosError(JSON.stringify(response));
        }
    }
}

// FIXME atLines must be continuous now, or it will just be the range between the first and the last line number, which is not a good representation
// FIXME reading files take too long time

export const modelServerProcess = new ModelServerProcess();

function parseProxyUrl(proxyUrl: string) {
    const regex = /^(http[s]?:\/\/)?(?:[^:@/]*:?[^:@/]*@)?([^:/?#]+)(:(\d+))?$/;
    const match = proxyUrl.match(regex);

    if (match) {
        const [_0, protocol, host, _3, portStr] = match;
        let port: number | undefined;
        if (portStr) {
            port = parseInt(match[4], 10);
        } else if (protocol) {
            port = protocol.includes("https") ? 443 : 80;
        }

        if (port) {
            return { host, port };
        }
    }
    return null;
}
