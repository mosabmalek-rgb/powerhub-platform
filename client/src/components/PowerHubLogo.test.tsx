// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { PowerHubLogo } from "./PowerHubLogo";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.innerHTML = "";
  localStorage.removeItem("theme");
});

describe("PowerHubLogo", () => {
  it("renders a self-contained accessible brand without a Manus storage image", () => {
    const { container } = render(<ThemeProvider defaultTheme="light"><PowerHubLogo header /></ThemeProvider>);

    expect(screen.getByLabelText("PowerHub — منصة إدارة مولدات الكهرباء")).toBeInTheDocument();
    expect(screen.getByText("Power")).toBeInTheDocument();
    expect(screen.getByText("Hub")).toBeInTheDocument();
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("keeps the mark readable in dark mode", () => {
    render(<ThemeProvider defaultTheme="dark"><PowerHubLogo header /></ThemeProvider>);

    expect(screen.getByLabelText("PowerHub — منصة إدارة مولدات الكهرباء")).toHaveClass("text-foreground");
  });
});
