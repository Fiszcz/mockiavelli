import dbg from 'debug';
import {
    MatchedRequest,
    MockedResponse,
    MockOptions,
    ParsedFilterRequest,
    PathParameters,
    QueryObject,
    ReceivedRequest,
    MockedResponseObject,
    RequestMatcherObject,
} from './types';
import {
    waitFor,
    TimeoutError,
    nth,
    arePathsDifferent,
    getCorsHeaders,
    sanitizeHeaders,
    requestToPlainObject,
    getRequestOrigin,
} from './utils';
import isEqual from 'lodash.isequal';
import { parse } from 'url';
import { stringify } from 'querystring';
import pathToRegexp, { Key } from 'path-to-regexp';
import { Request } from 'puppeteer';

const debug = dbg('mocketeer:rest');

const GET_REQUEST_TIMEOUT = 100;

let debugId = 1;

export class Mock {
    private filter: ParsedFilterRequest;
    private response: MockedResponse;
    private requests: Array<MatchedRequest> = [];
    private debugId = debugId++;

    public options: MockOptions = {
        priority: 0,
        once: false,
    };
    private paramNames: (string | number)[] = [];

    constructor(
        filter: RequestMatcherObject,
        response: MockedResponse,
        options: Partial<MockOptions> = {}
    ) {
        this.filter = this.createParsedFilterRequest(filter);
        this.response = response;
        this.options = { ...this.options, ...options };
        this.debug(
            '+',
            `created mock: method=${filter.method} url=${filter.url}`
        );
    }

    private debug(symbol: string, message: string): void {
        debug(`${symbol} (${this.debugId}) ${message} `);
    }

    private debugMiss(
        reason: string,
        requestValue: string,
        filterValue: string
    ) {
        this.debug(
            `·`,
            `${reason} not matched: mock=${filterValue} req=${requestValue} `
        );
    }

    public async getRequest(index: number = 0): Promise<MatchedRequest> {
        try {
            await waitFor(
                () => Boolean(this.requests[index]),
                GET_REQUEST_TIMEOUT
            );
        } catch (e) {
            if (e instanceof TimeoutError) {
                if (this.requests.length === 0 && index === 0) {
                    throw new Error(
                        `No request matching mock [${this.prettyPrint()}] found`
                    );
                } else {
                    throw new Error(
                        `${nth(
                            index + 1
                        )} request matching mock [${this.prettyPrint()}] was not found`
                    );
                }
            }
            throw e;
        }
        return this.requests[index];
    }

    public getResponseForRequest(
        request: Request
    ): MockedResponseObject | null {
        if (this.options.once && this.requests.length > 0) {
            this.debug('once', 'Request already matched');
            return null;
        }

        const serializedRequest = requestToPlainObject(request);
        const pageOrigin = getRequestOrigin(request);

        if (!this.isMatchingRequest(serializedRequest, pageOrigin)) {
            return null;
        }

        this.requests.push({
            ...serializedRequest,
            params: this.getParams(serializedRequest),
        });

        const response =
            typeof this.response === 'function'
                ? this.response(serializedRequest)
                : this.response;

        const status = response.status || 200;

        // Set default value of Content-Type header
        const headers = sanitizeHeaders({
            ['content-type']: `'application/json';charset=UTF-8`,
            ...getCorsHeaders(request),
            ...response.headers,
        });

        // Serialize JSON response
        const body =
            typeof response.body !== 'string'
                ? JSON.stringify(response.body)
                : response.body;

        return { status, headers, body };
    }

    private isMatchingRequest(
        request: ReceivedRequest,
        pageOrigin: string
    ): boolean {
        if (this.filter.method && request.method !== this.filter.method) {
            this.debugMiss('method', request.method, this.filter.method);
            return false;
        }

        const filterRequestOrigin = this.filter.hostname || pageOrigin;

        if (filterRequestOrigin !== request.hostname) {
            this.debugMiss(
                'url',
                request.hostname || `Request origin missing`,
                filterRequestOrigin || `Filter origin missing`
            );
            return false;
        }

        if (arePathsDifferent(request.path, this.filter.pathRegex)) {
            this.debugMiss(
                'url',
                request.path || `Request path missing`,
                this.filter.path || `Filter path missing`
            );
            return false;
        }

        if (!this.requestParamsMatch(request.query, this.filter.query)) {
            this.debugMiss(
                'query',
                JSON.stringify(request.query),
                JSON.stringify(this.filter.query)
            );
            return false;
        }

        this.debug('=', `matched mock`);

        return true;
    }

    private createParsedFilterRequest(
        filter: RequestMatcherObject
    ): ParsedFilterRequest {
        // TODO find a better alternative for url.parse
        const { protocol, host, pathname, query } = parse(filter.url, true);
        const hasHostname = protocol && host;
        const keys: Key[] = [];
        const pathRegex = pathname ? pathToRegexp(pathname, keys) : undefined;
        this.paramNames = keys.map((key: Key) => key.name);

        const pathParams: PathParameters = {};
        this.paramNames.forEach(
            (param: string | number) => (pathParams[param] = '')
        );

        return {
            method: filter.method,
            hostname: hasHostname ? `${protocol}//${host}` : undefined,
            query: filter.query ? filter.query : query,
            path: pathname,
            pathParams,
            pathRegex,
        };
    }

    private requestParamsMatch(
        requestQuery: QueryObject,
        filterQuery: QueryObject
    ): boolean {
        return Object.keys(filterQuery).every((key: string) => {
            return (
                key in requestQuery &&
                isEqual(filterQuery[key], requestQuery[key])
            );
        });
    }

    private prettyPrint(): string {
        const qs = stringify(this.filter.query);
        return `(${this.debugId}) ${this.filter.method} ${this.filter.path +
            (qs ? '?' + qs : '')}`;
    }

    private getParams(request: ReceivedRequest): PathParameters {
        if (!this.filter.pathRegex || !this.filter.path) {
            return {};
        }

        const matchedRegexp =
            request.path && this.filter.pathRegex.exec(request.path);
        const matchedParams = matchedRegexp ? matchedRegexp.slice(1) : [];

        return matchedParams.reduce(
            (pathParams: PathParameters, param: string, index: number) => ({
                ...pathParams,
                [this.paramNames[index]]: param,
            }),
            {}
        );
    }
}
