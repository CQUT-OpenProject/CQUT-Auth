import { Inject, Injectable } from "@nestjs/common";
import { wrapper } from "axios-cookiejar-support";
import axios from "axios";
import { CookieJar } from "tough-cookie";
import { AppConfigService } from "../../config/app-config.service.js";
import type { VerificationIdentity } from "../../common/types.js";
import type { CampusVerifierProvider, VerifyCredentialsInput } from "../provider.types.js";
import { getSecretParam } from "./cqut.crypto.js";
import { ApiError } from "../../common/api-error.js";
import { RetryableProviderError } from "../provider.errors.js";

@Injectable()
export class CqutProvider implements CampusVerifierProvider {
  readonly name = "cqut";

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async verifyCredentials(input: VerifyCredentialsInput): Promise<VerificationIdentity> {
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error("campus verification exceeded total timeout"));
    }, this.config.providerTotalTimeoutMs);

    try {
      const jar = new CookieJar();
      const client = wrapper(
        axios.create({
          jar,
          signal: abortController.signal,
          withCredentials: true,
          maxRedirects: 10,
          timeout: this.config.providerTimeoutMs,
          validateStatus: () => true
        })
      );

      const serviceUrl = "http://202.202.145.132:80/";

      const delegated = await client.get("https://sid.cqut.edu.cn/cas/clientredirect", {
        params: {
          client_name: "adapter",
          service: serviceUrl
        },
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN",
          "User-Agent": "CQUT-Auth-Service/1.0",
          Referer: serviceUrl
        }
      });
      if (delegated.status >= 500) {
        throw new RetryableProviderError("delegated service is unavailable");
      }
      const finalUrl = String(delegated.request?.res?.responseUrl ?? delegated.config.url ?? "");
      const serviceWithDelegatedClientId = new URL(finalUrl).searchParams.get("service");
      if (!serviceWithDelegatedClientId) {
        throw new ApiError("verification_failed", "failed to obtain delegated service");
      }

      const loginResponse = await client.post(
        "https://uis.cqut.edu.cn/center-auth-server/sso/doLogin",
        {
          loginType: "login",
          name: input.account,
          pwd: getSecretParam(input.password),
          universityId: "100005",
          verifyCode: null
        },
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
        throw new ApiError("verification_failed", "campus credentials rejected");
      }

      const casResponse = await client.get(
        "https://uis.cqut.edu.cn/center-auth-server/vbZl4061/cas/login",
        {
          params: { service: serviceWithDelegatedClientId },
          headers: { Referer: finalUrl }
        }
      );
      if (casResponse.status >= 500) {
        throw new RetryableProviderError("campus cas service is unavailable");
      }

      const uiCookies = jar.getCookiesSync("https://uis.cqut.edu.cn").map((cookie) => cookie.key);
      const sidCookies = jar.getCookiesSync("https://sid.cqut.edu.cn").map((cookie) => cookie.key);
      const hasTgc = uiCookies.includes("SOURCEID_TGC") || sidCookies.includes("SOURCEID_TGC");
      const postLoginUrl = String(casResponse.request?.res?.responseUrl ?? casResponse.config.url ?? "");
      const redirectedBack = postLoginUrl.includes("ticket=");
      const portalSuccess = postLoginUrl.includes("/eportal/success.jsp");
      if (!hasTgc && !redirectedBack && !portalSuccess) {
        throw new ApiError("verification_failed", "cas session was not established");
      }

      return {
        schoolUid: input.account,
        verified: true,
        studentStatus: "active_student",
        school: this.config.schoolCode,
        identityHash: `cqut:${input.account}`
      };
    } catch (error) {
      if (error instanceof RetryableProviderError) {
        throw error;
      }
      if (error instanceof ApiError) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        if (timedOut) {
          throw new RetryableProviderError("campus verification exceeded total timeout");
        }
        if (error.code === "ERR_CANCELED") {
          throw new RetryableProviderError("campus upstream request timed out");
        }
        if (error.code === "ECONNABORTED" || !error.response) {
          throw new RetryableProviderError("campus upstream request timed out");
        }
      }
      const message = error instanceof Error ? error.message : "unknown upstream failure";
      throw new ApiError("verification_failed", message);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
