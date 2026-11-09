import { generateReese84Sensor, Reese84Input, generateUtmvcCookie, UtmvcInput } from 'hyper-sdk-js';
export class HarborMint {
    constructor(config) {
        this.scriptCapture = {
            interceptedPaths: [],
            detectedScripts: new Map()
        };
        this.scriptPathToScriptUrl = new Map();
        this.scriptPathToScriptContent = new Map();
        this.seenScriptPaths = new Set();
        this.session = config.session;
        this.ipAddress = config.ipAddress;
        this.userAgent = config.userAgent || '';
        this.acceptLanguage = config.acceptLanguage || 'en-US,en;q=0.9';
    }
    async initialize(page, context) {
        await this.setupScriptDetector(page, context);
        await this.setupRequestInterceptor(page, context);
    }
    async setupScriptDetector(page, context) {
        page.on('response', async (response) => {
            try {
                const url = response.url();
                const method = response.request().method();
                if (method !== 'GET')
                    return;
                const headers = response.headers();
                const xCdn = headers['x-cdn'];
                const contentType = headers['content-type'];
                if (!xCdn || xCdn.toLowerCase() !== 'imperva')
                    return;
                if (!contentType || !contentType.toLowerCase().includes('javascript'))
                    return;
                const body = await response.text();
                if (!body.includes('var reese84'))
                    return;
                const urlObj = new URL(url);
                const scriptPath = urlObj.pathname;
                this.seenScriptPaths.add(scriptPath);
                this.scriptPathToScriptUrl.set(scriptPath, url);
                this.scriptPathToScriptContent.set(scriptPath, body);
                this.scriptCapture.detectedScripts.set(scriptPath, url);
            }
            catch (error) {
                console.error('[HarborMint] Error in script detector:', error);
            }
        });
    }
    async setupRequestInterceptor(page, context) {
        await page.route(/.*\/_Incapsula_Resource\?SWJIYLWA=.*/, async (route) => {
            const request = route.request();
            try {
                const response = await route.fetch();
                const responseBody = await response.text();
                if (!this.userAgent) {
                    this.userAgent = await page.evaluate(() => navigator.userAgent);
                }
                const allCookies = await context.cookies();
                const incapCookies = allCookies.filter(cookie => cookie.name.startsWith('incap_ses_'));
                const sessionIds = incapCookies.map(cookie => cookie.value);
                const result = await generateUtmvcCookie(this.session, new UtmvcInput(this.userAgent, responseBody, sessionIds));
                this.utmvc = result.payload;
                await page.evaluate(`
    (function(utmvcValue) {
        const originalCookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        let intercepted = false;

        Object.defineProperty(document, 'cookie', {
            set: function(value) {
                if (!intercepted && value.includes('___utmvc=')) {
                    const modifiedValue = value.replace(/___utmvc=([^;]+)/, \`___utmvc=\${utmvcValue}\`);
                    originalCookieDescriptor.set.call(this, modifiedValue);
                    intercepted = true;
                    Object.defineProperty(document, 'cookie', originalCookieDescriptor);
                } else {
                    originalCookieDescriptor.set.call(this, value);
                }
            },
            get: originalCookieDescriptor.get
        });
    })("${this.utmvc}");
`);
                await route.continue();
            }
            catch (error) {
                console.error('[HarborMint] Error intercepting session resource:', error);
                await route.continue();
            }
        });
        await page.route(/.*\?.*d=.*/, async (route) => {
            const request = route.request();
            const requestUrl = request.url();
            try {
                const matchingScriptPath = this.findMatchingScriptPath(requestUrl);
                if (matchingScriptPath && this.shouldInterceptRequest(requestUrl, request.method(), matchingScriptPath)) {
                    await this.handlePayloadRequest(route, page, context, matchingScriptPath, requestUrl);
                    return;
                }
                return route.continue();
            }
            catch (error) {
                console.error('[HarborMint] Error in request interceptor:', error);
                return route.continue();
            }
        });
    }
    findMatchingScriptPath(requestUrl) {
        try {
            const url = new URL(requestUrl);
            const pathname = url.pathname;
            for (const scriptPath of this.seenScriptPaths) {
                if (pathname.startsWith(scriptPath)) {
                    return scriptPath;
                }
            }
            return null;
        }
        catch (error) {
            console.error('[HarborMint] Error parsing URL for path matching:', error);
            return null;
        }
    }
    shouldInterceptRequest(requestUrl, method, scriptPath) {
        return method === 'POST' && requestUrl.includes(scriptPath);
    }
    async handlePayloadRequest(route, page, context, scriptPath, requestUrl) {
        const postData = route.request().postData();
        if (postData && postData.startsWith('"')) {
            return route.continue();
        }
        if (!this.scriptCapture.interceptedPaths.includes(scriptPath)) {
            this.scriptCapture.interceptedPaths.push(scriptPath);
        }
        if (!this.userAgent) {
            this.userAgent = await page.evaluate(() => navigator.userAgent);
        }
        const result = await generateReese84Sensor(this.session, new Reese84Input(this.userAgent, this.ipAddress, this.acceptLanguage, page.url(), "", this.scriptPathToScriptContent.get(scriptPath) || "", this.scriptPathToScriptUrl.get(scriptPath) || ""));
        await route.continue({
            postData: result.payload
        });
    }
    getStatus() {
        return {
            ...this.scriptCapture,
            scriptUrls: new Map(this.scriptPathToScriptUrl)
        };
    }
    reset() {
        this.scriptCapture = {
            interceptedPaths: [],
            detectedScripts: new Map()
        };
        this.scriptPathToScriptUrl.clear();
        this.scriptPathToScriptContent.clear();
        this.seenScriptPaths.clear();
    }
}
