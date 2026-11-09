import { Page, BrowserContext } from 'playwright';
import { Session } from 'hyper-sdk-js';
export interface PlexiRailConfig {
    session: Session;
    ipAddress: string;
    userAgent?: string;
    acceptLanguage?: string;
}
export interface PlexiRailCapture {
    puzzleImageUrl: string | null;
    pieceImageUrl: string | null;
    puzzleImageBase64: string | null;
    pieceImageBase64: string | null;
    gatePageUrl: string | null;
    deviceCheckLink: string | null;
    interstitialPageUrl: string | null;
    interstitialPageText: string | null;
    auxScriptUrl: string | null;
    auxScript: string | null;
}
export declare class PlexiRail {
    private session;
    private userAgent;
    private ipAddress;
    private acceptLanguage;
    private capture;
    private isProcessing;
    private imagesPromise;
    private resolveImages;
    private auxScriptPromise;
    private resolveAuxScript;
    constructor(config: PlexiRailConfig);
    initialize(page: Page, context: BrowserContext): Promise<void>;
    private setupRequestInterception;
    private setupResponseHandler;
    private isPuzzleImageRequest;
    private isPieceImageRequest;
    private isGatePageRequest;
    private isInterstitialPageRequest;
    private isAuxScriptRequest;
    private handleAuxScriptResponse;
    private auxScriptFor;
    private handlePuzzleImageResponse;
    private handlePieceImageResponse;
    private checkIfImagesReady;
    private handleGatePageResponse;
    private handleInterstitialPageResponse;
    private findGateFramePage;
    private runFrameAction;
    getStatus(): PlexiRailCapture & {
        isProcessing: boolean;
    };
    reset(): void;
}
