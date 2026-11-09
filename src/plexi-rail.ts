import { Page, BrowserContext } from 'playwright';
import { Session, generateSliderPayload, SliderInput, generateInterstitialPayload, InterstitialInput, generateTagsPayload, TagsInput, parseChallengeScriptUrl } from 'hyper-sdk-js';

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

export class PlexiRail {
    private session: Session;
    private userAgent: string;
    private ipAddress: string;
    private acceptLanguage: string;

    private capture: PlexiRailCapture = {
        puzzleImageUrl: null,
        pieceImageUrl: null,
        puzzleImageBase64: null,
        pieceImageBase64: null,
        gatePageUrl: null,
        deviceCheckLink: null,
        interstitialPageUrl: null,
        interstitialPageText: null,
        auxScriptUrl: null,
        auxScript: null
    };

    private isProcessing: boolean = false;

    private imagesPromise: Promise<void>;
    private resolveImages: (() => void) | null = null;

    private auxScriptPromise: Promise<void>;
    private resolveAuxScript: (() => void) | null = null;

    constructor(config: PlexiRailConfig) {
        this.session = config.session;
        this.ipAddress = config.ipAddress;
        this.userAgent = config.userAgent || '';
        this.acceptLanguage = config.acceptLanguage || 'en-US,en;q=0.9';

        this.imagesPromise = new Promise((resolve) => {
            this.resolveImages = resolve;
        });

        this.auxScriptPromise = new Promise((resolve) => {
            this.resolveAuxScript = resolve;
        });
    }

    public async initialize(page: Page, context: BrowserContext): Promise<void> {
        await this.setupResponseHandler(page);
        await this.setupRequestInterception(page);
    }

    private async setupRequestInterception(page: Page): Promise<void> {
        await page.route('https://geo.captcha-delivery.com/interstitial/', async (route) => {
            const request = route.request();

            if (request.method() === 'POST') {
                if (!this.userAgent) {
                    this.userAgent = await page.evaluate(() => navigator.userAgent);
                }

                const script = await this.auxScriptFor(this.capture.interstitialPageText);

                const interstitialResult = await generateInterstitialPayload(this.session, new InterstitialInput(
                    this.userAgent,
                    this.capture.interstitialPageUrl,
                    this.capture.interstitialPageText,
                    this.ipAddress,
                    this.acceptLanguage,
                    script,
                ));

                if (!interstitialResult) {
                    console.error('[PlexiRail] Failed to generate interstitial payload');
                    return;
                }

                await route.continue({
                    postData: interstitialResult.payload,
                });
            } else {
                await route.continue();
            }
        });

        await page.route(/.*\/js\/?$/, async (route) => {
            const request = route.request();

            if (request.method() === 'POST') {
                const postData = request.postData();

                if (postData && postData.includes('ddk')) {
                    if (!this.userAgent) {
                        this.userAgent = await page.evaluate(() => navigator.userAgent);
                    }

                    const parsedData = new URLSearchParams(postData);
                    const keyValues: { [key: string]: string } = {};

                    for (const [key, value] of parsedData.entries()) {
                        keyValues[key] = value;
                    }

                    const jsType = (keyValues["jsType"] === "ch" || keyValues["jsType"] === "le") ? keyValues["jsType"] : "ch";

                    const tagsResult = await generateTagsPayload(this.session, new TagsInput(
                        this.userAgent,
                        keyValues["ddk"],
                        decodeURIComponent(keyValues["Referer"]),
                        jsType,
                        this.ipAddress,
                        this.acceptLanguage,
                        keyValues["ddv"],
                        keyValues["cid"],
                    ));

                    if (!tagsResult) {
                        console.error('[PlexiRail] Failed to generate tags payload');
                        return;
                    }

                    await route.continue({
                        postData: tagsResult.payload,
                    });
                } else {
                    await route.continue();
                }
            } else {
                await route.continue();
            }
        });
    }

    private async setupResponseHandler(page: Page): Promise<void> {
        page.context().on('response', async (response) => {
            const request = response.request();
            const requestUrl = request.url();

            try {
                if (this.isPuzzleImageRequest(requestUrl)) {
                    await this.handlePuzzleImageResponse(response, requestUrl);
                    return;
                }

                if (this.isPieceImageRequest(requestUrl)) {
                    await this.handlePieceImageResponse(response, requestUrl);
                    return;
                }

                if (this.isGatePageRequest(requestUrl)) {
                    await this.handleGatePageResponse(response, page);
                    return;
                }

                if (this.isAuxScriptRequest(requestUrl)) {
                    await this.handleAuxScriptResponse(response, requestUrl);
                    return;
                }

                if (this.isInterstitialPageRequest(requestUrl)) {
                    await this.handleInterstitialPageResponse(response, page);
                    return;
                }
            } catch (error) {
                console.error('[PlexiRail] Error in response handler:', error);
            }
        });
    }

