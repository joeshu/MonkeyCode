import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerCtl } from "@/features/chat/composer/useComposer";
import { DesignPreviewWorkbench } from "./DesignPreviewWorkbench";

type EventCb = (event: { payload: unknown }) => void;
let calls: { cmd: string; args?: Record<string, unknown> }[];
let events: Map<string, EventCb>;
let pendingCreates: (() => void)[];
let deferCreates: boolean;

beforeEach(() => {
  calls = []; events = new Map(); pendingCreates = []; deferCreates = false;
  vi.mocked(composer.sendWithFiles).mockReset().mockResolvedValue(true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 400, y: 80, left: 400, top: 80, right: 1000, bottom: 480, width: 600, height: 400, toJSON() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
    core: { invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "preview_create" && deferCreates) await new Promise<void>((resolve) => pendingCreates.push(resolve));
      if (cmd === "preview_serialize") queueMicrotask(() => events.get("preview-serialized")?.({ payload: { requestId: args?.requestId, html: "<html>serialized</html>" } }));
      if (cmd === "preview_capture") queueMicrotask(() => events.get("preview-captured")?.({ payload: { requestId: args?.requestId, dataUrl: "data:image/png;base64,AQID" } }));
      if (cmd === "session_call" && args?.kind === "repo_artifact_read") {
        const path = (args.payload as { path?: string } | undefined)?.path ?? "";
        if (path.endsWith(".png")) return { result: { path, kind: "image", mime: "image/png", data_url: "data:image/png;base64,AQID" } };
        if (path.endsWith(".txt")) return { result: { path, kind: "text", mime: "text/plain", content: "preview text content" } };
        return { result: { path, kind: "html", mime: "text/html", content: `<html>${path}</html>` } };
      }
      if (cmd === "session_call" && args?.kind === "repo_preview_files") return { result: { files: [
        { path: "pages/home.html", kind: "html", mime: "text/html", size: 10 },
        { path: "images/hero.png", kind: "image", mime: "image/png", size: 20 },
        { path: "notes/readme.txt", kind: "text", mime: "text/plain", size: 30 },
      ], truncated: false } };
    } },
    event: { listen: async (name: string, cb: EventCb) => { events.set(name, cb); return () => events.delete(name); } },
  };
});

