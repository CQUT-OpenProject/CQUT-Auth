export type DemoUserInfo = Record<string, unknown>;

export type DemoClientState =
  | {
      kind: "guest";
      loginUrl: string;
      logoutUrl: string;
      repositoryUrl: string;
    }
  | {
      kind: "authenticated";
      loginUrl: string;
      logoutUrl: string;
      repositoryUrl: string;
      userInfo: DemoUserInfo;
    };

declare global {
  interface Window {
    __CQUT_DEMO_STATE__?: DemoClientState;
  }
}
