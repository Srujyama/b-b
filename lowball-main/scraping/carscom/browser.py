"""Shared Playwright browser/context setup for cars.com scraping.

Cars.com sits behind Cloudflare. Plain HTTP (curl/requests) gets a 403,
but a real headless Chromium passes the JS challenge, so every fetch in
this package goes through one shared browser instance.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from playwright.async_api import Browser, BrowserContext, async_playwright

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Cloudflare re-challenges brand-new contexts; keep one context and reuse it.
_PAGE_TIMEOUT_MS = 45_000
_SETTLE_MS = 2_500  # let embedded JSON scripts hydrate after domcontentloaded


@asynccontextmanager
async def browser_context(headless: bool = False):
    """Yield a ready-to-use BrowserContext, cleaned up on exit.

    Defaults to HEADFUL real Chrome: cars.com's Cloudflare passes a headful
    Chrome immediately, but serves headless (even channel=chrome) an empty
    5KB shell that never hydrates. Falls back to bundled Chromium if Google
    Chrome is not installed.
    """
    async with async_playwright() as p:
        launch_kwargs = dict(
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            browser: Browser = await p.chromium.launch(channel="chrome", **launch_kwargs)
        except Exception:
            browser = await p.chromium.launch(**launch_kwargs)
        context: BrowserContext = await browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        # Cloudflare checks navigator.webdriver; Playwright sets it true.
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        try:
            yield context
        finally:
            await context.close()
            await browser.close()


def _is_challenge(html: str) -> bool:
    return "<title>Just a moment...</title>" in html


async def fetch_html(
    context: BrowserContext,
    url: str,
    settle_ms: int = _SETTLE_MS,
    wait_selector: str | None = None,
) -> str:
    """Fetch a fully-hydrated page's HTML in a fresh tab.

    If Cloudflare serves its JS challenge, wait for it to auto-solve and
    the real page to load (up to ~25s) before giving up. Pass wait_selector
    to block until a specific element hydrates (e.g. search result cards).
    """
    page = await context.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=_PAGE_TIMEOUT_MS)
        if wait_selector:
            try:
                await page.wait_for_selector(wait_selector, timeout=20_000)
            except Exception:
                pass  # fall through; caller sees whatever loaded
        else:
            await page.wait_for_timeout(settle_ms)
        html = await page.content()
        for _ in range(10):  # challenge auto-solve wait: 10 x 2.5s
            if not _is_challenge(html):
                break
            await page.wait_for_timeout(2_500)
            html = await page.content()
        return html
    finally:
        await page.close()


async def fetch_many(
    context: BrowserContext,
    urls: list[str],
    concurrency: int = 4,
) -> list[tuple[str, str | None, float]]:
    """Fetch many URLs with bounded concurrency.

    Returns a list of (url, html_or_None, elapsed_seconds) in input order.
    """
    sem = asyncio.Semaphore(concurrency)
    loop = asyncio.get_event_loop()

    async def one(url: str) -> tuple[str, str | None, float]:
        async with sem:
            start = loop.time()
            try:
                html = await fetch_html(context, url)
            except Exception:
                html = None
            return url, html, loop.time() - start

    return list(await asyncio.gather(*(one(u) for u in urls)))
