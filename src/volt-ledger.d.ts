import { Page, BrowserContext } from "playwright";
import { Session } from "hyper-sdk-js";
export interface VoltLedgerConfig {
    session: Session;
    ipAddress: string;
    userAgent?: string;
    acceptLanguage?: string;
}
export interface VoltLedgerCapture {
    ipsScriptUrl: string | null;
    ipsResponseText: string | null;
    tlEndpointUrl: string | null;
}
export declare class VoltLedger {
    private session;
    private userAgent;
    private ipAddress;
    private acceptLanguage;
    private scriptCapture;
    private ipsScriptPromise;
    private resolveIpsScript;
    constructor(config: VoltLedgerConfig);
    initialize(page: Page, context: BrowserContext): Promise<void>;
    private setupResponseHandler;
    private handleIpsScriptResponse;
    private setupRequestInterceptors;
    private shouldInterceptTlRequest;
    private handleTlRequest;
    getStatus(): VoltLedgerCapture;
    reset(): void;
}
