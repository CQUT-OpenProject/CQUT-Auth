import axios, { type AxiosRequestConfig } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import {
  CasClient,
  CasError,
  type Fetcher,
  type HttpRequest,
  type HttpResponse,
} from "@cqut-openproject/cas-sdk";
import type {
  CampusVerifierProvider,
  VerificationIdentity,
  VerifyCredentialsInput,
} from "../types.js";
import { IdentityCoreError, RetryableProviderError } from "../errors.js";

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
      const normalizedAccount = input.account.trim().toLowerCase();
      const jar = new CookieJar();
      const client = wrapper(
        axios.create({
          jar,
          signal: abortController.signal,
          withCredentials: true,
          timeout: this.options.providerTimeoutMs,
          validateStatus: () => true,
        }),
      );

      const fetcher: Fetcher = async (
        req: HttpRequest,
      ): Promise<HttpResponse> => {
        try {
          const config: AxiosRequestConfig = {
            url: req.url,
            method: req.method ?? "GET",
            maxRedirects: req.redirect === "manual" ? 0 : 10,
            validateStatus: () => true,
            responseType: "text",
          };
          if (req.headers !== undefined) {
            config.headers = req.headers;
          }
          if (req.body !== undefined) {
            config.data = req.body;
          }
          const res = await client.request(config);

          const resUrl = String(
            res.request?.res?.responseUrl ?? res.config.url ?? req.url,
          );

          return {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers as Record<string, string | string[]>,
            url: resUrl,
            text: async () =>
              typeof res.data === "string"
                ? res.data
                : JSON.stringify(res.data),
            json: async () =>
              typeof res.data === "string" ? JSON.parse(res.data) : res.data,
          };
        } catch (error: unknown) {
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
          throw error;
        }
      };

      const casClient = new CasClient({
        uisBaseUrl: this.options.uisBaseUrl,
        applicationCode: this.options.casApplicationCode,
        fetcher,
      });

      // 1 & 2 & 3: Login and obtain ticket
      const loginResult = await casClient.login({
        account: input.account,
        password: input.password,
        serviceUrl: this.options.casServiceUrl,
        signal: abortController.signal,
      });

      // 4: Validate ticket
      let casUser: string;
      try {
        const validation = await casClient.validateServiceTicket(
          loginResult.ticket,
          loginResult.serviceWithClientId,
          { signal: abortController.signal },
        );
        casUser = validation.user;
      } catch (err: unknown) {
        if (err instanceof CasError && err.kind === "UPSTREAM_ERROR") {
          throw new RetryableProviderError(
            "campus cas service ticket validation failed",
          );
        }
        if (err instanceof CasError && err.kind === "VALIDATION_FAILED") {
          if (
            err.message.includes("conflicting") ||
            err.message.includes("empty identifier")
          ) {
            throw new RetryableProviderError(
              "campus cas service ticket validation returned an invalid response",
            );
          }
          throw new RetryableProviderError(
            "campus cas service ticket validation failed",
          );
        }
        throw err;
      }

      if (casUser !== normalizedAccount) {
        throw new IdentityCoreError(
          "verification_failed",
          "campus identity does not match requested account",
        );
      }

      return {
        schoolUid: casUser,
        studentStatus: "active",
        school: this.options.schoolCode,
        identityHash: `cqut:${casUser}`,
      };
    } catch (error) {
      if (
        error instanceof RetryableProviderError ||
        error instanceof IdentityCoreError
      ) {
        throw error;
      }
      if (error instanceof CasError) {
        if (error.kind === "AUTH_FAILED") {
          throw new IdentityCoreError(
            "verification_failed",
            "campus credentials rejected",
          );
        }
        if (error.kind === "PROTOCOL_ERROR") {
          throw new RetryableProviderError(
            "campus cas service ticket was not issued",
          );
        }
        if (error.kind === "UPSTREAM_ERROR") {
          throw new RetryableProviderError("campus cas service is unavailable");
        }
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
