import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mój chatbot",
  description: "Mój pierwszy chatbot na kursie LABA.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('chat-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
