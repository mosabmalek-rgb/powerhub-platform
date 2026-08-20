// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeSelector } from "@/components/ThemeSelector";
import { ThemeProvider, useTheme } from "./ThemeContext";

function ThemeProbe() {
  const { theme } = useTheme();
  return <span>{theme}</span>;
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
  localStorage.removeItem("theme");
});

describe("ThemeProvider", () => {
  it("starts PowerHub in the high-contrast light theme", () => {
    render(<ThemeProvider defaultTheme="light"><ThemeProbe /></ThemeProvider>);

    expect(screen.getByText("light")).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("switches to dark mode through the explicit selector and saves the preference", () => {
    render(<ThemeProvider defaultTheme="light" switchable><ThemeProbe /><ThemeSelector /></ThemeProvider>);

    fireEvent.click(screen.getByRole("button", { name: "اختيار الثيم الداكن" }));

    expect(screen.getByText("dark")).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});
