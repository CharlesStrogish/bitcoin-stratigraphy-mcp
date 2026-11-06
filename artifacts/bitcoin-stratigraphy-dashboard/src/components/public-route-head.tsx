// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect } from "react";
import { useLocation } from "wouter";
import { ESCROW_APPLICATION } from "@/lib/escrow-seo";
import { pageUrl, siteUrl } from "@/lib/site";
import {
  MANIFESTO_ARTICLE, MANIFESTO_DESCRIPTION, MANIFESTO_TITLE,
} from "@/lib/manifesto-seo";
import {
  SECURITY_ARTICLE, SECURITY_DESCRIPTION, SECURITY_TITLE,
} from "@/lib/security-seo";

/** Keep crawler-facing URLs and escrow attribution correct after SPA navigation. */
export function PublicRouteHead() {
  const [location] = useLocation();
  useEffect(() => {
    const path = location.split("?")[0]!.replace(/\/$/, "") || "/";
    const publicPaths = ["/", "/standard", "/enterprise", "/whitepaper", "/simulator", "/compliance", "/manifesto", "/security"];
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
    const path = location.split("?")[0]!.replace(/\/$/, "");
    if (path !== "/manifesto" && path !== "/security") return;
    const isSecurity = path === "/security";
    const title = isSecurity ? SECURITY_TITLE : MANIFESTO_TITLE;
    const description = isSecurity ? SECURITY_DESCRIPTION : MANIFESTO_DESCRIPTION;
    const article = isSecurity ? SECURITY_ARTICLE : MANIFESTO_ARTICLE;
    const articleId = `${isSecurity ? "security" : "manifesto"}-article-jsonld`;
    const previousTitle = document.title;
    document.title = title;
    const changes = [
      ['meta[name="description"]', description],
      ['meta[property="og:title"]', title],
      ['meta[property="og:description"]', description],
      ['meta[property="og:type"]', "article"],
      ['meta[name="twitter:title"]', title],
      ['meta[name="twitter:description"]', description],
    ].map(([selector, value]) => {
      const element = document.querySelector(selector!);
      const previous = element?.getAttribute("content");
      element?.setAttribute("content", value!);
      return { element, previous };
    });
    const script = document.createElement("script");
    script.id = `${articleId}-client`;
    script.type = "application/ld+json";
    // The initial prerender already contains the same structured data.
    if (!document.getElementById(articleId)) {
      script.textContent = JSON.stringify(article);
      document.head.appendChild(script);
    }
    return () => {
      document.title = previousTitle;
      for (const { element, previous } of changes) {
        if (previous == null) element?.removeAttribute("content");
        else element?.setAttribute("content", previous);
      }
      script.remove();
      document.getElementById(articleId)?.remove();
    };
  }, [location]);
  return null;
}
