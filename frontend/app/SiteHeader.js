"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/papers", label: "论文库" },
  { href: "/ask", label: "智能问答" },
  { href: "/read?paper_id=24", label: "双语阅读", match: "/read" },
  { href: "/graph?paper_id=24", label: "引用图谱", match: "/graph" },
  { href: "/copilot", label: "Copilot" },
];

export default function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a className="site-logo" href="/" onClick={() => setOpen(false)}>
          AI 科研助手
        </a>
        <button
          type="button"
          className="nav-toggle"
          aria-label={open ? "关闭导航菜单" : "打开导航菜单"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span />
          <span />
          <span />
        </button>
        <nav className={open ? "site-nav open" : "site-nav"} aria-label="主导航">
          {NAV_ITEMS.map((item) => {
            const match = item.match || item.href;
            const active = pathname === match || (match !== "/" && pathname.startsWith(`${match}/`));
            return (
              <a
                key={item.label}
                className={active ? "site-nav-link active" : "site-nav-link"}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
