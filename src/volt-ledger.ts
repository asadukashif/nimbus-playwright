import { Page, BrowserContext } from "playwright";
import { Session, generateKasadaPayload, KasadaPayloadInput } from "hyper-sdk-js";
import { Route } from "@playwright/test";

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

export class VoltLedger {
    private session: Session;
    private userAgent: string;
    private ipAddress: string;
    private acceptLanguage: string;

    private scriptCapture: VoltLedgerCapture = {
        ipsScriptUrl: null,
        ipsResponseText: null,
        tlEndpointUrl: null
    };

    private ipsScriptPromise: Promise<void>;
    private resolveIpsScript: (() => void) | null = null;

    constructor(config: VoltLedgerConfig) {
        this.session = config.session;
        this.ipAddress = config.ipAddress;
        this.userAgent = config.userAgent || '';
        this.acceptLanguage = config.acceptLanguage || 'en-US,en;q=0.9';

        this.ipsScriptPromise = new Promise((resolve) => {
            this.resolveIpsScript = resolve;
        });
    }

    public async initialize(page: Page, context: BrowserContext): Promise<void> {
        await this.setupResponseHandler(page);
        await this.setupRequestInterceptors(page, context);
    }

    private async setupResponseHandler(page: Page): Promise<void> {
        page.on('response', async (response) => {
            const request = response.request();
            const requestUrl = request.url();

            try {
                if (request.method() === 'GET') {
                    await this.handleIpsScriptResponse(response, requestUrl);
                }
            } catch (error) {
                console.error('[VoltLedger] Error in response handler:', error);
            }
        });
    }

    private async handleIpsScriptResponse(response: any, requestUrl: string): Promise<void> {
        const ipsScriptPattern = /149e9513-01fa-4fb0-aad4-566afd725d1b\/2d206a39-8ed7-437e-a3be-862e0f06eea3\/ips\.js/;

        if (ipsScriptPattern.test(requestUrl)) {
            this.scriptCapture.ipsScriptUrl = requestUrl;

            const buffer = await response.body();
            this.scriptCapture.ipsResponseText = buffer.toString('utf-8');

            if (this.resolveIpsScript) {
                this.resolveIpsScript();
            }
        }
    }

    private async setupRequestInterceptors(page: Page, context: BrowserContext): Promise<void> {
        await page.route("https://reporting.cdndex.io/error", async (route) => {
            const request = route.request();

            try {
                if (request.method() === 'POST') {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({"": ""})
                    });
                    return;
                }

                return route.continue();
            } catch (error) {
                console.error('[VoltLedger] Error in reporting interceptor:', error);
                return route.continue();
            }
        });

        const tlEndpointPattern = /149e9513-01fa-4fb0-aad4-566afd725d1b\/2d206a39-8ed7-437e-a3be-862e0f06eea3\/tl$/;

        await page.route(tlEndpointPattern, async (route) => {
            const request = route.request();
            const requestUrl = request.url();

            try {
                if (this.shouldInterceptTlRequest(requestUrl, request.method())) {
                    await this.handleTlRequest(route, page, context);
                    return;
                }

                return route.continue();
            } catch (error) {
                console.error('[VoltLedger] Error in endpoint interceptor:', error);
                return route.continue();
            }
        });
    }

    private shouldInterceptTlRequest(requestUrl: string, method: string): boolean {
        const tlEndpointPattern = /149e9513-01fa-4fb0-aad4-566afd725d1b\/2d206a39-8ed7-437e-a3be-862e0f06eea3\/tl$/;
        return tlEndpointPattern.test(requestUrl) && method === 'POST';
    }

    private async handleTlRequest(route: Route, page: Page, context: BrowserContext): Promise<void> {
        await this.ipsScriptPromise;

        if (!this.scriptCapture.ipsResponseText) {
            console.warn('[VoltLedger] Missing script material, continuing original request');
            return route.continue();
        }

        if (!this.userAgent) {
            this.userAgent = await page.evaluate(() => navigator.userAgent);
        }

        const result = await generateKasadaPayload(this.session, new KasadaPayloadInput(
            this.userAgent,
            this.scriptCapture.ipsScriptUrl,
            this.scriptCapture.ipsResponseText,
            this.ipAddress,
            this.acceptLanguage
        ));

        const originalHeaders = route.request().headers();

        const modifiedHeaders = { ...originalHeaders };
        Object.keys(result.headers).forEach(headerName => {
            if (originalHeaders[headerName.toLowerCase()]) {
                modifiedHeaders[headerName.toLowerCase()] = result.headers[headerName];
            }
        });

        const payloadBuffer = Buffer.from(result.payload, 'base64');

        await route.continue({
            headers: modifiedHeaders,
            postData: payloadBuffer
        });
    }

    public getStatus(): VoltLedgerCapture {
        return { ...this.scriptCapture };
    }

    public reset(): void {
        this.scriptCapture = {
            ipsScriptUrl: null,
            ipsResponseText: null,
            tlEndpointUrl: null
        };

        this.ipsScriptPromise = new Promise((resolve) => {
            this.resolveIpsScript = resolve;
        });
    }
}
