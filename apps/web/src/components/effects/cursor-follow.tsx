'use client';

import { useEffect } from 'react';

/**
 * Skaly cursor companion — a thin gold ring that smoothly trails the pointer
 * and brightens over interactive elements. Ported from the Claude Design
 * `skaly-cursor-follow.js`. Mounted once in the root layout so every page gets
 * it. Auto-disables on touch / coarse pointers and reduced-motion; idempotent
 * (guarded by `window.__skCursorFollow`), so React StrictMode's double-mount and
 * client navigations never stack a second ring.
 */
export function CursorFollow() {
  useEffect(() => {
    const w = window as typeof window & { __skCursorFollow?: boolean };
    if (w.__skCursorFollow) return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    if (reduce || coarse) return;
    w.__skCursorFollow = true;

    const GOLD = '253,194,87';
    const lerp = (a: number, b: number, n: number) => a + (b - a) * n;

    const css = document.createElement('style');
    css.textContent =
      '#sk-cur{position:fixed;top:0;left:0;z-index:9999;pointer-events:none;' +
      'width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;' +
      `background:radial-gradient(circle,rgba(${GOLD},.55) 0%,rgba(${GOLD},.22) 42%,rgba(${GOLD},0) 70%);` +
      'filter:blur(2px);mix-blend-mode:screen;opacity:0;' +
      'transition:opacity .35s ease,width .22s cubic-bezier(.2,.7,.2,1),' +
      'height .22s cubic-bezier(.2,.7,.2,1),margin .22s cubic-bezier(.2,.7,.2,1);}' +
      '#sk-cur.on{opacity:1;}' +
      `#sk-cur.hot{width:58px;height:58px;margin:-29px 0 0 -29px;` +
      `background:radial-gradient(circle,rgba(${GOLD},.6) 0%,rgba(${GOLD},.24) 46%,rgba(${GOLD},0) 72%);}` +
      '#sk-cur.tap{width:22px;height:22px;margin:-11px 0 0 -11px;}';
    (document.head || document.documentElement).appendChild(css);

    const cur = document.createElement('div');
    cur.id = 'sk-cur';
    cur.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cur);

    let x = innerWidth / 2;
    let y = innerHeight / 2;
    let tx = x;
    let ty = y;
    let raf = 0;
    function tick() {
      x = lerp(x, tx, 0.2);
      y = lerp(y, ty, 0.2);
      cur.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      if (Math.abs(x - tx) > 0.3 || Math.abs(y - ty) > 0.3) raf = requestAnimationFrame(tick);
      else raf = 0;
    }
    const nudge = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const SEL =
      'a,button,input,textarea,select,label,[role=button],[data-sk-cursor-target],[data-sk-glow],[onclick]';

    const onMove = (e: PointerEvent) => {
      if (document.body?.getAttribute('data-sk-cursor') === 'off') {
        cur.classList.remove('on');
        return;
      }
      tx = e.clientX;
      ty = e.clientY;
      nudge();
      if (!cur.classList.contains('on')) cur.classList.add('on');
      const hot = (e.target as Element)?.closest?.(SEL);
      cur.classList.toggle('hot', !!hot);
    };
    const onDown = () => cur.classList.add('tap');
    const onUp = () => cur.classList.remove('tap');
    const hide = () => cur.classList.remove('on', 'hot', 'tap');

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointerleave', hide);
    document.addEventListener('mouseleave', hide);
    window.addEventListener('blur', hide);
  }, []);

  return null;
}