    private isPuzzleImageRequest(requestUrl: string): boolean {
        return requestUrl.includes('dd.prod.captcha-delivery.com/image/') && requestUrl.includes('.jpg');
    }

    private isPieceImageRequest(requestUrl: string): boolean {
        return requestUrl.includes('dd.prod.captcha-delivery.com/image/') && requestUrl.includes('.frag.png');
    }

    private isGatePageRequest(requestUrl: string): boolean {
        return requestUrl.includes('geo.captcha-delivery.com/captcha/?initialCid=') && requestUrl.includes('?');
    }

    private isInterstitialPageRequest(requestUrl: string): boolean {
        return requestUrl.includes('geo.captcha-delivery.com/interstitial/?initialCid=') && requestUrl.includes('?');
    }

    private isAuxScriptRequest(requestUrl: string): boolean {
        return requestUrl.includes('ct.captcha-delivery.com/') && requestUrl.endsWith('.js');
    }

    private async handleAuxScriptResponse(response: any, requestUrl: string): Promise<void> {
        if (!response.ok()) {
            return;
        }

        this.capture.auxScriptUrl = requestUrl;
        this.capture.auxScript = await response.text();

        this.resolveAuxScript?.();
    }

    private async auxScriptFor(html: string | null): Promise<string | undefined> {
        if (!html || !parseChallengeScriptUrl(html)) {
            return undefined;
        }

        if (!this.capture.auxScript) {
            await Promise.race([
                this.auxScriptPromise,
                new Promise<void>((resolve) => setTimeout(resolve, 10000)),
            ]);
        }

        if (!this.capture.auxScript) {
            console.warn('[PlexiRail] Auxiliary script was not captured in time');
        }

        return this.capture.auxScript ?? undefined;
    }

    private async handlePuzzleImageResponse(response: any, requestUrl: string): Promise<void> {
        this.capture.puzzleImageUrl = requestUrl;

        if (response.ok()) {
            const buffer = await response.body();
            this.capture.puzzleImageBase64 = buffer.toString('base64');

            this.checkIfImagesReady();
        }
    }

    private async handlePieceImageResponse(response: any, requestUrl: string): Promise<void> {
        this.capture.pieceImageUrl = requestUrl;

        if (response.ok()) {
            const buffer = await response.body();
            this.capture.pieceImageBase64 = buffer.toString('base64');

            this.checkIfImagesReady();
        }
    }

    private checkIfImagesReady(): void {
        if (this.capture.puzzleImageBase64 && this.capture.pieceImageBase64) {
            if (this.resolveImages) {
                this.resolveImages();
            }
        }
    }

