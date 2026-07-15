import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { setTimeout as sleep } from "node:timers/promises";
import { SaxesParser } from "saxes";
import { CookieJar } from "tough-cookie";
import type {
  CampusVerifierProvider,
  VerificationIdentity,
  VerifyCredentialsInput,
} from "../types.js";
import { IdentityCoreError, RetryableProviderError } from "../errors.js";
import { getSecretParam } from "./cqut.crypto.js";

type CqutProviderOptions = {
  schoolCode: string;
  providerTimeoutMs: number;
  providerTotalTimeoutMs: number;
  uisBaseUrl: string;
  casApplicationCode: string;
  casServiceUrl: string;
};

const CAS_NAMESPACE = "http://www.yale.edu/tp/cas";
const MAX_CAS_VALIDATION_RESPONSE_BYTES = 64 * 1024;

export class CqutCampusVerifierProvider implements CampusVerifierProvider {
  readonly name = "cqut";

  constructor(private readonly options: CqutProviderOptions) {}

  async verifyCredentials(
    input: VerifyCredentialsInput,
  ): Promise<VerificationIdentity> {
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(
        new Error("campus verification exceeded total timeout"),
      );
    }, this.options.providerTotalTimeoutMs);

    try {
      // Campus UIS usernames/student IDs are case-insensitive; normalize before
      // deriving the identity key so casing/whitespace variants map to one subject.
      const normalizedAccount = input.account.trim().toLowerCase();
      const jar = new CookieJar();
      const client = wrapper(
        axios.create({
          jar,
          signal: abortController.signal,
          withCredentials: true,
          maxRedirects: 10,
          timeout: this.options.providerTimeoutMs,
          validateStatus: () => true,
        }),
      );

      const serviceUrl = "http://202.202.145.132:80/";
      const uisBaseUrl = normalizeBaseUrl(this.options.uisBaseUrl);
      const casApplicationCode = this.options.casApplicationCode;
      const casServiceUrl = this.options.casServiceUrl;
      const loginPayload = {
        loginType: "login",
        name: input.account,
        pwd: getSecretParam(input.password),
        universityId: "100005",
        verifyCode: null,
      };
      const delegatedHeaders = {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN",
        "User-Agent": "CQUT-Auth-Service/1.0",
        Referer: serviceUrl,
      };
      const delegated = await getCasLoginWithRetry(client, {
        url: `${uisBaseUrl}/center-auth-server/${casApplicationCode}/cas/login`,
        service: casServiceUrl,
        applicationCode: casApplicationCode,
        headers: delegatedHeaders,
      });

      if (delegated.status >= 500) {
        throw new RetryableProviderError("delegated service is unavailable");
      }
      const finalUrl = String(
        delegated.request?.res?.responseUrl ?? delegated.config.url ?? "",
      );
      const serviceWithDelegatedClientId =
        new URL(finalUrl).searchParams.get("service") ?? casServiceUrl;
      if (!serviceWithDelegatedClientId) {
        throw new IdentityCoreError(
          "verification_failed",
          "failed to obtain delegated service",
        );
      }
      const casLoginUrl = resolveCasLoginUrl(
        uisBaseUrl,
        finalUrl,
        casApplicationCode,
      );

      // Execute credential verification against UIS, then continue CAS login with
      // the delegated service derived from the same UIS flow.
      const loginResponse = await client.post(
        `${uisBaseUrl}/center-auth-server/sso/doLogin`,
        loginPayload,
        {
          headers: {
            "Content-Type": "application/json, application/json;charset=UTF-8",
            Referer: finalUrl,
          },
        },
      );
      if (loginResponse.status >= 500) {
        throw new RetryableProviderError("campus login service is unavailable");
      }
      // Upstream has historically returned the status code as either a number
      // or a numeric string; compare loosely so a `"200"` body is not mistaken
      // for a rejected credential.
      const upstreamCode = Number(loginResponse.data?.code);
      if (loginResponse.status >= 400 || upstreamCode !== 200) {
        throw new IdentityCoreError(
          "verification_failed",
          "campus credentials rejected",
        );
      }

      const casResponse = await getCasLoginWithRetry(client, {
        url: casLoginUrl,
        service: serviceWithDelegatedClientId,
        headers: { Referer: finalUrl },
        maxRedirects: 0,
      });
      if (casResponse.status >= 500) {
        throw new RetryableProviderError("campus cas service is unavailable");
      }

      const location = casResponse.headers["location"];
      let ticket: string | null = null;
      if (
        casResponse.status >= 300 &&
        casResponse.status < 400 &&
        typeof location === "string"
      ) {
        try {
          ticket = new URL(location, casLoginUrl).searchParams.get("ticket");
        } catch {
          // Invalid redirect targets are handled as a missing service ticket.
        }
      }
      if (!ticket?.startsWith("ST-")) {
        throw new RetryableProviderError(
          "campus cas service ticket was not issued",
        );
      }

      const casUser = await validateCasServiceTicket(client, {
        url: `${uisBaseUrl}/center-auth-server/cas/serviceValidate`,
        service: serviceWithDelegatedClientId,
        ticket,
      });
      if (casUser !== normalizedAccount) {
        throw new IdentityCoreError(
          "verification_failed",
          "campus identity does not match requested account",
        );
      }

      return {
        schoolUid: casUser,
        verified: true,
        studentStatus: "active",
        school: this.options.schoolCode,
        identityHash: `cqut:${casUser}`,
      };
    } catch (error) {
      if (error instanceof RetryableProviderError) {
        throw error;
      }
      if (error instanceof IdentityCoreError) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        if (timedOut) {
          throw new RetryableProviderError(
            "campus verification exceeded total timeout",
          );
        }
        if (isRetryableAxiosNetworkError(error)) {
          const target =
            typeof error.config?.url === "string" && error.config.url.trim()
              ? error.config.url
              : "campus upstream";
          const reason = error.code ? ` (${error.code})` : "";
          throw new RetryableProviderError(
            `campus upstream request timed out: ${target}${reason}`,
          );
        }
      }
      const message =
        error instanceof Error ? error.message : "unknown upstream failure";
      throw new IdentityCoreError("verification_failed", message);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

