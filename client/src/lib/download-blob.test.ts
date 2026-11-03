import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./download-blob";

function installDownloadEnvironment() {
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const documentMock = {
    createElement: vi.fn(() => anchor),
    body: { appendChild: vi.fn() },
  };
  let cleanup: (() => void) | undefined;
  const setTimeout = vi.fn((callback: () => void, delay: number) => {
    expect(delay).toBe(1_000);
    cleanup = callback;
    return 1;
  });

  vi.stubGlobal("document", documentMock as unknown as Document);
  vi.stubGlobal("window", { setTimeout } as unknown as Window);
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:powerhub-download");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

  return { anchor, documentMock, setTimeout, cleanup: () => cleanup, createObjectURL, revokeObjectURL };
}

describe("downloadBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clicks and removes the anchor while keeping the Blob URL alive for browser handoff", () => {
    const env = installDownloadEnvironment();
    const blob = new Blob(["report"]);

    downloadBlob(blob, "powerhub-report.xlsx");

    expect(env.createObjectURL).toHaveBeenCalledWith(blob);
    expect(env.documentMock.createElement).toHaveBeenCalledWith("a");
    expect(env.documentMock.body.appendChild).toHaveBeenCalledWith(env.anchor);
    expect(env.anchor.href).toBe("blob:powerhub-download");
    expect(env.anchor.download).toBe("powerhub-report.xlsx");
    expect(env.anchor.style.display).toBe("none");
    expect(env.anchor.click).toHaveBeenCalledOnce();
    expect(env.anchor.remove).toHaveBeenCalledOnce();
    expect(env.setTimeout).toHaveBeenCalledOnce();
    expect(env.revokeObjectURL).not.toHaveBeenCalled();

    env.cleanup()?.();
    expect(env.revokeObjectURL).toHaveBeenCalledWith("blob:powerhub-download");
  });

  it("still schedules Blob URL cleanup if the browser click throws", () => {
    const env = installDownloadEnvironment();
    env.anchor.click.mockImplementation(() => {
      throw new Error("download unavailable");
    });

    expect(() => downloadBlob(new Blob(["report"]), "powerhub-report.csv")).toThrow("download unavailable");
    expect(env.anchor.remove).toHaveBeenCalledOnce();
    expect(env.setTimeout).toHaveBeenCalledOnce();
    expect(env.revokeObjectURL).not.toHaveBeenCalled();

    env.cleanup()?.();
    expect(env.revokeObjectURL).toHaveBeenCalledWith("blob:powerhub-download");
  });
});