    private async handleGatePageResponse(response: any, page: Page): Promise<void> {
        if (this.isProcessing) return;

        const responseUrl = response.url();

        if (responseUrl.includes('t=bv')) {
            console.warn('[PlexiRail] Hardblock signal (t=bv) — cannot proceed');
            return;
        }

        try {
            this.isProcessing = true;
            this.capture.gatePageUrl = responseUrl;

            const responseText = await response.text();

            const gateFrame = page.frames().find(frame =>
                frame.url().includes('captcha-delivery.com')
            );

            if (!gateFrame) {
                console.error('[PlexiRail] Could not find gate frame');
                return;
            }

            await page.waitForTimeout(500);

            const noPuzzleMode = await gateFrame.evaluate(() => {
                const ddm = (window as any).ddm;
                return ddm?.noPuzzle === true;
            });

            if (noPuzzleMode) {
                const pathMatch = responseText.match(/captchaChallengePath:\s*['"]([^'"]+)['"]/);

                if (pathMatch && pathMatch[1]) {
                    const puzzlePath = pathMatch[1];

                    const lastDotIndex = puzzlePath.lastIndexOf('.');
                    const extension = lastDotIndex > -1 ? puzzlePath.slice(lastDotIndex) : '';
                    const fragImagePath = puzzlePath.replace(extension, '.frag.png');

                    await gateFrame.evaluate(({ puzzlePath, fragPath }) => {
                        const puzzleImg = new Image();
                        puzzleImg.crossOrigin = 'Anonymous';
                        puzzleImg.src = puzzlePath;

                        const fragImg = new Image();
                        fragImg.crossOrigin = 'Anonymous';
                        fragImg.src = fragPath;
                    }, { puzzlePath, fragPath: fragImagePath });
                } else {
                    console.error('[PlexiRail] noPuzzle mode but could not parse image path');
                    return;
                }
            }

            await this.imagesPromise;

            const gatePage = await this.findGateFramePage(page);
            if (!gatePage) {
                console.error('[PlexiRail] Could not find gate frame page');
                return;
            }

            if (!this.userAgent) {
                this.userAgent = await page.evaluate(() => navigator.userAgent);
            }

            let parentUrl = await gateFrame.evaluate(() =>  (window.location != window.parent.location) ? document.referrer : document.location.href);

            const script = await this.auxScriptFor(responseText);

            const sliderResult = await generateSliderPayload(this.session, new SliderInput(
                this.userAgent,
                this.capture.gatePageUrl,
                responseText,
                this.capture.puzzleImageBase64,
                this.capture.pieceImageBase64,
                parentUrl,
                this.ipAddress,
                this.acceptLanguage,
                script,
            ));

            if (!sliderResult) {
                console.error('[PlexiRail] Failed to generate device check link');
                return;
            }

            this.capture.deviceCheckLink = sliderResult.payload;

            await this.runFrameAction(page, sliderResult.payload);
        } catch (error) {
            console.error('[PlexiRail] Error handling gate page response:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    private async handleInterstitialPageResponse(response: any, page: Page): Promise<void> {
        if (this.isProcessing) return;

        const responseUrl = response.url();

        if (responseUrl.includes('t=bv')) {
            console.warn('[PlexiRail] Hardblock signal (t=bv) — cannot proceed');
            return;
        }

        try {
            this.isProcessing = true;

            this.capture.interstitialPageUrl = responseUrl;
            this.capture.interstitialPageText = await response.text();
        } catch (error) {
            console.error('[PlexiRail] Error handling interstitial page response:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    private async findGateFramePage(page: Page): Promise<Page | null> {
        const pages = page.context().pages();

        for (const currentPage of pages) {
            try {
                const url = currentPage.url();
                if (url.includes('captcha-delivery.com')) {
                    return currentPage;
                }

                const frames = currentPage.frames();
                for (const frame of frames) {
                    if (frame.url().includes('captcha-delivery.com')) {
                        return currentPage;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        return null;
    }

    private async runFrameAction(page: Page, deviceCheckLink: string): Promise<void> {
        try {
            const gateFrame = page.frames().find(frame =>
                frame.url().includes('captcha-delivery.com')
            );

            if (!gateFrame) {
                throw new Error('Could not find gate frame');
            }

            await gateFrame.evaluate((generatedDeviceCheckLink) => {
                const url = new URL(generatedDeviceCheckLink);
                const refererParam = url.searchParams.get('referer');

                var request = new XMLHttpRequest();
                request.open('GET', generatedDeviceCheckLink, true);
                request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");

                request.onload = function() {
                    if (this.status >= 200 && this.status < 400) {
                        var element = document.getElementById('analyticsCaptchaPassed');
                        if (element) {
                            element.setAttribute('data-analytics-captcha-passed', 'true');
                        }

                        var reloadHref = refererParam;

                        if (window.parent && window.parent.postMessage && this.responseText !== undefined) {
                            var json = JSON.parse(this.responseText);
                            if (json.hasOwnProperty('cookie') && json.cookie !== null) {
                                var origin = '*';
                                if (document.referrer) {
                                    var pathArray = document.referrer.split('/');
                                    if (pathArray.length >= 3 && pathArray[1] === '') {
                                        origin = pathArray[0] + '//' + pathArray[2];
                                    } else {
                                        origin = '*';
                                    }

                                    if(origin === document.location.origin) {
                                        origin = '*';
                                    }
                                }

                                window.parent.postMessage(JSON.stringify({'cookie': json.cookie, 'url': reloadHref, 'eventType':'passed', 'responseType': 'captcha'}), origin);
                            }
                        } else {
                            setTimeout(function () {
                                window.top.location.href = reloadHref;
                            }, 7000);
                        }
                    } else {
                        setTimeout(function () {
                            window.location.href = window.location.href;
                        }, 2000);
                    }
                };
                request.send();
            }, deviceCheckLink);

        } catch (error) {
            console.error('[PlexiRail] Error running frame action:', error);
        }
    }

    public getStatus(): PlexiRailCapture & { isProcessing: boolean } {
        return {
            ...this.capture,
            isProcessing: this.isProcessing,
        };
    }

    public reset(): void {
        this.capture = {
            puzzleImageUrl: null,
            pieceImageUrl: null,
            puzzleImageBase64: null,
            pieceImageBase64: null,
            gatePageUrl: null,
            deviceCheckLink: null,
            interstitialPageUrl: null,
            interstitialPageText: null,
            auxScriptUrl: null,
            auxScript: null
        };
        this.isProcessing = false;

        this.imagesPromise = new Promise((resolve) => {
            this.resolveImages = resolve;
        });

        this.auxScriptPromise = new Promise((resolve) => {
            this.resolveAuxScript = resolve;
        });
    }
}
