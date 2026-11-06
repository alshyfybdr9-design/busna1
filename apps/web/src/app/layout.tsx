import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "باصنا — النقل المدرسي", template: "%s · باصنا" },
  description: "منصة باصنا لإدارة النقل المدرسي: تتبع مباشر، حضور، وإشعارات لأولياء الأمور.",
  manifest: "/manifest.webmanifest",
  applicationName: "باصنا",
};

export const viewport: Viewport = {
  themeColor: "#0E9F6E",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
