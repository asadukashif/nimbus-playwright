import { BrowserContext, Page } from "playwright";
import { Session } from "hyper-sdk-js";
export interface NimbusKitConfig {
    session: Session;
    ipAddress: string;
    userAgent?: string;
    acceptLanguage?: string;
}
export interface NimbusKitCapture {
    scriptUrl: string | null;
    scriptSrc: string | null;
    sbsdScriptUrl: string | null;
    sbsdResponseText: string | null;
    sbsdUuid: string | null;
}
export declare class NimbusKit {
    private session;
    private userAgent;
    private ipAddress;
    private acceptLanguage;
    private sessionContext;
    private sbsdContext;
    private telemetryContext;
    private sbsdScriptSrc;
    private scriptCapture;
    private scriptSrcPromise;
    private resolveScriptSrc;
    private payloadMutex;
    private sbsdMutex;
    private telemetryMutex;
    constructor(config: NimbusKitConfig);
    initialize(page: Page, context: BrowserContext): Promise<void>;
    private setupResponseHandler;
    private handlePrimaryScriptResponse;
    private handleSbsdScriptResponse;
    private setupRequestInterceptor;
    private shouldInterceptPayloadRequest;
    private shouldInterceptSbsdRequest;
    private handlePayloadRequest;
    private handleTelemetryRequest;
    private handleSbsdRequest;
    getStatus(): NimbusKitCapture & {
        sessionContext: string;
        sbsdContext: string;
        telemetryContext: string;
    };
    reset(): void;
}
