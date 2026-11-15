import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";

import { AppShell } from "@/components/app-shell";
import { CommandPalette } from "@/components/command-palette";
import { NavProgress } from "@/components/nav-progress";
import { ProjectProvider } from "@/components/project-context";
import { ShareCardHost } from "@/components/share-card";
import { Tour } from "@/components/tour";
import { themeInitScript } from "@/lib/theme";

import "./globals.css";

const sans = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Kweeto",
  description: "Teach Pixel to recognise your images",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={sans.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen font-sans">
        <NavProgress />
        <ProjectProvider>
          <AppShell>{children}</AppShell>
          <CommandPalette />
          <ShareCardHost />
          <Tour />
        </ProjectProvider>
      </body>
    </html>
  );
}
