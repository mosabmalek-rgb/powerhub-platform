/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { DARK_LOGO_URL, LIGHT_LOGO_URL, PowerHubLogo } from "./PowerHubLogo";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
  localStorage.removeItem("theme");
});

describe("PowerHubLogo", () => {
  it("renders the light-theme brand asset with an accessible label", () => {
    render(<ThemeProvider defaultTheme="light"><PowerHubLogo header /></ThemeProvider>);

    expect(screen.getByLabelText("PowerHub — منصة إدارة مولدات الكهرباء")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("data-logo-theme", "light");
    expect(screen.getByRole("img").querySelector("img")).toHaveAttribute("src", LIGHT_LOGO_URL);
  });

  it("keeps the header logo at a stable minimum size with gradual responsive steps", () => {
    render(<ThemeProvider defaultTheme="light"><PowerHubLogo header /></ThemeProvider>);

    const logo = screen.getByRole("img");
    const image = logo.querySelector("img");
    expect(logo).toHaveClass("shrink-0");
    expect(image).toHaveClass("shrink-0");
    expect(image).toHaveClass("h-[3rem] w-[10rem]");
    expect(image).toHaveClass("sm:h-[3.5rem] sm:w-[11.5rem]");
    expect(image).toHaveClass("xl:h-[4rem] xl:w-[13rem]");
  });

  it("selects the transparent white-wordmark dark-theme asset", () => {
    render(<ThemeProvider defaultTheme="dark"><PowerHubLogo header /></ThemeProvider>);

    const logo = screen.getByRole("img");
    expect(logo).toHaveAttribute("data-logo-theme", "dark");
    expect(logo.querySelector("img")).toHaveAttribute("src", DARK_LOGO_URL);
    expect(document.documentElement).toHaveClass("dark");
  });
});
