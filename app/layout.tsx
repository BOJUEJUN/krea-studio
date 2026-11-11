import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Studio",
  description: "AI 文生图与图生图 · 多风格模型",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#f5f5f7",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* Pictures come straight from Tencent COS: open the connection while the page script loads. */}
        <link rel="preconnect" href="https://enzoban-studio-1318245308.cos.ap-hongkong.myqcloud.com" />
        <link rel="dns-prefetch" href="https://enzoban-studio-1318245308.cos.ap-hongkong.myqcloud.com" />
      </head>
      <body className="relative z-10">{children}</body>
    </html>
  );
}
