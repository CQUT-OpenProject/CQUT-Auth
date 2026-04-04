import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DemoClientState, DemoUserInfo } from "./types.js";

type DemoAppProps = {
  initialState: DemoClientState;
};

type IconKind = "folder" | "document" | "id" | "key" | "arrow" | "logout";

function icon(kind: IconKind) {
  switch (kind) {
    case "folder":
      return (
        <svg className="icon-svg" viewBox="0 0 92 84" aria-hidden="true">
          <path d="M14 28h18l6-8h14l6 8h20v34H14z" fill="#fff" stroke="#111" strokeWidth="2.5" />
          <path d="M14 31h64" stroke="#111" strokeWidth="2.5" />
          <path d="M20 40h52" stroke="#111" strokeWidth="2.5" strokeDasharray="4 3" />
        </svg>
      );
    case "document":
      return (
        <svg className="icon-svg" viewBox="0 0 92 84" aria-hidden="true">
          <path d="M24 14h34l12 12v44H24z" fill="#fff" stroke="#111" strokeWidth="2.5" />
          <path d="M58 14v13h12" fill="none" stroke="#111" strokeWidth="2.5" />
          <path d="M32 38h28M32 48h28M32 58h20" stroke="#111" strokeWidth="2.5" />
        </svg>
      );
    case "id":
      return (
        <svg className="icon-svg" viewBox="0 0 92 84" aria-hidden="true">
          <rect x="16" y="20" width="60" height="40" fill="#fff" stroke="#111" strokeWidth="2.5" />
          <circle cx="33" cy="40" r="8" fill="none" stroke="#111" strokeWidth="2.5" />
          <path d="M25 53c4-6 12-9 18-9s14 3 18 9" fill="none" stroke="#111" strokeWidth="2.5" />
          <path d="M48 34h18M48 42h18" stroke="#111" strokeWidth="2.5" />
        </svg>
      );
    case "key":
      return (
        <svg className="icon-svg" viewBox="0 0 92 84" aria-hidden="true">
          <circle cx="32" cy="42" r="13" fill="#fff" stroke="#111" strokeWidth="2.5" />
          <path d="M44 42h26l6 6-6 6-5-5-4 4-4-4-4 4-5-5" fill="none" stroke="#111" strokeWidth="2.5" />
        </svg>
      );
    case "arrow":
      return (
        <svg className="icon-svg" viewBox="0 0 92 84" aria-hidden="true">
          <rect x="18" y="16" width="56" height="48" fill="#fff" stroke="#111" strokeWidth="2.5" />
          <path d="M28 42h24M46 28l14 14-14 14" fill="none" stroke="#111" strokeWidth="4" />
        </svg>
      );
    case "logout":
      return (
        <svg className="icon-svg" viewBox="0 0 92 84" aria-hidden="true">
          <rect x="18" y="14" width="34" height="52" fill="#fff" stroke="#111" strokeWidth="2.5" />
          <path d="M44 42h20M54 30l12 12-12 12" fill="none" stroke="#111" strokeWidth="4" />
        </svg>
      );
  }
}

function IconTile(props: {
  kind: IconKind;
  title: string;
  detail: React.ReactNode;
  href?: string;
}) {
  const body = (
    <>
      {icon(props.kind)}
      <span className="icon-label">
        <strong>{props.title}</strong>
        {props.detail}
      </span>
    </>
  );

  if (props.href) {
    return (
      <a className="icon-tile" href={props.href}>
        {body}
      </a>
    );
  }

  return <div className="icon-tile is-static">{body}</div>;
}

