import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '点点工作台｜自媒体内容策划', description: '从选题判断到发布设计的小红书内容工作台。' };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