afterEach(() => { delete (window as unknown as { __TAURI__?: unknown }).__TAURI__; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const composer = { sendWithFiles: vi.fn(async () => true) } as unknown as ComposerCtl;

function mount(obscured = false) {
  return render(<DesignPreviewWorkbench sessionId="s1" initialTarget={{ kind: "localhost", url: "http://localhost:5173/app" }} composer={composer} obscured={obscured} onClose={() => {}} />);
}

describe("DesignPreviewWorkbench native lifecycle", () => {
  it("creates with measured bounds, hides under an obscurer, restores and destroys", async () => {
    const view = mount();
    await waitFor(() => expect(calls.some((c) => c.cmd === "preview_create")).toBe(true));
    expect(calls.find((c) => c.cmd === "preview_create")?.args?.bounds).toEqual({ x: 400, y: 80, width: 600, height: 400 });
    view.rerender(<DesignPreviewWorkbench sessionId="s1" initialTarget={{ kind: "localhost", url: "http://localhost:5173/app" }} composer={composer} obscured onClose={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "preview_hide")).toBe(true));
    view.rerender(<DesignPreviewWorkbench sessionId="s1" initialTarget={{ kind: "localhost", url: "http://localhost:5173/app" }} composer={composer} obscured={false} onClose={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "preview_show")).toBe(true));
    view.unmount();
    expect(calls.some((c) => c.cmd === "preview_destroy")).toBe(true);
  });

  it("does not let the StrictMode cleanup destroy the active preview", async () => {
    deferCreates = true;
    render(<StrictMode><DesignPreviewWorkbench sessionId="s1" initialTarget={{ kind: "localhost", url: "http://localhost:5173/app" }} composer={composer} obscured={false} onClose={() => {}} /></StrictMode>);
    await waitFor(() => expect(calls.filter((c) => c.cmd === "preview_create")).toHaveLength(2));

    await act(async () => {
      pendingCreates.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
    });

    expect(calls.filter((c) => c.cmd === "preview_destroy")).toHaveLength(1);
    expect(calls.at(-1)?.cmd).not.toBe("preview_destroy");
    expect(calls.some((c) => c.cmd === "preview_set_bounds")).toBe(true);
  });

  it("destroys a native preview that finishes creating after switching to an artifact", async () => {
    deferCreates = true;
    mount();
    await waitFor(() => expect(pendingCreates).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "Choose workspace preview file" }));
    await userEvent.click(await screen.findByRole("button", { name: "pages/home.html" }));
    expect(await screen.findByTitle("Preview pages/home.html")).toBeTruthy();
    const destroysBeforeCreateFinishes = calls.filter((call) => call.cmd === "preview_destroy").length;

    await act(async () => {
      pendingCreates.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
    });

    expect(calls.filter((call) => call.cmd === "preview_destroy")).toHaveLength(destroysBeforeCreateFinishes + 1);
    expect(calls.at(-1)?.cmd).toBe("preview_destroy");
  });

  it("switches artifact when initialTarget changes in the same session", async () => {
    const view = render(<DesignPreviewWorkbench sessionId="s1" initialTarget={{ kind: "artifact", path: "pages/first.html", artifactKind: "html" }} composer={composer} obscured={false} onClose={() => {}} />);
    expect(await screen.findByTitle("Preview pages/first.html")).toBeTruthy();
    view.rerender(<DesignPreviewWorkbench sessionId="s1" initialTarget={{ kind: "artifact", path: "pages/second.html", artifactKind: "html" }} composer={composer} obscured={false} onClose={() => {}} />);
    expect(await screen.findByTitle("Preview pages/second.html")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "session_call" && (c.args?.payload as { path?: string })?.path === "pages/second.html")).toBe(true);
  });

  it("renders workspace HTML directly instead of relying on a blob frame URL", async () => {
    render(<DesignPreviewWorkbench sessionId="s1" initialTarget={{ kind: "artifact", path: "pages/home.html", artifactKind: "html" }} composer={composer} obscured={false} onClose={() => {}} />);

    const iframe = await screen.findByTitle("Preview pages/home.html");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toBe("<html>pages/home.html</html>");
    expect(iframe.hasAttribute("src")).toBe(false);
  });

  it("browses, searches and renders HTML, image and text workspace artifacts", async () => {
    mount();

    const choose = async (query: string, path: string) => {
      await userEvent.click(screen.getByRole("button", { name: "Choose workspace preview file" }));
      const search = await screen.findByLabelText("Search preview files");
      await userEvent.clear(search);
      await userEvent.type(search, query);
      await userEvent.click(await screen.findByRole("button", { name: path }));
    };

    await choose("home", "pages/home.html");
    const iframe = await screen.findByTitle("Preview pages/home.html");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toBe("<html>pages/home.html</html>");

    await choose("hero", "images/hero.png");
    expect((await screen.findByRole("img", { name: "images/hero.png" })).getAttribute("src")).toBe("data:image/png;base64,AQID");

    await choose("readme", "notes/readme.txt");
    expect(await screen.findByText("preview text content")).toBeTruthy();
    const readPaths = calls
      .filter((call) => call.cmd === "session_call" && call.args?.kind === "repo_artifact_read")
      .map((call) => (call.args?.payload as { path?: string }).path);
    expect(readPaths).toEqual(["pages/home.html", "images/hero.png", "notes/readme.txt"]);
  });

  it("serializes before editing and saves project-relative HTML through the backend", async () => {
    mount();
    await userEvent.click(screen.getByRole("tab", { name: /Code/ }));
    expect(await screen.findByDisplayValue("<html>serialized</html>")).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("Project-relative HTML path"));
    await userEvent.type(screen.getByLabelText("Project-relative HTML path"), "pages/home.html");
    await userEvent.click(screen.getByRole("button", { name: "Save HTML" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "preview_save_html", args: { sessionId: "s1", path: "pages/home.html", html: "<html>serialized</html>" } }));
  });

  it("uses backend picker apply and undo actions", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /Pick/ }));
    expect(calls.some((c) => c.cmd === "preview_picker_toggle" && c.args?.enabled === true)).toBe(true);
    await waitFor(() => expect(events.has("preview-element-picked")).toBe(true));
    act(() => {
      events.get("preview-element-picked")?.({ payload: { selector: "#hero", text: "Hello", tag: "DIV", bounds: { x: 0, y: 0, width: 10, height: 10 }, styles: {} } });
    });
    expect(await screen.findByText(/DIV · #hero/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("Element value"));
    await userEvent.type(screen.getByLabelText("Element value"), "Updated");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "preview_element_apply" && (c.args?.edit as { value?: string }).value === "Updated")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(calls.some((c) => c.cmd === "preview_element_undo")).toBe(true);
  });

  it("composes the captured PNG before using the guarded composer API", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /Capture/ }));
    expect(await screen.findByRole("img", { name: "Captured preview" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(composer.sendWithFiles).toHaveBeenCalledTimes(1));
    const call = vi.mocked(composer.sendWithFiles).mock.calls[0];
    expect(call).toBeDefined();
    const [text, files] = call!;
    expect(text).toContain("Design preview feedback for http://localhost:5173/app");
    expect(text).toContain("Annotations: 0.");
    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file).toBeDefined();
    expect(file!.type).toBe("image/png");
    expect(file!.size).toBe(3);
    expect(await screen.findByText("Feedback sent through the composer.")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "preview_result_show")).toBe(true);
  });

  it("keeps the capture open and visibly reports a guarded send failure", async () => {
    vi.mocked(composer.sendWithFiles).mockResolvedValueOnce(false);
    mount();
    await userEvent.click(screen.getByRole("button", { name: /Capture/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Send$/ }));
    expect(await screen.findByText(/Feedback was not sent/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Captured preview" })).toBeTruthy();
    expect(calls.some((c) => c.cmd === "preview_result_show")).toBe(false);
  });

  it("uses the same image composer path for the native preview-result send action", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /Capture/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(composer.sendWithFiles).toHaveBeenCalledTimes(1));
    vi.mocked(composer.sendWithFiles).mockClear();
    await waitFor(() => expect(events.has("preview-result-action")).toBe(true));
    act(() => { events.get("preview-result-action")?.({ payload: "send" }); });
    await waitFor(() => expect(composer.sendWithFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(calls.some((c) => c.cmd === "preview_result_hide")).toBe(true));
  });
});
