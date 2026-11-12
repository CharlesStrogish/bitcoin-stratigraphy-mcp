import React from "react";

export interface BlogPost {
  title: string;
  date: string;
  description: string;
  slug: string;
  html: string;
}

function formatDate(date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
}

export default function BlogContent({
  posts,
  post,
  base = "/",
}: {
  posts: BlogPost[];
  post?: BlogPost;
  base?: string;
}) {
  const BASE = base.endsWith("/") ? base : `${base}/`;
  const nav: [string, string, string, boolean][] = [
    ["dashboard", "Dashboard", BASE, false],
    ["developers", "Developers", `${BASE}developers`, false],
    ["blog", "Blog", `${BASE}blog/`, !post],
  ];
  return (
    <div className="blog-shell">
      <a className="blog-skip" href="#blog-main">
        Skip to content
      </a>
      <header className="blog-top">
        <a className="blog-brand" href={BASE} data-testid="link-blog-brand">
          Bitcoin <em>Stratigraphy</em>
        </a>
        <nav className="blog-nav" aria-label="Primary">
          {nav.map(([id, label, href, current]) => (
            <a
              key={id}
              href={href}
              className={`blog-nav-link${current || (id === "blog" && post) ? " is-section" : ""}`}
              aria-current={current ? "page" : undefined}
              data-testid={`link-blog-nav-${id}`}
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <main id="blog-main" className="blog-main">
        {post ? (
          <article
            className="blog-article"
            data-testid={`article-${post.slug}`}
          >
            <a
              className="blog-back"
              href={`${BASE}blog/`}
              data-testid="link-blog-back"
            >
              <span aria-hidden="true">&larr;</span> All field notes
            </a>
            <header className="blog-article-head">
              <p className="blog-kicker">
                <span className="blog-rule" aria-hidden="true" /> Engineering
                log
                <span className="blog-dot" aria-hidden="true">
                  /
                </span>
                <time dateTime={post.date} data-testid="text-post-date">
                  {formatDate(post.date)}
                </time>
              </p>
              <h1 className="blog-title" data-testid="text-post-title">
                {post.title}
              </h1>
              {post.description ? (
                <p className="blog-lede">{post.description}</p>
              ) : null}
            </header>
            <div
              className="blog-prose"
              data-testid="content-post-body"
              dangerouslySetInnerHTML={{ __html: post.html }}
            />
            <footer className="blog-article-foot">
              <a
                className="blog-btn"
                href={`${BASE}blog/`}
                data-testid="link-blog-index-bottom"
              >
                Back to the blog
              </a>
              <a
                className="blog-btn blog-btn-quiet"
                href={`${BASE}developers`}
                data-testid="link-blog-developers-bottom"
              >
                Developer access
              </a>
            </footer>
          </article>
        ) : (
          <>
            <header className="blog-index-head">
              <p className="blog-kicker">
                <span className="blog-rule" aria-hidden="true" /> ENTERPRISE AI COMPLIANCE
              </p>
              <h1 className="blog-title">
                The Zero-Knowledge <span>Log</span>
              </h1>
              <p className="blog-count" data-testid="text-post-count">
                {posts.length} {posts.length === 1 ? "entry" : "entries"}
              </p>
            </header>
            {posts.length === 0 ? (
              <section className="blog-empty" aria-labelledby="blog-empty-h">
                <h2 id="blog-empty-h">No entries published yet</h2>
                <p>
                  Check back soon, or explore the{" "}
                  <a href={`${BASE}developers`}>developer documentation</a>.
                </p>
              </section>
            ) : (
              <ol className="blog-list" aria-label="Posts by date">
                {posts.map((p, i) => (
                  <li key={p.slug}>
                    <article
                      className="blog-card"
                      data-testid={`card-post-${p.slug}`}
                    >
                      <div className="blog-card-meta">
                        <span className="blog-layer" aria-hidden="true">
                          L{String(posts.length - i).padStart(2, "0")}
                        </span>
                        <time dateTime={p.date}>{formatDate(p.date)}</time>
                      </div>
                      <div className="blog-card-body">
                        <h2>
                          <a
                            href={`${BASE}blog/${p.slug}/`}
                            className="blog-card-link"
                            data-testid={`link-post-${p.slug}`}
                          >
                            {p.title}
                          </a>
                        </h2>
                        {p.description ? <p>{p.description}</p> : null}
                        <span className="blog-read" aria-hidden="true">
                          Read entry <span>&rarr;</span>
                        </span>
                      </div>
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </main>
      <footer className="blog-foot">
        <a href={BASE}>Bitcoin Stratigraphy</a>
        <a href={`${BASE}blog/`}>Blog index</a>
      </footer>
    </div>
  );
}
