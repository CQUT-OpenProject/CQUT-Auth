import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import type { CampusVerifierProvider, VerificationIdentity, VerifyCredentialsInput } from "../types.js";
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

export class CqutCampusVerifierProvider implements CampusVerifierProvider {
  readonly name = "cqut";

  constructor(private readonly options: CqutProviderOptions) {}

  async verifyCredentials(input: VerifyCredentialsInput): Promise<VerificationIdentity> {
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error("campus verification exceeded total timeout"));
    }, this.options.providerTotalTimeoutMs);

    try {
      const jar = new CookieJar();
      const client = wrapper(
        axios.create({
          jar,
          signal: abortController.signal,
          withCredentials: true,
          maxRedirects: 10,
          timeout: this.options.providerTimeoutMs,
          validateStatus: () => true
        })
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
        verifyCode: null
      };
      const delegatedHeaders = {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN",
        "User-Agent": "CQUT-Auth-Service/1.0",
        Referer: serviceUrl
      };
      const delegated = await client.get(`${uisBaseUrl}/center-auth-server/${casApplicationCode}/cas/login`, {
        params: {
          service: casServiceUrl,
          applicationCode: casApplicationCode
        },
        headers: delegatedHeaders
      });
      const optimisticLoginPromise = client
        .post(`${uisBaseUrl}/center-auth-server/sso/doLogin`, loginPayload, {
          headers: {
            "Content-Type": "application/json, application/json;charset=UTF-8",
            Referer: serviceUrl
          }
        })
        .then((response) => ({ response }))
        .catch((error: unknown) => ({ error }));

      if (delegated.status >= 500) {
        throw new RetryableProviderError("delegated service is unavailable");
      }
      const finalUrl = String(delegated.request?.res?.responseUrl ?? delegated.config.url ?? "");
      const serviceWithDelegatedClientId = new URL(finalUrl).searchParams.get("service") ?? casServiceUrl;
      if (!serviceWithDelegatedClientId) {
        throw new IdentityCoreError("verification_failed", "failed to obtain delegated service");
      }
      const casLoginUrl = resolveCasLoginUrl(uisBaseUrl, finalUrl, casApplicationCode);

      // Execute credential verification against UIS, then continue CAS login with
      // the delegated service derived from the same UIS flow.
      const optimisticLoginResult = await optimisticLoginPromise;
      const optimisticLoginResponse =
        "response" in optimisticLoginResult ? optimisticLoginResult.response : undefined;
      const loginResponse =
        optimisticLoginResponse && optimisticLoginResponse.status < 400 && optimisticLoginResponse.data?.code === 200
          ? optimisticLoginResponse
          : await client.post(
              `${uisBaseUrl}/center-auth-server/sso/doLogin`,
              loginPayload,
              {
                headers: {
                  "Content-Type": "application/json, application/json;charset=UTF-8",
                  Referer: finalUrl
                }
              }
            );
      if (loginResponse.status >= 500) {
        throw new RetryableProviderError("campus login service is unavailable");
      }
      if (loginResponse.status >= 400 || loginResponse.data?.code !== 200) {
        throw new IdentityCoreError("verification_failed", "campus credentials rejected");
      }

      const casResponse = await client.get(casLoginUrl, {
        params: { service: serviceWithDelegatedClientId },
        headers: { Referer: finalUrl }
      });
      if (casResponse.status >= 500) {
        throw new RetryableProviderError("campus cas service is unavailable");
      }

      const uiCookies = jar.getCookiesSync(uisBaseUrl).map((cookie) => cookie.key);
      const hasTgc = uiCookies.includes("SOURCEID_TGC");
      const postLoginUrl = String(casResponse.request?.res?.responseUrl ?? casResponse.config.url ?? "");
      const redirectedBack = postLoginUrl.includes("ticket=");
      const portalSuccess = postLoginUrl.includes("/eportal/success.jsp");
      if (!hasTgc && !redirectedBack && !portalSuccess) {
        throw new IdentityCoreError("verification_failed", "cas session was not established");
      }

      return {
        schoolUid: input.account,
        verified: true,
        studentStatus: "active_student",
        school: this.options.schoolCode,
        identityHash: `cqut:${input.account}`
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
          throw new RetryableProviderError("campus verification exceeded total timeout");
        }
        if (error.code === "ERR_CANCELED" || error.code === "ECONNABORTED" || !error.response) {
          const target =
            typeof error.config?.url === "string" && error.config.url.trim() ? error.config.url : "campus upstream";
          const reason = error.code ? ` (${error.code})` : "";
          throw new RetryableProviderError(`campus upstream request timed out: ${target}${reason}`);
        }
      }
      const message = error instanceof Error ? error.message : "unknown upstream failure";
      throw new IdentityCoreError("verification_failed", message);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveCasLoginUrl(uisBaseUrl: string, finalUrl: string, fallbackApplicationCode: string): string {
  try {
    const parsed = new URL(finalUrl);
    const match = parsed.pathname.match(/^\/center-auth-server\/([^/]+)\/cas\/login$/);
    if (match?.[1]) {
      return `${uisBaseUrl}/center-auth-server/${match[1]}/cas/login`;
    }
  } catch {
    // noop; use fallback
  }
  return `${uisBaseUrl}/center-auth-server/${fallbackApplicationCode}/cas/login`;
}
