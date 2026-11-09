import {BrowserContext, Page} from "playwright";
import {Session, generateSensorData, SensorInput, generateSbsdPayload, SbsdInput, generateTelemetry, TelemetryInput} from "hyper-sdk-js";
import {Route} from "@playwright/test";

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

class AsyncMutex {
    private queue: Promise<void> = Promise.resolve();

    async acquire(): Promise<() => void> {
        let release: () => void;
        const next = new Promise<void>(resolve => {
            release = resolve;
        });
        const prev = this.queue;
        this.queue = next;
        await prev;
        return release!;
    }
}

export class NimbusKit {
    private session: Session;
    private userAgent: string;
    private ipAddress: string;
    private acceptLanguage: string;
    private sessionContext: string = "";
    private sbsdContext: string = "";
    private telemetryContext: string = "";
    private sbsdScriptSrc: string | null = null;

    private scriptCapture: NimbusKitCapture = {
        scriptUrl: null,
        scriptSrc: null,
        sbsdScriptUrl: null,
        sbsdResponseText: null,
        sbsdUuid: null
    };

    private scriptSrcPromise: Promise<void>;
    private resolveScriptSrc: (() => void) | null = null;

    private payloadMutex = new AsyncMutex();
    private sbsdMutex = new AsyncMutex();
    private telemetryMutex = new AsyncMutex();

    constructor(config: NimbusKitConfig) {
        this.session = config.session;
        this.ipAddress = config.ipAddress;
        this.userAgent = config.userAgent || '';
        this.acceptLanguage = config.acceptLanguage || 'en-US,en;q=0.9';

        this.scriptSrcPromise = new Promise((resolve) => {
            this.resolveScriptSrc = resolve;
        });
    }

    public async initialize(page: Page, context: BrowserContext): Promise<void> {
        await this.setupResponseHandler(page);
        await this.setupRequestInterceptor(page, context);
    }

    private async setupResponseHandler(page: Page): Promise<void> {
        page.on('response', async (response) => {
            const request = response.request();
            const headers = response.headers();
            const requestUrl = request.url();

            try {
                if (request.method() === 'GET' && 'time-to-live-seconds' in headers) {
                    await this.handlePrimaryScriptResponse(response, requestUrl);
                }

                if (request.method() === 'GET') {
                    await this.handleSbsdScriptResponse(response, requestUrl);
                }
            } catch (error) {
                console.error('[NimbusKit] Error in response handler:', error);
            }
        });
    }

    private async handlePrimaryScriptResponse(response: any, requestUrl: string): Promise<void> {
        this.scriptCapture.scriptUrl = requestUrl;

        this.sessionContext = "";
        this.telemetryContext = "";
        this.scriptSrcPromise = new Promise((resolve) => {
            this.resolveScriptSrc = resolve;
        });

        const buffer = await response.body();
        this.scriptCapture.scriptSrc = buffer.toString('utf-8');

        this.resolveScriptSrc!();
    }

    private async handleSbsdScriptResponse(response: any, requestUrl: string): Promise<void> {
        const url = new URL(requestUrl);
        const vParam = url.searchParams.get('v');
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (vParam && uuidRegex.test(vParam)) {
            this.sbsdScriptSrc = requestUrl;

            url.searchParams.delete('v');
            this.scriptCapture.sbsdScriptUrl = url.toString();
            this.scriptCapture.sbsdUuid = vParam;

            const buffer = await response.body();
            this.scriptCapture.sbsdResponseText = buffer.toString('utf-8');
            this.sbsdContext = "";
        }
    }

    private async setupRequestInterceptor(page: Page, context: BrowserContext): Promise<void> {
        await page.route('**/*', async (route) => {
            const request = route.request();
            if (!('akamai-bm-telemetry' in request.headers())) {
                return route.fallback();
            }

            try {
                await this.handleTelemetryRequest(route, page, context);
            } catch (error) {
                console.error('[NimbusKit] Error in header interceptor:', error);
                return route.fallback();
            }
        });

        const payloadPathRegex = /^https?:\/\/[^\/]+\/[a-zA-Z\d\/\-_]+$/i;

        await page.route(payloadPathRegex, async (route) => {
            const request = route.request();
            const requestUrl = request.url();

            try {
                if (this.shouldInterceptPayloadRequest(requestUrl, request.method())) {
                    await this.handlePayloadRequest(route, page, context);
                    return;
                }

                return route.fallback();
            } catch (error) {
                console.error('[NimbusKit] Error in payload interceptor:', error);
                return route.fallback();
            }
        });

        await page.route(url => {
            return url.toString().startsWith(this.scriptCapture.sbsdScriptUrl);
        }, async (route) => {
            const request = route.request();
            const requestUrl = request.url();

            try {
                if (this.shouldInterceptSbsdRequest(requestUrl, request.method())) {
                    await this.handleSbsdRequest(route, page, context);
                    return;
                }

                return route.fallback();
            } catch (error) {
                console.error('[NimbusKit] Error in secondary interceptor:', error);
                return route.fallback();
            }
        });

        const pixelEndpointRegex = /\/akam\/\d+\/pixel_[a-f\d]+$/i;

        await page.route(pixelEndpointRegex, async (route) => {
            const request = route.request();

            try {
                if (request.method() === 'POST') {
                    await route.fulfill({
                        status: 200,
                        contentType: 'text/html'
                    });
                    return;
                }

                return route.fallback();
            } catch (error) {
                console.error('[NimbusKit] Error in pixel interceptor:', error);
                return route.fallback();
            }
        });
    }

