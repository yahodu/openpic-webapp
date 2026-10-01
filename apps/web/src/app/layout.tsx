import type { Metadata } from "next";

import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "OpenPic",
  description: "OpenPic web application",
};

/**
 * Root layout for the App Router.
 *
 * @param props - Layout props containing the page content.
 * @returns The HTML document shell.
 */
export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