function CustomScrollWindow(props: { children: React.ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const verticalTrackRef = useRef<HTMLDivElement>(null);
  const horizontalTrackRef = useRef<HTMLDivElement>(null);
  const [vertical, setVertical] = useState({ offset: 0, thumb: 40, visible: false });
  const [horizontal, setHorizontal] = useState({ offset: 0, thumb: 40, visible: false });
  const dragRef = useRef<
    | { axis: "vertical"; startPointer: number; startOffset: number }
    | { axis: "horizontal"; startPointer: number; startOffset: number }
    | null
  >(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const verticalTrack = verticalTrackRef.current;
    const horizontalTrack = horizontalTrackRef.current;
    if (!viewport || !verticalTrack || !horizontalTrack) {
      return;
    }

    const update = () => {
      const clientHeight = viewport.clientHeight;
      const scrollHeight = viewport.scrollHeight;
      const verticalTrackHeight = verticalTrack.clientHeight;
      if (scrollHeight <= clientHeight || verticalTrackHeight <= 0) {
        setVertical({ offset: 0, thumb: Math.max(36, verticalTrackHeight), visible: false });
      } else {
        const thumb = Math.max(36, (clientHeight / scrollHeight) * verticalTrackHeight);
        const offset =
          (viewport.scrollTop / (scrollHeight - clientHeight)) * (verticalTrackHeight - thumb);
        setVertical({ offset, thumb, visible: true });
      }

      const clientWidth = viewport.clientWidth;
      const scrollWidth = viewport.scrollWidth;
      const horizontalTrackWidth = horizontalTrack.clientWidth;
      if (scrollWidth <= clientWidth || horizontalTrackWidth <= 0) {
        setHorizontal({ offset: 0, thumb: Math.max(36, horizontalTrackWidth), visible: false });
      } else {
        const thumb = Math.max(36, (clientWidth / scrollWidth) * horizontalTrackWidth);
        const offset =
          (viewport.scrollLeft / (scrollWidth - clientWidth)) * (horizontalTrackWidth - thumb);
        setHorizontal({ offset, thumb, visible: true });
      }
    };

    update();
    viewport.addEventListener("scroll", update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(viewport);
    resizeObserver.observe(verticalTrack);
    resizeObserver.observe(horizontalTrack);
    return () => {
      viewport.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const viewport = viewportRef.current;
      const drag = dragRef.current;
      if (!viewport || !drag) {
        return;
      }

      if (drag.axis === "vertical") {
        const track = verticalTrackRef.current;
        if (!track) {
          return;
        }
        const maxThumbOffset = Math.max(0, track.clientHeight - vertical.thumb);
        const nextOffset = Math.min(
          maxThumbOffset,
          Math.max(0, drag.startOffset + event.clientY - drag.startPointer)
        );
        const ratio = maxThumbOffset === 0 ? 0 : nextOffset / maxThumbOffset;
        viewport.scrollTop = ratio * (viewport.scrollHeight - viewport.clientHeight);
        return;
      }

      const track = horizontalTrackRef.current;
      if (!track) {
        return;
      }
      const maxThumbOffset = Math.max(0, track.clientWidth - horizontal.thumb);
      const nextOffset = Math.min(
        maxThumbOffset,
        Math.max(0, drag.startOffset + event.clientX - drag.startPointer)
      );
      const ratio = maxThumbOffset === 0 ? 0 : nextOffset / maxThumbOffset;
      viewport.scrollLeft = ratio * (viewport.scrollWidth - viewport.clientWidth);
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [horizontal.thumb, vertical.thumb]);

  const scrollByAmount = (axis: "vertical" | "horizontal", delta: number) => {
    viewportRef.current?.scrollBy(
      axis === "vertical" ? { top: delta, behavior: "smooth" } : { left: delta, behavior: "smooth" }
    );
  };

  const onVerticalTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const track = verticalTrackRef.current;
    const viewport = viewportRef.current;
    if (!track || !viewport) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const thumbCenter = vertical.thumb / 2;
    const nextTop = Math.min(rect.height - vertical.thumb, Math.max(0, offsetY - thumbCenter));
    const ratio = rect.height <= vertical.thumb ? 0 : nextTop / (rect.height - vertical.thumb);
    viewport.scrollTop = ratio * (viewport.scrollHeight - viewport.clientHeight);
  };

  const onHorizontalTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const track = horizontalTrackRef.current;
    const viewport = viewportRef.current;
    if (!track || !viewport) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const thumbCenter = horizontal.thumb / 2;
    const nextLeft = Math.min(rect.width - horizontal.thumb, Math.max(0, offsetX - thumbCenter));
    const ratio = rect.width <= horizontal.thumb ? 0 : nextLeft / (rect.width - horizontal.thumb);
    viewport.scrollLeft = ratio * (viewport.scrollWidth - viewport.clientWidth);
  };

  return (
    <div className="window-shell">
      <section className="window-content">
        <div ref={viewportRef} className="window-scroll-viewport">
          <div className="window-scroll-inner">{props.children}</div>
        </div>
      </section>
      <aside className="window-scrollbar" aria-label="window scrollbar">
        <button
          className="scroll-button up"
          type="button"
          onClick={() => scrollByAmount("vertical", -120)}
          aria-label="Scroll up"
        />
        <div ref={verticalTrackRef} className="scroll-track vertical" onPointerDown={onVerticalTrackPointerDown}>
          {vertical.visible ? (
            <button
              type="button"
              className="scroll-thumb vertical"
              style={{ height: `${vertical.thumb}px`, transform: `translateY(${vertical.offset}px)` }}
              onPointerDown={(event: React.PointerEvent<HTMLButtonElement>) => {
                dragRef.current = { axis: "vertical", startPointer: event.clientY, startOffset: vertical.offset };
                event.stopPropagation();
              }}
              aria-label="Scroll thumb"
            />
          ) : (
            <div className="scroll-thumb vertical is-disabled" style={{ height: "100%", transform: "translateY(0)" }} />
          )}
        </div>
        <button
          className="scroll-button down"
          type="button"
          onClick={() => scrollByAmount("vertical", 120)}
          aria-label="Scroll down"
        />
      </aside>
      <div className="window-horizontal-scrollbar" aria-label="window horizontal scrollbar">
        <button
          className="scroll-button left"
          type="button"
          onClick={() => scrollByAmount("horizontal", -120)}
          aria-label="Scroll left"
        />
        <div
          ref={horizontalTrackRef}
          className="scroll-track horizontal"
          onPointerDown={onHorizontalTrackPointerDown}
        >
          {horizontal.visible ? (
            <button
              type="button"
              className="scroll-thumb horizontal"
              style={{ width: `${horizontal.thumb}px`, transform: `translateX(${horizontal.offset}px)` }}
              onPointerDown={(event: React.PointerEvent<HTMLButtonElement>) => {
                dragRef.current = {
                  axis: "horizontal",
                  startPointer: event.clientX,
                  startOffset: horizontal.offset
                };
                event.stopPropagation();
              }}
              aria-label="Horizontal scroll thumb"
            />
          ) : (
            <div className="scroll-thumb horizontal is-disabled" style={{ width: "100%", transform: "translateX(0)" }} />
          )}
        </div>
        <button
          className="scroll-button right"
          type="button"
          onClick={() => scrollByAmount("horizontal", 120)}
          aria-label="Scroll right"
        />
      </div>
      <div className="window-scroll-corner" aria-hidden="true" />
    </div>
  );
}

function SessionGrid({ userInfo }: { userInfo: DemoUserInfo }) {
  const rows = [
    ["sub", typeof userInfo["sub"] === "string" ? userInfo["sub"] : "-"],
    [
      "preferred_username",
      typeof userInfo["preferred_username"] === "string" ? userInfo["preferred_username"] : "-"
    ],
    ["name", typeof userInfo["name"] === "string" ? userInfo["name"] : "-"],
    ["email", typeof userInfo["email"] === "string" ? userInfo["email"] : "-"],
    [
      "student_status",
      typeof userInfo["student_status"] === "string" ? userInfo["student_status"] : "-"
    ],
    ["school", typeof userInfo["school"] === "string" ? userInfo["school"] : "-"]
  ];

  return (
    <dl className="info-grid">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function GuestContent({ state }: { state: Extract<DemoClientState, { kind: "guest" }> }) {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h2>Sign In With CQUT</h2>
        </div>
        <span className="capsule">guest</span>
      </section>
      <div className="workspace-grid">
        <div className="icon-grid">
          <IconTile kind="arrow" title="Start Login" detail={<><code>/demo/login</code> redirects to CQUT OIDC OP.</>} href={state.loginUrl} />
          <IconTile kind="folder" title="Provider" detail={<>Handles consent and upstream session.</>} />
          <IconTile kind="key" title="Credential Boundary" detail={<>Campus password is never entered on this site.</>} />
          <IconTile kind="document" title="Flow" detail={<>Code + PKCE, token exchange, UserInfo fetch, local session.</>} />
        </div>
        <aside className="side-panel">
          <div className="panel-header plain">Notes</div>
          <div className="panel-body">
            <p>Page is fixed. Scroll only inside this window.</p>
            <div className="button-row">
              <a className="button" href={state.loginUrl}>Sign in</a>
            </div>
            <dl className="info-grid">
              <dt>mode</dt>
              <dd>OIDC RP</dd>
              <dt>stack</dt>
              <dd>React + esbuild</dd>
              <dt>window</dt>
              <dd>fixed viewport, internal scroll only</dd>
              <dt>repo</dt>
              <dd>CQUT Auth demo-site</dd>
            </dl>
          </div>
        </aside>
      </div>
    </>
  );
}

function AuthenticatedContent({ state }: { state: Extract<DemoClientState, { kind: "authenticated" }> }) {
  const userName = typeof state.userInfo["name"] === "string" ? state.userInfo["name"] : "CQUT User";
  const rawJson = useMemo(() => JSON.stringify(state.userInfo, null, 2), [state.userInfo]);

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h2>Signed In</h2>
          <p>Session is active. Data below comes from UserInfo.</p>
        </div>
        <span className="capsule">signed-in</span>
      </section>
      <div className="workspace-grid">
        <div className="icon-grid">
          <IconTile kind="id" title={userName} detail={<>Profile loaded from UserInfo endpoint.</>} />
          <IconTile kind="document" title="Claims" detail={<>Contains <code>student_status</code>, <code>school</code>, and profile fields.</>} />
          <IconTile kind="folder" title="Session" detail={<>Stored in local RP session cookie.</>} />
          <IconTile kind="logout" title="Sign out" detail={<>Clear local session and call provider logout.</>} href={state.logoutUrl} />
        </div>
        <aside className="side-panel">
          <div className="panel-header">Session</div>
          <div className="panel-body">
            <div className="button-row">
              <a className="button secondary" href={state.logoutUrl}>Sign out</a>
            </div>
            <SessionGrid userInfo={state.userInfo} />
          </div>
        </aside>
      </div>
      <section className="data-card">
        <div className="panel-header">UserInfo JSON</div>
        <pre>{rawJson}</pre>
      </section>
    </>
  );
}

export function DemoApp({ initialState }: DemoAppProps) {
  return (
    <div className="desktop-page">
      <header className="menubar" aria-label="Classic menu bar">
        <div className="menubar-group">
          <span className="menu-mark" aria-hidden="true" />
          <span>CQUT Auth</span>
          <a className="menubar-link" href={initialState.repositoryUrl} target="_blank" rel="noreferrer">
            Repo
          </a>
        </div>
        <div className="menubar-group">
          <span>© 2026 CQUT OpenSourceProject</span>
        </div>
      </header>

      <main className="desktop-window">
        <header className="window-header">
          <div className="window-corner" aria-hidden="true">
            <span className="corner-box" />
          </div>
          <div className="window-rule" aria-hidden="true" />
          <h1 className="window-title">OIDC Demo</h1>
          <div className="window-rule" aria-hidden="true" />
          <div className="window-corner right" aria-hidden="true">
            <span className="corner-box" />
          </div>
        </header>

        <CustomScrollWindow>
          {initialState.kind === "authenticated" ? <AuthenticatedContent state={initialState} /> : <GuestContent state={initialState} />}
        </CustomScrollWindow>
      </main>
    </div>
  );
}
