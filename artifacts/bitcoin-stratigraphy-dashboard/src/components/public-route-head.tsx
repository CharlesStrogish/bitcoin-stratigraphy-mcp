// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect } from "react";
import { useLocation } from "wouter";
import { ESCROW_APPLICATION } from "@/lib/escrow-seo";
import { pageUrl, siteUrl } from "@/lib/site";
import {
  MANIFESTO_ARTICLE, MANIFESTO_DESCRIPTION, MANIFESTO_TITLE,
} from "@/lib/manifesto-seo";

/** Keep crawler-facing URLs and escrow attribution correct after SPA navigation. */
export function PublicRouteHead() {
  const [location] = useLocation();
  useEffect(() => {
    const path = location.split("?")[0]!.replace(/\/$/, "") || "/";
    const publicPaths = ["/", "/standard", "/enterprise", "/whitepaper", "/simulator", "/compliance", "/manifesto"];
    if (!publicPaths.includes(path)) return;
    const url = path === "/" ? siteUrl("/") : pageUrl(path);
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", url);
    document.querySelector('meta[property="og:url"]')?.setAttribute("content", url);
    document.querySelector('meta[name="twitter:url"]')?.setAttribute("content", url);
    let script = document.getElementById("escrow-application-jsonld");
    if (!script) {
      script = document.createElement("script");
      script.id = "escrow-application-jsonld";
      script.setAttribute("type", "application/ld+json");
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify({
      "@context": "https://schema.org",
      ...ESCROW_APPLICATION,
    });
  }, [location]);
  useEffect(() => {
    if (location.split("?")[0]!.replace(/\/$/, "") !== "/manifesto") return;
    const previousTitle = document.title;
    document.title = MANIFESTO_TITLE;
    const changes = [
      ['meta[name="description"]', MANIFESTO_DESCRIPTION],
      ['meta[property="og:title"]', MANIFESTO_TITLE],
      ['meta[property="og:description"]', MANIFESTO_DESCRIPTION],
      ['meta[property="og:type"]', "article"],
      ['meta[name="twitter:title"]', MANIFESTO_TITLE],
      ['meta[name="twitter:description"]', MANIFESTO_DESCRIPTION],
    ].map(([selector, value]) => {
      const element = document.querySelector(selector!);
      const previous = element?.getAttribute("content");
      element?.setAttribute("content", value!);
      return { element, previous };
    });
    const script = document.createElement("script");
    script.id = "manifesto-article-jsonld-client";
    script.type = "application/ld+json";
    // The initial prerender already contains the same structured data.
    if (!document.getElementById("manifesto-article-jsonld")) {
      script.textContent = JSON.stringify(MANIFESTO_ARTICLE);
      document.head.appendChild(script);
    }
    return () => {
      document.title = previousTitle;
      for (const { element, previous } of changes) {
        if (previous == null) element?.removeAttribute("content");
        else element?.setAttribute("content", previous);
      }
      script.remove();
      document.getElementById("manifesto-article-jsonld")?.remove();
    };
  }, [location]);
  return null;
}
