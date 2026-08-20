// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { PowerHubLogo } from "./PowerHubLogo";

const LIGHT_LOGO_SRC = "/manus-storage/powerhub-official-logo_0bcbb9c6.png";
const DARK_LOGO_SRC = "/manus-storage/powerhub-logo-dark-transparent-clean_7dab96ea.png";

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
  localStorage.removeItem("theme");
});

describe("PowerHubLogo", () => {
  it("preloads both theme logo assets while rendering the active theme asset", () => {
    const preloadedSources: string[] = [];

    class ImageMock {
      set src(value: string) {
        preloadedSources.push(value);
      }

      decode() {
        return Promise.resolve();
      }
    }

    vi.stubGlobal("Image", ImageMock);
    render(<ThemeProvider defaultTheme="light"><PowerHubLogo header /></ThemeProvider>);

    expect(screen.getByAltText("PowerHub — منصة إدارة مولدات الكهرباء")).toHaveAttribute("src", LIGHT_LOGO_SRC);
    expect(preloadedSources).toEqual(expect.arrayContaining([LIGHT_LOGO_SRC, DARK_LOGO_SRC]));
  });
});