async function getCasLoginWithRetry(
  client: AxiosInstance,
  options: {
    url: string;
    service: string;
    applicationCode?: string;
    headers: Record<string, string>;
    maxRedirects?: number;
  },
): Promise<AxiosResponse> {
  let lastError: unknown;
  const params: Record<string, string> = { service: options.service };
  if (options.applicationCode) {
    params["applicationCode"] = options.applicationCode;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await client.get(options.url, {
        params,
        headers: options.headers,
        ...(options.maxRedirects === undefined
          ? {}
          : { maxRedirects: options.maxRedirects }),
      });
      if (response.status < 500 || attempt === 2) {
        return response;
      }
      lastError = new RetryableProviderError(
        "campus cas login returned retryable status",
      );
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isRetryableAxiosNetworkError(error)) {
        throw error;
      }
    }
    await sleep(250);
  }

  throw lastError instanceof Error
    ? lastError
    : new RetryableProviderError("campus cas login failed");
}

async function validateCasServiceTicket(
  client: AxiosInstance,
  options: { url: string; service: string; ticket: string },
): Promise<string> {
  const response = await client.get(options.url, {
    params: { service: options.service, ticket: options.ticket },
    headers: { Accept: "application/xml" },
    maxRedirects: 0,
    maxContentLength: MAX_CAS_VALIDATION_RESPONSE_BYTES,
    responseType: "text",
  });
  if (response.status !== 200 || typeof response.data !== "string") {
    throw new RetryableProviderError(
      "campus cas service ticket validation failed",
    );
  }

  try {
    return parseCasValidationResponse(response.data);
  } catch {
    throw new RetryableProviderError(
      "campus cas service ticket validation returned an invalid response",
    );
  }
}

function parseCasValidationResponse(xml: string): string {
  if (Buffer.byteLength(xml, "utf8") > MAX_CAS_VALIDATION_RESPONSE_BYTES) {
    throw new Error("CAS response is too large");
  }

  const stack: Array<{ local: string; uri: string; text: string }> = [];
  const users: string[] = [];
  const uids: string[] = [];
  const userCodes: string[] = [];
  let serviceResponses = 0;
  let successes = 0;
  let failures = 0;
  const parser = new SaxesParser({ xmlns: true });

  parser.on("doctype", () => {
    throw new Error("CAS response must not contain a doctype");
  });
  parser.on("opentag", (tag) => {
    stack.push({ local: tag.local, uri: tag.uri, text: "" });
    if (!stack.every((entry) => entry.uri === CAS_NAMESPACE)) {
      return;
    }
    const path = stack.map((entry) => entry.local).join("/");
    if (path === "serviceResponse") serviceResponses += 1;
    if (path === "serviceResponse/authenticationSuccess") successes += 1;
    if (path === "serviceResponse/authenticationFailure") failures += 1;
  });
  const appendText = (text: string) => {
    const current = stack.at(-1);
    if (current) current.text += text;
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("closetag", () => {
    const path = stack.map((entry) => entry.local).join("/");
    const isCasPath = stack.every((entry) => entry.uri === CAS_NAMESPACE);
    const current = stack.pop();
    if (!current || !isCasPath) return;
    if (path === "serviceResponse/authenticationSuccess/user") {
      users.push(current.text);
    } else if (path === "serviceResponse/authenticationSuccess/uid") {
      uids.push(current.text);
    } else if (
      path === "serviceResponse/authenticationSuccess/attributes/user_code"
    ) {
      userCodes.push(current.text);
    }
  });
  parser.write(xml).close();

  if (
    serviceResponses !== 1 ||
    successes !== 1 ||
    failures !== 0 ||
    users.length !== 1 ||
    uids.length > 1 ||
    userCodes.length > 1
  ) {
    throw new Error("CAS response has an invalid authentication result");
  }

  const user = normalizeCasIdentifier(users[0]);
  for (const identifier of [...uids, ...userCodes]) {
    if (normalizeCasIdentifier(identifier) !== user) {
      throw new Error("CAS response contains conflicting identifiers");
    }
  }
  return user;
}

function normalizeCasIdentifier(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    throw new Error("CAS response contains an empty identifier");
  }
  return normalized;
}

function isRetryableAxiosNetworkError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  return (
    error.code === "ERR_CANCELED" ||
    error.code === "ECONNABORTED" ||
    !error.response
  );
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveCasLoginUrl(
  uisBaseUrl: string,
  finalUrl: string,
  fallbackApplicationCode: string,
): string {
  try {
    const parsed = new URL(finalUrl);
    const match = parsed.pathname.match(
      /^\/center-auth-server\/([^/]+)\/cas\/login$/,
    );
    if (match?.[1]) {
      return `${uisBaseUrl}/center-auth-server/${match[1]}/cas/login`;
    }
  } catch {
    // noop; use fallback
  }
  return `${uisBaseUrl}/center-auth-server/${fallbackApplicationCode}/cas/login`;
}
