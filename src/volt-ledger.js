import { generateKasadaPayload, KasadaPayloadInput } from "hyper-sdk-js";
export class VoltLedger {
    constructor(config) {
        this.scriptCapture = {
            ipsScriptUrl: null,
            ipsResponseText: null,
            tlEndpointUrl: null
        };
        this.resolveIpsScript = null;
        this.session = config.session;
        this.ipAddress = config.ipAddress;
        this.userAgent = config.userAgent || '';
        this.acceptLanguage = config.acceptLanguage || 'en-US,en;q=0.9';
        this.ipsScriptPromise = new Promise((resolve) => {
            this.resolveIpsScript = resolve;
        });
    }
    async initialize(page, context) {
        await this.setupResponseHandler(page);
        await this.setupRequestInterceptors(page, context);
    }
    async setupResponseHandler(page) {
        page.on('response', async (response) => {
            const request = response.request();
            const requestUrl = request.url();
            try {
                if (request.method() === 'GET') {
                    await this.handleIpsScriptResponse(response, requestUrl);
                }
            }
            catch (error) {
                console.error('[VoltLedger] Error in response handler:', error);
            }
        });
    }
    async handleIpsScriptResponse(response, requestUrl) {
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
    async setupRequestInterceptors(page, context) {
        await page.route("https://reporting.cdndex.io/error", async (route) => {
            const request = route.request();
            try {
                if (request.method() === 'POST') {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ "": "" })
                    });
                    return;
                }
                return route.continue();
            }
            catch (error) {
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
            }
            catch (error) {
                console.error('[VoltLedger] Error in endpoint interceptor:', error);
                return route.continue();
            }
        });
    }
    shouldInterceptTlRequest(requestUrl, method) {
        const tlEndpointPattern = /149e9513-01fa-4fb0-aad4-566afd725d1b\/2d206a39-8ed7-437e-a3be-862e0f06eea3\/tl$/;
        return tlEndpointPattern.test(requestUrl) && method === 'POST';
    }
    async handleTlRequest(route, page, context) {
        await this.ipsScriptPromise;
        if (!this.scriptCapture.ipsResponseText) {
            console.warn('[VoltLedger] Missing script material, continuing original request');
            return route.continue();
        }
        if (!this.userAgent) {
            this.userAgent = await page.evaluate(() => navigator.userAgent);
        }
        const result = await generateKasadaPayload(this.session, new KasadaPayloadInput(this.userAgent, this.scriptCapture.ipsScriptUrl, this.scriptCapture.ipsResponseText, this.ipAddress, this.acceptLanguage));
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
    getStatus() {
        return { ...this.scriptCapture };
    }
    reset() {
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
