// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { PowerHubLogo } from "./PowerHubLogo";

const LIGHT_LOGO_SRC = "/manus-storage/powerhub-official-logo_0bcbb9c6.png";
const DARK_LOGO_SRC = "/manus-storage/powerhub-logo-dark-transparent-clean_7dab96ea.png";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
  localStorage.removeItem("theme");
});

describe("PowerHubLogo", () => {
  it("keeps both logo assets mounted and reveals the current theme asset without swapping sources", () => {
    const { container } = render(<ThemeProvider defaultTheme="light"><PowerHubLogo header /></ThemeProvider>);
    const [lightLogo, darkLogo] = Array.from(container.querySelectorAll("img"));

    expect(screen.getByAltText("PowerHub — منصة إدارة مولدات الكهرباء")).toHaveAttribute("src", LIGHT_LOGO_SRC);
    expect(lightLogo).toHaveAttribute("src", LIGHT_LOGO_SRC);
    expect(darkLogo).toHaveAttribute("src", DARK_LOGO_SRC);
    expect(lightLogo).not.toHaveClass("opacity-0");
    expect(darkLogo).toHaveClass("opacity-0");
  });

  it("reveals the already mounted dark asset in dark mode", () => {
    const { container } = render(<ThemeProvider defaultTheme="dark"><PowerHubLogo header /></ThemeProvider>);
    const [lightLogo, darkLogo] = Array.from(container.querySelectorAll("img"));

    expect(lightLogo).toHaveClass("opacity-0");
    expect(darkLogo).toHaveClass("opacity-100");
  });
});
