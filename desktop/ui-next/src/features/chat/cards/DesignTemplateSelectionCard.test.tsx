import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesignTemplateSelectionItem } from "@/lib/protocol/types";
import { createDesignTemplateBlobUrl, DesignTemplateSelectionCard } from "./DesignTemplateSelectionCard";

const ITEM: DesignTemplateSelectionItem = {
  kind: "design-template-selection",
  requestId: "d1",
  title: "Visual direction",
  description: "Pick one",
  items: [
    { id: "clean", title: "Clean", image: "clean.png", recommended: true, reason: "Matches your brief" },
    { id: "live", title: "Live", image: "fallback.png", preview: { type: "html", path: "bundle/index.html" } },
    { id: "bold", title: "Bold", image: "bold.png" },
  ],
  allowedActions: { select: true, next: true, direct: true, cancel: true },
  refinement: { enabled: true },
  state: "open",
};

afterEach(() => vi.restoreAllMocks());

describe("DesignTemplateSelectionCard", () => {
  it("renders recommendation, trusted reason, optional refinement and the three actions", () => {
    render(<DesignTemplateSelectionCard item={ITEM} sessionId="s1" sendFrame={vi.fn()} />);
    expect(screen.getByText("推荐")).toBeTruthy();
    expect(screen.getByText(/Matches your brief/)).toBeTruthy();
    const clean = screen.getByRole("button", { name: /Clean/ });
    expect(clean.className).toContain("flex");
    const choices = clean.parentElement as HTMLElement;
    expect(choices.className).toContain("grid");
    expect(choices.className).toContain("items-start");
    expect(choices.style.gridTemplateColumns).toContain("auto-fit");
    expect(clean.lastElementChild?.className).not.toContain("flex-1");
    expect(clean.querySelector(".aspect-video")).toBeTruthy();
    expect(clean.querySelector("strong")?.className).toContain("line-clamp-2");
    expect(screen.getByText(/Matches your brief/).className).toContain("line-clamp-3");
    const refinement = screen.getByRole("textbox", { name: "补充你的设计条件（可选）" });
    const templatePanel = screen.getByRole("region", { name: "Visual direction" });
    expect(refinement.tagName).toBe("TEXTAREA");
    expect(refinement.className).not.toContain("input-sm");
    expect(templatePanel.contains(refinement)).toBe(true);
    expect(refinement.closest("footer")).toBe(templatePanel.lastElementChild);
    expect(screen.getByRole("button", { name: "选择" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "换一批" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "不使用设计方向" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("confirms the selected design before sending, retries on failure, then becomes terminal", async () => {
    let rejectFirst = true;
    const sender = vi.fn(async () => {
      if (rejectFirst) throw new Error("offline");
    });
    render(<DesignTemplateSelectionCard item={ITEM} sessionId="s1" sendFrame={sender} uploadUrl={async (path) => `data:image/png;base64,${path}`} />);
    await userEvent.click(screen.getByRole("button", { name: /Clean/ }));
    await userEvent.click(screen.getByRole("button", { name: "选择" }));

    expect(sender).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "按这个设计开发" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新选择" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "换一批" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "补充你的设计条件（可选）" })).toBeTruthy();
    expect(screen.getByText("已选择：Clean")).toBeTruthy();
    const selectedImage = await screen.findByRole("img", { name: "Clean" });
    expect(selectedImage.className).toContain("object-contain");
    expect(selectedImage.closest(".aspect-video")).toBeNull();

    const confirm = screen.getByRole("button", { name: "按这个设计开发" });
    await userEvent.click(confirm);
    expect((await screen.findByRole("alert")).textContent).toContain("提交失败，请重试");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    rejectFirst = false;
    await userEvent.click(confirm);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已选择 · Clean"));
    expect(sender).toHaveBeenLastCalledWith("design/selection/respond", { request_id: "d1", action: "select", selected_id: "clean" });
    expect(screen.queryByRole("button", { name: "按这个设计开发" })).toBeNull();
  });

  it("keeps the selected design visible in history", async () => {
    const uploadUrl = vi.fn(async (path: string) => `data:image/png;base64,${path}`);
    render(
      <DesignTemplateSelectionCard
        item={{ ...ITEM, state: "responded", action: "select", selectedId: "clean" }}
        sessionId="s1"
        uploadUrl={uploadUrl}
      />,
    );

    const card = screen.getByRole("region", { name: "Visual direction" });
    expect(screen.getByRole("status").textContent).toContain("已选择 · Clean");
    expect(card.textContent).toContain("Matches your brief");
    const image = await screen.findByRole("img", { name: "Clean" });
    expect(image.className).toContain("h-auto");
    expect(image.className).toContain("object-contain");
    expect(image.closest(".aspect-video")).toBeNull();
    expect(uploadUrl).toHaveBeenCalledWith("clean.png");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sends next with refinement text from the confirmation view", async () => {
    const sender = vi.fn();
    render(<DesignTemplateSelectionCard item={ITEM} sessionId="s1" sendFrame={sender} />);
    await userEvent.click(screen.getByRole("button", { name: /Clean/ }));
    await userEvent.click(screen.getByRole("button", { name: "选择" }));
    await userEvent.type(screen.getByRole("textbox", { name: "补充你的设计条件（可选）" }), "更亮一点");
    await userEvent.click(screen.getByRole("button", { name: "换一批" }));
    await waitFor(() =>
      expect(sender).toHaveBeenCalledWith("design/selection/respond", { request_id: "d1", action: "next", refinement_text: "更亮一点" }),
    );
    expect(screen.getByRole("status").textContent).toContain("已请求换一批");
  });

  it("requires selection again when refreshed candidates invalidate the confirmation", async () => {
    const sender = vi.fn();
    const { rerender } = render(<DesignTemplateSelectionCard item={ITEM} sessionId="s1" sendFrame={sender} />);
    await userEvent.click(screen.getByRole("button", { name: /Clean/ }));
    await userEvent.click(screen.getByRole("button", { name: "选择" }));

    const refreshed = { ...ITEM, items: ITEM.items.filter((candidate) => candidate.id !== "clean") };
    rerender(<DesignTemplateSelectionCard item={refreshed} sessionId="s1" sendFrame={sender} />);
    await userEvent.click(screen.getByRole("button", { name: /Bold/ }));

    expect(screen.getByRole("button", { name: "选择" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "按这个设计开发" })).toBeNull();
    expect(sender).not.toHaveBeenCalled();
  });

  it("renders a cancel fallback when cancel is the only allowed action", async () => {
    const sender = vi.fn();
    render(
      <DesignTemplateSelectionCard
        item={{ ...ITEM, allowedActions: { select: false, next: false, direct: false, cancel: true } }}
        sessionId="s1"
        sendFrame={sender}
      />,
    );
    expect(screen.queryByRole("button", { name: "选择" })).toBeNull();
    expect(screen.queryByRole("button", { name: "换一批" })).toBeNull();
    expect(screen.queryByRole("button", { name: "不使用设计方向" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(sender).toHaveBeenCalledWith("design/selection/respond", { request_id: "d1", action: "cancel" }));
    expect(screen.getByRole("status").textContent).toContain("已取消选择");
  });

  it("renders open cards readonly without actions", () => {
    render(<DesignTemplateSelectionCard item={ITEM} sessionId="child" readonly />);
    expect(screen.getByRole("status").textContent).toContain("未答复");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("prefers reliable thumbnail images when HTML previews are also available", async () => {
    const uploadUrl = vi.fn(async (path: string) => `data:image/png;base64,${path}`);
    const loadHtml = vi.fn(async () => "<main>preview</main>");
    render(
      <DesignTemplateSelectionCard
        item={ITEM}
        sessionId="s1"
        sendFrame={vi.fn()}
        uploadUrl={uploadUrl}
        loadHtml={loadHtml}
      />,
    );
    await waitFor(() => expect(uploadUrl).toHaveBeenCalledTimes(3));
    expect(uploadUrl.mock.calls.map(([path]) => path)).toEqual(["clean.png", "fallback.png", "bold.png"]);
    expect(loadHtml).not.toHaveBeenCalled();
  });

  it("shows an error instead of a blank image preview when reading fails", async () => {
    render(
      <DesignTemplateSelectionCard
        item={{ ...ITEM, items: [ITEM.items[2]!] }}
        sessionId="s1"
        sendFrame={vi.fn()}
        uploadUrl={async () => { throw new Error("missing preview"); }}
      />,
    );
    expect(await screen.findByText("动态预览加载失败")).toBeTruthy();
  });

  it("creates UTF-8 HTML blobs and uses an opaque script sandbox when no thumbnail exists", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { unmount } = render(
      <DesignTemplateSelectionCard
        item={{ ...ITEM, items: [{ ...ITEM.items[1]!, image: undefined }] }}
        sessionId="s1"
        sendFrame={vi.fn()}
        loadHtml={async () => "<script>window.previewRan=true</script>"}
      />,
    );
    await waitFor(() => expect(screen.getByTitle("Live 动态预览")).toBeTruthy());
    const iframe = screen.getByTitle("Live 动态预览");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(create).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/html;charset=utf-8");
    expect(createDesignTemplateBlobUrl("<p>x</p>")).toBe("blob:preview");
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });
});
