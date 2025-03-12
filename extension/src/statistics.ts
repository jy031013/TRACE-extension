import { boolean } from 'io-ts';
import * as vscode from 'vscode';
import { postRequestToStatistics } from './services/backend-requests';

interface Log {
    timestamp: number;
    type: string;
    content: string;
}

export class StatisticsCollector {
    // standard timestamp collector
    private metrics: Map<string, number>;
    private timestamps: Map<string, number[]>;

    // collect logs of edit and query requests
    private __statisticsCollectionDisposables = new Set<vscode.Disposable>();
    private logs: Log[] = [];

    private uploadingStatisticsTimeout: NodeJS.Timeout | undefined;

    constructor() {
        this.metrics = new Map();
        this.timestamps = new Map();
    }

    enable() {
        // this.__statisticsCollectionDisposables.add(vscode.workspace.onDidSaveTextDocument((document) => {
        //     this.addLog("save", document.uri.toString());
        // }
        // ));
        this.uploadingStatisticsTimeout = setInterval(async () => {
            await this.sendAllMetrics(async (metrics) => (await postRequestToStatistics(
                this.wrapUserId(metrics)
            )) ? true : false);
            await this.sendAllLogs(async (logs) => (await postRequestToStatistics(
                this.wrapUserId(logs)
            )) ? true : false);
        }, 3000);
    }

    disable() {
        this.__statisticsCollectionDisposables.forEach((d) => d.dispose());
        this.__statisticsCollectionDisposables.clear();

        this.uploadingStatisticsTimeout && clearInterval(this.uploadingStatisticsTimeout);
        this.uploadingStatisticsTimeout = undefined;
    }


    // Increment a counter metric
    increment(metricName: string, value: number = 1): void {
        const currentValue = this.metrics.get(metricName) || 0;
        this.metrics.set(metricName, currentValue + value);
        this.recordTimestamp(metricName);
    }

    // Set a metric to a specific value
    setValue(metricName: string, value: number): void {
        this.metrics.set(metricName, value);
        this.recordTimestamp(metricName);
    }

    // Get the current value of a metric
    getValue(metricName: string): number {
        return this.metrics.get(metricName) || 0;
    }

    // Record timestamp for a metric
    private recordTimestamp(metricName: string): void {
        const timestamps = this.timestamps.get(metricName) || [];
        timestamps.push(Date.now());
        this.timestamps.set(metricName, timestamps);
    }

    // Get statistics summary
    getSummary(): { [key: string]: any } {
        const summary: { [key: string]: any } = {};
        
        this.metrics.forEach((value, key) => {
            summary[key] = {
                value,
                lastUpdated: this.getLastTimestamp(key),
                updateCount: this.getUpdateCount(key),
                timestamps: this.timestamps.get(key) || []
            };
        });

        return summary;
    }

    // Get the last timestamp for a metric
    getLastTimestamp(metricName: string): number {
        const timestamps = this.timestamps.get(metricName) || [];
        return timestamps[timestamps.length - 1] || 0;
    }

    // Get the number of updates for a metric
    getUpdateCount(metricName: string): number {
        const timestamps = this.timestamps.get(metricName) || [];
        return timestamps.length;
    }

    // Reset all statistics
    resetTimestamps(): void {
        this.metrics.clear();
        this.timestamps.clear();
    }

    async sendAllMetrics(sender: (data: object) => boolean | Promise<boolean>) {
        try {
            if (this.timestamps.size <= 0) {
                return;
            }

            const summary = this.getSummary();
            if (await Promise.resolve(sender({
                statistics: summary
            }))) {
                this.metrics.clear();
                this.timestamps.clear();
            }
        } catch (e) {
            console.error("Error sending metrics:", e);
        }
    }

    addLog(type: string, content: string): void {
        const log: Log = {
            timestamp: Date.now(),
            type,
            content
        };
        this.logs.push(log);
    }

    async sendAllLogs(sender: (data: object) => boolean | Promise<boolean>) {
        try {
            if (this.logs.length <= 0) {
                return;
            }

            if (await Promise.resolve(sender({
                logs: this.logs
            }))) {
                this.logs = [];
            }
        } catch (e) {
            console.error("Error sending logs:", e);
        }
    }

    wrapUserId(data: any) {
        const userId = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "unknown workspace folder";
        return { userId, data };
    }
}

// Create a singleton instance
export const statisticsCollector = new StatisticsCollector();
statisticsCollector.enable();
