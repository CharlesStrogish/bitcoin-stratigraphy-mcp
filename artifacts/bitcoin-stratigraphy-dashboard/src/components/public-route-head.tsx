// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect } from "react";
import { useLocation } from "wouter";
import { ESCROW_APPLICATION } from "@/lib/escrow-seo";

/** Keep crawler-facing URLs and escrow attribution correct after SPA navigation. */
export function PublicRouteHead() {
  const [location] = useLocation();
  useEffect(() => {
    const path = location.split("?")[0]!.replace(/\/$/, "") || "/";
    const publicPaths = ["/", "/standard", "/enterprise", "/whitepaper", "/simulator", "/compliance"];
    if (!publicPaths.includes(path)) return;
    const url = `https://bitcoin-stratigraphy-dashboard.replit.app${path}`;
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", url);
    document.querySelector('meta[property="og:url"]')?.setAttribute("content", url);
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
  return null;
}
