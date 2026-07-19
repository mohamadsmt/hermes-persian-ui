import {cleanup, render, screen} from "@testing-library/react";
import {NextIntlClientProvider} from "next-intl";
import type {ReactNode} from "react";
import {afterEach, describe, expect, it, vi} from "vitest";

import en from "@/messages/en.json";

import {SettingsPanel} from "./settings-panel";

vi.mock("next-themes", () => ({
  useTheme: () => ({setTheme: vi.fn(), theme: "system"}),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({children, href, locale}: {children: ReactNode; href: string; locale?: string}) => (
    <a href={`/${locale ?? "en"}${href}`}>{children}</a>
  ),
}));

afterEach(cleanup);

describe("SettingsPanel", () => {
  it("renders all preference groups inside one sectioned surface", () => {
    const {container} = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SettingsPanel />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("heading", {name: "Appearance"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Interface language"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Mixed-text preview"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Privacy and connection"})).toBeInTheDocument();
    expect(container.querySelectorAll(".product-surface")).toHaveLength(1);
    expect(container.querySelectorAll(".settings-section")).toHaveLength(4);
  });
});
