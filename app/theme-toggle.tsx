"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const value = document.documentElement.dataset.theme;
    if (value === "light" || value === "dark") setTheme(value);
    const sync = (event: StorageEvent) => {
      if (event.key !== "chat-theme" && event.key !== null) return;
      const next = event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system";
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  return (
    <label className="theme-control">
      <span>Motyw</span>
      <select aria-label="Motyw kolorystyczny" value={theme} onChange={(event) => {
        const next = event.target.value as Theme;
        document.documentElement.dataset.theme = next;
        setTheme(next);
        try { localStorage.setItem("chat-theme", next); } catch { /* Motyw działa też bez dostępu do pamięci. */ }
      }}>
        <option value="system">Systemowy</option>
        <option value="light">Jasny</option>
        <option value="dark">Ciemny</option>
      </select>
    </label>
  );
}
