import { Page, BrowserContext } from 'playwright';
import { Session } from 'hyper-sdk-js';
export interface HarborMintConfig {
    session: Session;
    ipAddress: string;
    userAgent?: string;
    acceptLanguage?: string;
}
export interface HarborMintCapture {
    interceptedPaths: string[];
    detectedScripts: Map<string, string>;
}
export declare class HarborMint {
    private session;
    private userAgent;
    private ipAddress;
    private acceptLanguage;
    private utmvc;
    private scriptCapture;
    private scriptPathToScriptUrl;
    private scriptPathToScriptContent;
    private seenScriptPaths;
    constructor(config: HarborMintConfig);
    initialize(page: Page, context: BrowserContext): Promise<void>;
    private setupScriptDetector;
    private setupRequestInterceptor;
    private findMatchingScriptPath;
    private shouldInterceptRequest;
    private handlePayloadRequest;
    getStatus(): HarborMintCapture & {
        scriptUrls: Map<string, string>;
    };
    reset(): void;
}
