// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

function ThemeProbe() {
  const { theme } = useTheme();
  return <span>{theme}</span>;
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
});

describe("ThemeProvider", () => {
  it("starts PowerHub in the high-contrast light theme", () => {
    render(<ThemeProvider defaultTheme="light"><ThemeProbe /></ThemeProvider>);

    expect(screen.getByText("light")).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
