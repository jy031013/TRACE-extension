function copyObj(obj: any) {
    return JSON.parse(JSON.stringify(obj));
}

const mockDemo1Locator = [
    [{
        "targetFilePath": 'util/chunk/chunk.go',
        "editType": "replace",
        "lineBreak": "\n",
        "atLines": [90]
    }],
    [{
        "targetFilePath": 'util/chunk/chunk.go',
        "editType": "replace",
        "lineBreak": "\n",
        "atLines": [101]
    },
    {
        "targetFilePath": 'util/chunk/row.go',
        "editType": "replace",
        "lineBreak": "\n",
        "atLines": [213]
    }],
    []
];
const mockDemo1Generator = [
    {
        "editType": "replace",
        "replacement": ['	newChk.requiredRows = maxChunkSize']
    },
    {
        "editType": "replace",
        "replacement": ['	return renewWithCapacity(chk, newCap, maxChunkSize)']
    },
    {
        "editType": "replace",
        "replacement": ['	newChk := renewWithCapacity(r.c, 1, 1)']
    },
    undefined
];
const mockDemo2Locator = [
    [{
        "targetFilePath": "modules/sd_samplers_kdiffusion.py",
        "editType": "replace",
        "lineBreak": "\n",
        "atLines": [285]
    },
    {
        "targetFilePath": "modules/sd_samplers_kdiffusion.py",
        "editType": "replace",
        "lineBreak": "\n",
        "atLines": [287]
    },
    {
        "targetFilePath": "modules/sd_samplers_kdiffusion.py",
        "editType": "replace",
        "lineBreak": "\n",
        "atLines": [289]
    },
    {
        "targetFilePath": "modules/sd_samplers_kdiffusion.py",
        "editType": "replace",
        "lineBreak": "\n",
        "atLines": [291]
    }],
    []
];
const mockDemo2Generator = [
    {
        "editType": "replace",
        "replacement": ["        if 'sigma_max' in parameters:"]
    },
    {
        "editType": "replace",
        "replacement": ["        if 'n' in parameters:"]
    },
    {
        "editType": "replace",
        "replacement": ["        if 'sigma_sched' in parameters:"]
    },
    {
        "editType": "replace",
        "replacement": ["        if 'sigmas' in parameters:"]
    },
    undefined
];


class MockBackend {
    static counter = {
        loc: -1,
        gen: -1,
        'rename-loc': -1
    };
    
    static async delayedResponse(res_type: string, json_obj: any) {
        if (res_type === 'loc' || res_type === 'gen' || res_type === 'rename-loc') {
            this.counter[res_type] += 1;
        } 

        await new Promise(resolve => {
            setTimeout(resolve, 1000);
        });
        switch (res_type) {
            case "disc":
                return { "data": json_obj.files.map((file_info: any[]) => file_info[0]).slice(0, 3) };
            case "loc":
                return {
                    // "data": [
                    //     {
                    //         "targetFilePath": json_obj.files[0][0],
                    //         "editType": "add",
                    //         "lineBreak": "\n",
                    //         "atLines": [0]
                    //     },
                    //     {
                    //         "targetFilePath": json_obj.files[1][0],
                    //         "editType": "replace",
                    //         "lineBreak": "\n",
                    //         "atLines": [2]
                    //     }
                    // ]
                    "data": mockDemo2Locator[this.counter['loc'] % mockDemo2Locator.length].map(x => copyObj(x))
                };
            case "gen":
                return {
                    // "data": {
                    //     "editType": json_obj.editType,
                    //     "replacement":
                    //         [
                    //             "1231233312",
                    //             "4546666666\n4545445",
                    //             "77788888",
                    //             "9999999999"
                    //         ]
                    // }
                    "data": copyObj(mockDemo2Generator[this.counter['gen'] % mockDemo2Generator.length])
                };
            case "rename-loc":
                return {
                    "type": "rename",
                    // "data": [
                    //     {
                    //         "file": "a.py",
                    //         "line": 2,
                    //         "beforeText": "def ad(a, b):",
                    //         "afterText": "def add(a, b):"
                    //     },
                    // ]
                    
                    // the first rename that user has already performed
                    "data": this.counter['rename-loc'] === 0 ? [
                        {
                            "file": "modules/sd_samplers_kdiffusion.py",
                            "line": 279,
                            "beforeText": "        extra_params_kwargs = self.initialize(p)",
                            "afterText": "        init_extra_params_kwargs = self.initialize(p)"
                        },
                    ] : []
                };
        }
    }
}

/* Rewrite request functions, only in the test scope */

async function postRequestToDiscriminator(json_obj: any) {
    return await MockBackend.delayedResponse('disc', json_obj);
}

async function postRequestToLocator(json_obj: any) {
    return await MockBackend.delayedResponse('rename-loc', json_obj);
}

async function postRequestToGenerator(json_obj: any) {
    return await MockBackend.delayedResponse('gen', json_obj);
}

import backendRequests from '../src/services/backend-requests';

import { runTests } from '@vscode/test-electron';