    private shouldInterceptPayloadRequest(requestUrl: string, method: string): boolean {
        return this.scriptCapture.scriptUrl !== null &&
            requestUrl === this.scriptCapture.scriptUrl &&
            method === 'POST';
    }

    private shouldInterceptSbsdRequest(requestUrl: string, method: string): boolean {
        return this.scriptCapture.sbsdScriptUrl !== null &&
            requestUrl === this.scriptCapture.sbsdScriptUrl &&
            method === 'POST';
    }

    private async handlePayloadRequest(route: Route, page: Page, context: BrowserContext): Promise<void> {
        const release = await this.payloadMutex.acquire();
        try {
            await this.scriptSrcPromise;

            const cookies = await context.cookies();
            const abck = cookies.find(c => c.name === '_abck')?.value;
            const bmsz = cookies.find(c => c.name === 'bm_sz')?.value;

            if (!abck || !bmsz || !this.scriptCapture.scriptSrc) {
                console.warn('[NimbusKit] Missing session material, continuing original request');
                return route.continue();
            }

            if (!this.userAgent) {
                this.userAgent = await page.evaluate(() => navigator.userAgent);
            }

            const result = await generateSensorData(this.session, new SensorInput(
                abck,
                bmsz,
                "3",
                page.url(),
                this.userAgent,
                this.ipAddress,
                this.acceptLanguage,
                this.sessionContext,
                this.sessionContext == "" ? this.scriptCapture.scriptSrc : "",
                this.scriptCapture.scriptUrl
            ));

            this.sessionContext = result.context;

            const modifiedData = JSON.stringify({
                sensor_data: result.payload
            });

            await route.continue({
                postData: modifiedData
            });
        } finally {
            release();
        }
    }

    private async handleTelemetryRequest(route: Route, page: Page, context: BrowserContext): Promise<void> {
        const release = await this.telemetryMutex.acquire();
        try {
            await this.scriptSrcPromise;

            const cookies = await context.cookies();
            const abck = cookies.find(c => c.name === '_abck')?.value;
            const bmsz = cookies.find(c => c.name === 'bm_sz')?.value;

            if (!abck || !bmsz || !this.scriptCapture.scriptSrc) {
                console.warn('[NimbusKit] Missing session material, continuing original request');
                return route.fallback();
            }

            if (!this.userAgent) {
                this.userAgent = await page.evaluate(() => navigator.userAgent);
            }

            const headers = route.request().headers();
            const j = headers['akamai-bm-telemetry'].split('&&&').find(p => p.startsWith('j='))?.slice(2) ?? "";

            const result = await generateTelemetry(this.session, new TelemetryInput(
                abck,
                bmsz,
                page.url(),
                this.userAgent,
                this.ipAddress,
                this.acceptLanguage,
                this.telemetryContext,
                this.telemetryContext == "" ? this.scriptCapture.scriptSrc : "",
                this.scriptCapture.scriptUrl,
                j
            ));

            this.telemetryContext = result.context;

            await route.fallback({
                headers: {...headers, 'akamai-bm-telemetry': result.header}
            });
        } finally {
            release();
        }
    }

    private async handleSbsdRequest(route: any, page: Page, context: BrowserContext): Promise<void> {
        const release = await this.sbsdMutex.acquire();
        try {
            const cookies = await context.cookies();
            const bmso = cookies.find(c => c.name === "sbsd_o" || c.name === 'bm_so')?.value;

            if (!bmso || !this.scriptCapture.sbsdResponseText || !this.scriptCapture.sbsdUuid) {
                console.warn('[NimbusKit] Missing session material, continuing original request');
                return route.continue();
            }

            if (!this.userAgent) {
                this.userAgent = await page.evaluate(() => navigator.userAgent);
            }

            const requestUrl = new URL(route.request().url());
            const hasTimeParameter = requestUrl.searchParams.has('t');

            if (hasTimeParameter) {
                this.sbsdContext = "";
            }

            const result = await generateSbsdPayload(this.session, new SbsdInput(
                this.scriptCapture.sbsdUuid,
                bmso,
                page.url(),
                this.userAgent,
                this.sbsdContext == "" ? this.scriptCapture.sbsdResponseText : "",
                this.ipAddress,
                this.acceptLanguage,
                this.sbsdContext,
                this.sbsdScriptSrc ?? ""
            ));

            this.sbsdContext = result.context;

            const modifiedData = JSON.stringify({
                body: result.payload
            });

            await route.continue({
                postData: modifiedData
            });
        } finally {
            release();
        }
    }

    public getStatus(): NimbusKitCapture & { sessionContext: string; sbsdContext: string; telemetryContext: string } {
        return {
            ...this.scriptCapture,
            sessionContext: this.sessionContext,
            sbsdContext: this.sbsdContext,
            telemetryContext: this.telemetryContext
        };
    }

    public reset(): void {
        this.scriptCapture = {
            scriptUrl: null,
            scriptSrc: null,
            sbsdScriptUrl: null,
            sbsdResponseText: null,
            sbsdUuid: null
        };
        this.sessionContext = "";
        this.sbsdContext = "";
        this.telemetryContext = "";
        this.sbsdScriptSrc = null;

        this.scriptSrcPromise = new Promise((resolve) => {
            this.resolveScriptSrc = resolve;
        });
    }
}
